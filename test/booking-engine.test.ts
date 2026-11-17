import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BookingEngine, validateBookingResponse } from "../src/booking/booking-engine.js";
import { BookingRepository } from "../src/storage/booking-repository.js";
import { NetworkTimeoutError, type BookingHttpResult } from "../src/api/iti-client.js";
import type {
  Notifier,
  ConfirmedBookingDetails,
  MatchedTripDetails,
  ReconciliationDetails
} from "../src/notifications/notifier.js";
import type { NormalizedTrip } from "../src/matching/trip-matcher.js";

class MockNotifier implements Notifier {
  public monitoringStarted: Record<string, unknown>[] = [];
  public tripsMatched: MatchedTripDetails[] = [];
  public bookingsSubmitted: { trip: MatchedTripDetails; attemptId: number }[] = [];
  public bookingsConfirmed: ConfirmedBookingDetails[] = [];
  public authFailures: string[] = [];
  public reconciliations: ReconciliationDetails[] = [];

  async notifyMonitoringStarted(details: Record<string, unknown>): Promise<void> {
    this.monitoringStarted.push(details);
  }
  async notifyTripMatched(trip: MatchedTripDetails): Promise<void> {
    this.tripsMatched.push(trip);
  }
  async notifyBookingSubmitted(trip: MatchedTripDetails, attemptId: number): Promise<void> {
    this.bookingsSubmitted.push({ trip, attemptId });
  }
  async notifyBookingConfirmed(booking: ConfirmedBookingDetails): Promise<void> {
    this.bookingsConfirmed.push(booking);
  }
  async notifyAuthFailure(reason: string): Promise<void> {
    this.authFailures.push(reason);
  }
  async notifyReconciliationRequired(details: ReconciliationDetails): Promise<void> {
    this.reconciliations.push(details);
  }
}

