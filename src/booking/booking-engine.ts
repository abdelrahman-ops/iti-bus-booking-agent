import { config } from "../config.js";
import { ItiClient, NetworkTimeoutError, type ConfirmedBookingResponseData } from "../api/iti-client.js";
import { BookingRepository } from "../storage/booking-repository.js";
import { type Notifier, type ConfirmedBookingDetails } from "../notifications/notifier.js";
import { type NormalizedTrip } from "../matching/trip-matcher.js";
import { log } from "../log.js";

export type BookingResult =
  | {
      status: "SUCCESS";
      booking: ConfirmedBookingDetails;
      attemptId: number;
    }
  | {
      status: "SKIPPED_ALREADY_BOOKED";
      reason: string;
    }
  | {
      status: "SKIPPED_DRY_RUN";
      reason: string;
      trip: NormalizedTrip;
    }
  | {
      status: "FAILED";
      reason: string;
      attemptId?: number;
      httpStatus?: number;
    }
  | {
      status: "UNCERTAIN";
      reason: string;
      attemptId: number;
    };

/**
 * Validates the structure and consistency of a booking creation response.
 * Requires HTTP 201 Created semantics:
 * - success: true
 * - data object present with valid numeric id
 * - non-empty bookingCode
 * - tripId matching requested tripId
 */
export function validateBookingResponse(
  body: unknown,
  expectedTripId: number
): { valid: boolean; error?: string; data?: ConfirmedBookingResponseData } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Response body is not a JSON object." };
  }

  const envelope = body as Record<string, unknown>;
  if (envelope.success !== true) {
    return {
      valid: false,
      error: `Envelope success flag is not true (received ${String(envelope.success)}).`
    };
  }

  const data = envelope.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Missing or invalid data object in booking response." };
  }

  const bookingCode = data.bookingCode;
  if (typeof bookingCode !== "string" || bookingCode.trim().length === 0) {
    return { valid: false, error: "Missing or empty bookingCode in response data." };
  }

  const returnedTripId = Number(data.tripId);
  if (returnedTripId !== expectedTripId) {
    return {
      valid: false,
      error: `Returned tripId (${returnedTripId}) does not match requested tripId (${expectedTripId}).`
    };
  }

  const id = Number(data.id);
  if (!Number.isInteger(id) || id <= 0) {
    return {
      valid: false,
      error: `Invalid or missing booking id in response data (received ${String(data.id)}).`
    };
  }

  return {
    valid: true,
    data: {
      id,
      bookingCode: bookingCode.trim(),
      tripId: returnedTripId,
      routeName: String(data.routeName ?? ""),
      tripDate: String(data.tripDate ?? ""),
      ...(typeof data.departureTime === "string" ? { departureTime: data.departureTime } : {}),
      pickupLocation: String(data.pickupLocation ?? data.pickupStopName ?? ""),
      ...(typeof data.pickupStopName === "string" ? { pickupStopName: data.pickupStopName } : {}),
      seatNumber: (data.seatNumber as string | number | null | undefined) ?? null,
      status: String(data.status ?? "CONFIRMED"),
      ...(typeof data.isReturnTrip === "boolean" ? { isReturnTrip: data.isReturnTrip } : {})
    }
  };
}

export class BookingEngine {
  constructor(
    private readonly client: ItiClient,
    private readonly repository: BookingRepository,
    private readonly notifier: Notifier,
    private readonly bookingEnabled: boolean = config.bookingEnabled
  ) {}

