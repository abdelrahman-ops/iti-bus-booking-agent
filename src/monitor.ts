import { config } from "./config.js";
import { cairoDateAtOffset, getNextCairoTargetTime, isCairoTimePast, formatCairoDateTime } from "./dates.js";
import { ItiClient, NetworkTimeoutError } from "./api/iti-client.js";
import { BookingEngine } from "./booking/booking-engine.js";
import { BookingRepository } from "./storage/booking-repository.js";
import { Notifier } from "./notifications/notifier.js";
import {
  evaluateTrip,
  safeTripDiagnostic,
  type NormalizedTrip
} from "./matching/trip-matcher.js";
import { log } from "./log.js";

export class AvailabilityMonitor {
  private stopped = false;
  private isCycleRunning = false;
  private sleepResolver: (() => void) | null = null;
  private readonly notifiedTrips = new Set<string>();

  constructor(
    private readonly client: ItiClient,
    private readonly bookingEngine: BookingEngine,
    private readonly repository: BookingRepository,
    private readonly notifier: Notifier
  ) {}

  stop(): void {
    this.stopped = true;
    if (this.sleepResolver) {
      this.sleepResolver();
      this.sleepResolver = null;
    }
  }

  private async sleep(ms: number): Promise<void> {
    if (this.stopped || ms <= 0) return;
    return new Promise<void>((resolve) => {
      this.sleepResolver = resolve;
      const timer = setTimeout(() => {
        this.sleepResolver = null;
        resolve();
      }, ms);

      // If stopped while sleeping, clear timer
      const originalResolver = this.sleepResolver;
      this.sleepResolver = () => {
        clearTimeout(timer);
        originalResolver();
      };
    });
  }

  private async waitForScheduledStart(): Promise<void> {
    if (!config.waitForSchedule) {
      log.info("WAIT_FOR_SCHEDULE is disabled. Monitoring starts immediately.");
      return;
    }

    const isPast = isCairoTimePast(config.dailyStartTime);
    if (isPast) {
      log.info(
        `Current Cairo time is already past scheduled daily start time (${config.dailyStartTime}). Starting monitoring immediately.`,
        { cairoTime: formatCairoDateTime() }
      );
      return;
    }

    const { targetDate, msUntil } = getNextCairoTargetTime(config.dailyStartTime);
    const minutesUntil = (msUntil / 60_000).toFixed(1);
    log.info(
      `Waiting for scheduled Cairo start time: ${config.dailyStartTime} (${minutesUntil} minutes away)...`,
      {
        targetCairoTime: formatCairoDateTime(targetDate),
        cairoTimeNow: formatCairoDateTime()
      }
    );

    // Sleep until target time
    await this.sleep(msUntil);
  }