describe("Booking Engine & Response Validation", () => {
  const sampleTrip: NormalizedTrip = {
    tripId: 400,
    pickupStopId: 19,
    routeName: "خط 6 أكتوبر ليلة القدر 1",
    pickupStopName: "ليلة القدر",
    tripDate: "2026-11-20",
    isReturnTrip: true,
    departureTime: "16:00:00",
    raw: {}
  };

  const validResponsePayload = {
    success: true,
    message: "Booking created successfully",
    data: {
      id: 1962,
      bookingCode: "BK752632",
      tripId: 400,
      routeName: "خط 6 أكتوبر ليلة القدر 1",
      tripDate: "2026-11-20",
      departureTime: "16:00:00",
      pickupLocation: "ليلة القدر",
      seatNumber: null,
      status: "CONFIRMED",
      pickupStopName: "ليلة القدر",
      isReturnTrip: true
    }
  };

  it("validates successful response structure strictly", () => {
    const val = validateBookingResponse(validResponsePayload, 400);
    assert.equal(val.valid, true);
    assert.equal(val.data?.bookingCode, "BK752632");
    assert.equal(val.data?.tripId, 400);
    assert.equal(val.data?.id, 1962);
  });

  it("rejects response when success flag is false", () => {
    const val = validateBookingResponse({ ...validResponsePayload, success: false }, 400);
    assert.equal(val.valid, false);
    assert.match(val.error!, /success flag is not true/);
  });

  it("rejects response when bookingCode is missing or empty", () => {
    const invalid = {
      ...validResponsePayload,
      data: { ...validResponsePayload.data, bookingCode: "" }
    };
    const val = validateBookingResponse(invalid, 400);
    assert.equal(val.valid, false);
    assert.match(val.error!, /Missing or empty bookingCode/);
  });

  it("rejects response when returned tripId does not match requested tripId", () => {
    const invalid = {
      ...validResponsePayload,
      data: { ...validResponsePayload.data, tripId: 999 }
    };
    const val = validateBookingResponse(invalid, 400);
    assert.equal(val.valid, false);
    assert.match(val.error!, /does not match requested tripId/);
  });

  it("processes a confirmed booking when HTTP 201 is received with validated data", async () => {
    const repo = new BookingRepository(":memory:");
    const notifier = new MockNotifier();

    const mockClient = {
      createBooking: async (): Promise<BookingHttpResult> => ({
        status: 201,
        body: validResponsePayload,
        rawHeaders: {}
      })
    } as any;

    const engine = new BookingEngine(mockClient, repo, notifier, true);
    const result = await engine.bookTrip(sampleTrip);

    assert.equal(result.status, "SUCCESS");
    if (result.status === "SUCCESS") {
      assert.equal(result.booking.bookingCode, "BK752632");
      assert.equal(result.booking.tripId, 400);
    }

    assert.equal(notifier.bookingsSubmitted.length, 1);
    assert.equal(notifier.bookingsConfirmed.length, 1);
    assert.equal(notifier.bookingsConfirmed[0]?.bookingCode, "BK752632");

    const record = repo.getLatestAttemptForTrip(400);
    assert.equal(record?.status, "CONFIRMED");
    assert.equal(record?.bookingCode, "BK752632");

    repo.close();
  });

  it("marks attempt UNCERTAIN if HTTP 201 response payload fails validation", async () => {
    const repo = new BookingRepository(":memory:");
    const notifier = new MockNotifier();

    const malformedPayload = {
      success: true,
      message: "Created but missing bookingCode",
      data: { id: 10, tripId: 400, bookingCode: "" }
    };

    const mockClient = {
      createBooking: async (): Promise<BookingHttpResult> => ({
        status: 201,
        body: malformedPayload,
        rawHeaders: {}
      })
    } as any;

    const engine = new BookingEngine(mockClient, repo, notifier, true);
    const result = await engine.bookTrip(sampleTrip);

    assert.equal(result.status, "UNCERTAIN");
    assert.equal(notifier.bookingsConfirmed.length, 0);
    assert.equal(notifier.reconciliations.length, 1);

    const record = repo.getLatestAttemptForTrip(400);
    assert.equal(record?.status, "UNCERTAIN");

    repo.close();
  });

  it("marks attempt UNCERTAIN on network timeout and guarantees it is never blindly retried", async () => {
    const repo = new BookingRepository(":memory:");
    const notifier = new MockNotifier();

    let callCount = 0;
    const mockClient = {
      createBooking: async (): Promise<BookingHttpResult> => {
        callCount++;
        throw new NetworkTimeoutError("ETIMEDOUT: Connection dropped waiting for server response");
      }
    } as any;

    const engine = new BookingEngine(mockClient, repo, notifier, true);

    // Initial booking attempt encounters timeout
    const result1 = await engine.bookTrip(sampleTrip);
    assert.equal(result1.status, "UNCERTAIN");
    assert.equal(callCount, 1);
    assert.equal(notifier.reconciliations.length, 1);

    const record = repo.getLatestAttemptForTrip(400);
    assert.equal(record?.status, "UNCERTAIN");

    // Second booking attempt for the same trip MUST be blocked without submitting a new POST
    const result2 = await engine.bookTrip(sampleTrip);
    assert.equal(result2.status, "SKIPPED_ALREADY_BOOKED");
    assert.match(result2.reason, /outcome is UNCERTAIN.*Manual reconciliation is required/);
    assert.equal(callCount, 1, "createBooking must NOT be called a second time!");

    repo.close();
  });

  it("records FAILED status when server returns non-201 response (e.g. 400 No Seats)", async () => {
    const repo = new BookingRepository(":memory:");
    const notifier = new MockNotifier();

    const mockClient = {
      createBooking: async (): Promise<BookingHttpResult> => ({
        status: 400,
        body: { success: false, message: "No available seats on this trip." },
        rawHeaders: {}
      })
    } as any;

    const engine = new BookingEngine(mockClient, repo, notifier, true);
    const result = await engine.bookTrip(sampleTrip);

    assert.equal(result.status, "FAILED");
    assert.equal((result as any).httpStatus, 400);
    assert.equal(notifier.bookingsConfirmed.length, 0);

    const record = repo.getLatestAttemptForTrip(400);
    assert.equal(record?.status, "FAILED");
    assert.match(record?.errorMessage ?? "", /No available seats/);

    repo.close();
  });

  it("skips submission and remains in safe dry-run mode when BOOKING_ENABLED is false", async () => {
    const repo = new BookingRepository(":memory:");
    const notifier = new MockNotifier();

    let called = false;
    const mockClient = {
      createBooking: async (): Promise<BookingHttpResult> => {
        called = true;
        return { status: 201, body: validResponsePayload, rawHeaders: {} };
      }
    } as any;

    // bookingEnabled is false
    const engine = new BookingEngine(mockClient, repo, notifier, false);
    const result = await engine.bookTrip(sampleTrip);

    assert.equal(result.status, "SKIPPED_DRY_RUN");
    assert.equal(called, false, "createBooking must never be called in dry-run mode");
    assert.equal(repo.listAttempts().length, 0, "No pending records created in dry-run mode");

    repo.close();
  });
});