  /**
   * Attempts to book a verified normalized trip.
   * Enforces duplicate protection, concurrency limits, dry-run safety,
   * response validation, and uncertain-outcome isolation.
   */
  async bookTrip(trip: NormalizedTrip): Promise<BookingResult> {
    const tripDirection = trip.isReturnTrip ? "return" : "outbound";

    // 1. Check if this specific trip is already confirmed, pending, or uncertain
    const check = this.repository.hasActiveOrConfirmedBooking(trip.tripId, trip.tripDate);
    if (check.blocked) {
      log.warn("Booking skipped due to existing attempt state.", {
        tripId: trip.tripId,
        date: trip.tripDate,
        reason: check.reason
      });
      return { status: "SKIPPED_ALREADY_BOOKED", reason: check.reason! };
    }

    // 2. Check if a booking in this direction already exists for this date
    if (this.repository.hasConfirmedBookingForDate(trip.tripDate, tripDirection)) {
      const reason = `Already have a confirmed ${tripDirection} booking for date ${trip.tripDate}. Skipping trip ${trip.tripId}.`;
      log.info(reason);
      return { status: "SKIPPED_ALREADY_BOOKED", reason };
    }

    // 3. Dry-run safety: If BOOKING_ENABLED is false, refuse actual submission
    if (!this.bookingEnabled) {
      const reason = "BOOKING_ENABLED is false (Dry Run). Matching trip identified but not submitted.";
      log.info(reason, {
        tripId: trip.tripId,
        pickupStopId: trip.pickupStopId,
        date: trip.tripDate,
        route: trip.routeName
      });
      return { status: "SKIPPED_DRY_RUN", reason, trip };
    }

    // 4. Concurrency lock: Record pending attempt in SQLite
    let attemptId: number;
    try {
      attemptId = this.repository.createPendingAttempt({
        tripId: trip.tripId,
        pickupStopId: trip.pickupStopId,
        tripDate: trip.tripDate,
        routeName: trip.routeName,
        pickupStopName: trip.pickupStopName,
        direction: tripDirection
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Failed to acquire pending booking attempt lock.", { error: errorMsg });
      return { status: "SKIPPED_ALREADY_BOOKED", reason: errorMsg };
    }

    // 5. Send pre-submission notification
    await this.notifier.notifyBookingSubmitted(trip, attemptId);

    // 6. Execute POST request to confirmed endpoint: POST /api/v1/bookings
    try {
      const response = await this.client.createBooking(trip.tripId, trip.pickupStopId);

      // Check HTTP 201 Created
      if (response.status === 201) {
        const validation = validateBookingResponse(response.body, trip.tripId);
        if (!validation.valid) {
          // Status was 201 Created, but payload failed validation!
          // Marked as UNCERTAIN because server accepted creation but response was malformed.
          const errorMsg = `Server returned HTTP 201 Created but body validation failed: ${validation.error}`;
          this.repository.markUncertain(attemptId, errorMsg);
          await this.notifier.notifyReconciliationRequired({
            attemptId,
            tripId: trip.tripId,
            tripDate: trip.tripDate,
            routeName: trip.routeName,
            error: errorMsg
          });
          return { status: "UNCERTAIN", reason: errorMsg, attemptId };
        }

        const data = validation.data!;
        this.repository.markConfirmed(attemptId, data.bookingCode, data.id, response.body);

        const departureTime = data.departureTime || trip.departureTime;
        const bookingDetails: ConfirmedBookingDetails = {
          bookingCode: data.bookingCode,
          tripId: data.tripId,
          routeName: data.routeName || trip.routeName,
          tripDate: data.tripDate || trip.tripDate,
          pickupLocation: data.pickupLocation || trip.pickupStopName,
          ...(departureTime ? { departureTime } : {}),
          ...(data.seatNumber !== undefined ? { seatNumber: data.seatNumber } : {})
        };

        await this.notifier.notifyBookingConfirmed(bookingDetails);
        return { status: "SUCCESS", booking: bookingDetails, attemptId };
      }

      // Non-201 response: Server definitively rejected the request
      const errorMsg = `Server rejected booking with HTTP ${response.status}: ${JSON.stringify(response.body)}`;
      this.repository.markFailed(attemptId, errorMsg);
      return {
        status: "FAILED",
        reason: errorMsg,
        attemptId,
        httpStatus: response.status
      };
    } catch (error) {
      // IMPORTANT: Network timeout / connection reset / drop while request was in-flight.
      // The server may have processed the booking! Never blindly retry.
      const isTimeout = error instanceof NetworkTimeoutError;
      const errorMsg = isTimeout
        ? error.message
        : `Unexpected exception during booking POST: ${error instanceof Error ? error.message : String(error)}`;

      this.repository.markUncertain(attemptId, errorMsg);
      await this.notifier.notifyReconciliationRequired({
        attemptId,
        tripId: trip.tripId,
        tripDate: trip.tripDate,
        routeName: trip.routeName,
        error: errorMsg
      });

      return { status: "UNCERTAIN", reason: errorMsg, attemptId };
    }
  }
}