  async run(): Promise<void> {
    log.info("Availability monitor initialized.", {
      dailyStartTime: config.dailyStartTime,
      intervalMs: config.pollIntervalMs,
      dateOffsets: config.dateOffsets,
      routeKeyword: config.routeKeyword,
      pickupKeyword: config.pickupKeyword,
      direction: config.direction,
      bookingEnabled: config.bookingEnabled,
      waitForSchedule: config.waitForSchedule
    });

    await this.waitForScheduledStart();
    if (this.stopped) return;

    await this.notifier.notifyMonitoringStarted({
      dailyStartTime: config.dailyStartTime,
      pollIntervalMs: config.pollIntervalMs,
      dateOffsets: config.dateOffsets,
      bookingEnabled: config.bookingEnabled
    });

    // Synchronize known active bookings from ITI remote history
    await this.syncRemoteBookings();

    log.info("Entering active monitoring loop.");

    while (!this.stopped) {
      if (this.isCycleRunning) {
        log.warn("Previous monitoring cycle still active. Skipping overlapping run.");
        await this.sleep(1000);
        continue;
      }

      this.isCycleRunning = true;
      const startedAt = Date.now();

      try {
        await this.runSingleCycle();
      } catch (error) {
        log.error("Unexpected error in monitoring cycle.", {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.isCycleRunning = false;
      }

      const elapsed = Date.now() - startedAt;
      const waitMs = Math.max(1000, config.pollIntervalMs - elapsed);
      if (!this.stopped) {
        await this.sleep(waitMs);
      }
    }

    log.info("Availability monitor stopped cleanly.");
  }

  private async syncRemoteBookings(): Promise<void> {
    try {
      const bookings = await this.client.getUserBookings();
      log.info(`Synchronized ${bookings.length} remote booking records from ITI history.`);
      for (const b of bookings) {
        if (b.status === "CONFIRMED") {
          const existing = this.repository.getLatestAttemptForTrip(b.tripId, b.tripDate);
          if (!existing) {
            const attemptId = this.repository.createPendingAttempt({
              tripId: b.tripId,
              pickupStopId: 0,
              tripDate: b.tripDate,
              routeName: b.routeName,
              pickupStopName: b.pickupLocation || b.pickupStopName || "",
              direction: b.isReturnTrip ? "return" : "outbound"
            });
            this.repository.markConfirmed(attemptId, b.bookingCode, b.id, b);
            log.info(`Imported confirmed remote booking #${b.bookingCode} for trip ${b.tripId} (${b.tripDate}).`);
          } else if (existing.status !== "CONFIRMED") {
            this.repository.markConfirmed(existing.id, b.bookingCode, b.id, b);
          }
        }
      }
    } catch (err) {
      log.warn("Remote booking history sync was skipped or failed.", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async runSingleCycle(): Promise<void> {
    for (const offset of config.dateOffsets) {
      if (this.stopped) break;
      const date = cairoDateAtOffset(offset);

      try {
        const rawTrips = await this.client.getAvailableTrips(date);

        // Safe diagnostic logging: show structure of first returned trip if present
        if (rawTrips.length > 0 && !this.notifiedTrips.has(`diag:${date}`)) {
          this.notifiedTrips.add(`diag:${date}`);
          const sample = rawTrips[0];
          log.info("Sample trip structure received (sensitive fields redacted):", {
            date,
            diagnostics: safeTripDiagnostic(sample)
          });
        }

        let matchCount = 0;

        for (const rawTrip of rawTrips) {
          if (this.stopped) break;

          const tripObj = rawTrip as Record<string, unknown>;
          let routeStops: Array<{ id: number; stopName: string }> | undefined;

          // If trip does not include pickupStopId, fetch stops from its route
          if (!tripObj.pickupStopId && typeof tripObj.routeId === "number") {
            try {
              routeStops = await this.client.getRouteStops(tripObj.routeId);
            } catch {
              // Ignore failure to fetch stops; evaluateTrip will report missing fields if required
            }
          }

          const evaluation = evaluateTrip(rawTrip, date, routeStops);

          if (evaluation.status === "MATCH") {
            matchCount++;
            await this.handleMatchingTrip(evaluation.trip);
          } else if (evaluation.status === "REFUSED_MISSING_FIELDS") {
            const dedupeKey = `missing:${date}:${evaluation.missingFields.join(",")}`;
            if (!this.notifiedTrips.has(dedupeKey)) {
              this.notifiedTrips.add(dedupeKey);
              log.warn(
                "Trip matched route/pickup criteria but was REFUSED due to missing required booking fields.",
                {
                  date,
                  reason: evaluation.reason,
                  missingFields: evaluation.missingFields,
                  diagnostics: evaluation.diagnostics
                }
              );
            }
          } else if (evaluation.status === "REFUSED_AMBIGUOUS") {
            const dedupeKey = `ambiguous:${date}`;
            if (!this.notifiedTrips.has(dedupeKey)) {
              this.notifiedTrips.add(dedupeKey);
              log.warn(
                "Trip matched route/pickup criteria but pickup-stop ID is AMBIGUOUS. Booking refused to prevent invalid submission.",
                {
                  date,
                  reason: evaluation.reason,
                  ambiguousFields: evaluation.ambiguousFields
                }
              );
            }
          }
        }

        log.info("Availability check completed.", {
          date,
          totalTrips: rawTrips.length,
          matchingTrips: matchCount
        });
      } catch (error) {
        if (error instanceof NetworkTimeoutError) {
          log.warn("Network timeout checking date availability. Will retry next cycle.", {
            date,
            error: error.message
          });
        } else {
          log.error("Availability check failed for date.", {
            date,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }

  private async handleMatchingTrip(trip: NormalizedTrip): Promise<void> {
    const tripKey = `${trip.tripDate}:${trip.tripId}`;

    // Log match details
    log.warn("Matching trip detected!", {
      tripId: trip.tripId,
      pickupStopId: trip.pickupStopId,
      date: trip.tripDate,
      route: trip.routeName,
      pickup: trip.pickupStopName,
      departureTime: trip.departureTime
    });

    // Notify user of match once per trip
    if (!this.notifiedTrips.has(tripKey)) {
      this.notifiedTrips.add(tripKey);
      await this.notifier.notifyTripMatched(trip);
    }

    // Execute booking through the booking engine
    const result = await this.bookingEngine.bookTrip(trip);

    if (result.status === "SUCCESS") {
      log.info("Booking successfully processed and confirmed!", {
        tripId: trip.tripId,
        bookingCode: result.booking.bookingCode
      });
      if (config.exitOnSuccess) {
        log.info("EXIT_ON_SUCCESS is enabled. Shutting down monitor following confirmed booking.");
        this.stop();
      }
    } else if (result.status === "SKIPPED_DRY_RUN") {
      log.info("Dry-run match verified. Auto-booking is disabled.", {
        tripId: trip.tripId,
        date: trip.tripDate
      });
    } else if (result.status === "UNCERTAIN") {
      log.error("Booking resulted in an UNCERTAIN outcome. Action required.", {
        tripId: trip.tripId,
        attemptId: result.attemptId,
        reason: result.reason
      });
    } else if (result.status === "FAILED") {
      log.warn("Booking submission failed.", {
        tripId: trip.tripId,
        reason: result.reason
      });
    }
  }
}
