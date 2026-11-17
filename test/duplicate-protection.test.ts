import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BookingRepository } from "../src/storage/booking-repository.js";

describe("Duplicate Protection & Booking Repository", () => {
  it("initializes an in-memory repository with clean schema", () => {
    const repo = new BookingRepository(":memory:");
    const attempts = repo.listAttempts();
    assert.equal(attempts.length, 0);
    repo.close();
  });

  it("creates a pending attempt and acquires lock preventing duplicate submission", () => {
    const repo = new BookingRepository(":memory:");

    const attemptId = repo.createPendingAttempt({
      tripId: 400,
      pickupStopId: 19,
      tripDate: "2026-11-17",
      routeName: "خط 6 أكتوبر",
      pickupStopName: "ليلة القدر",
      direction: "return"
    });

    assert.ok(attemptId > 0);

    // Second simultaneous attempt for the same trip must be blocked
    const check = repo.hasActiveOrConfirmedBooking(400, "2026-11-17");
    assert.equal(check.blocked, true);
    assert.match(check.reason!, /submission currently in progress/);

    // Trying to create another attempt throws error
    assert.throws(() => {
      repo.createPendingAttempt({
        tripId: 400,
        pickupStopId: 19,
        tripDate: "2026-11-17",
        routeName: "خط 6 أكتوبر",
        pickupStopName: "ليلة القدر",
        direction: "return"
      });
    }, /Cannot create booking attempt/);

    repo.close();
  });

  it("transitions pending attempt to CONFIRMED and blocks future bookings", () => {
    const repo = new BookingRepository(":memory:");

    const attemptId = repo.createPendingAttempt({
      tripId: 401,
      pickupStopId: 19,
      tripDate: "2026-11-18",
      routeName: "خط 6 أكتوبر",
      pickupStopName: "ليلة القدر",
      direction: "return"
    });

    repo.markConfirmed(attemptId, "BK752632", 1962, { seat: 12 });

    const check = repo.hasActiveOrConfirmedBooking(401, "2026-11-18");
    assert.equal(check.blocked, true);
    assert.match(check.reason!, /already confirmed \(Booking Code: BK752632\)/);

    const latest = repo.getLatestAttemptForTrip(401, "2026-11-18");
    assert.equal(latest?.status, "CONFIRMED");
    assert.equal(latest?.bookingCode, "BK752632");
    assert.equal(latest?.bookingId, 1962);

    repo.close();
  });

  it("blocks duplicate bookings for the same date and direction", () => {
    const repo = new BookingRepository(":memory:");

    const attemptId = repo.createPendingAttempt({
      tripId: 402,
      pickupStopId: 19,
      tripDate: "2026-11-19",
      routeName: "خط 6 أكتوبر",
      pickupStopName: "ليلة القدر",
      direction: "return"
    });

    repo.markConfirmed(attemptId, "BK111222", 2001);

    // Checks date-level booking guard
    assert.equal(repo.hasConfirmedBookingForDate("2026-11-19", "return"), true);
    assert.equal(repo.hasConfirmedBookingForDate("2026-11-19", "outbound"), false);
    assert.equal(repo.hasConfirmedBookingForDate("2026-11-20", "return"), false);

    repo.close();
  });

  it("transitions pending attempt to UNCERTAIN and prevents blind retries", () => {
    const repo = new BookingRepository(":memory:");

    const attemptId = repo.createPendingAttempt({
      tripId: 403,
      pickupStopId: 19,
      tripDate: "2026-11-20",
      routeName: "خط 6 أكتوبر",
      pickupStopName: "ليلة القدر",
      direction: "return"
    });

    repo.markUncertain(attemptId, "ETIMEDOUT: Connection dropped during POST /api/v1/bookings");

    const check = repo.hasActiveOrConfirmedBooking(403, "2026-11-20");
    assert.equal(check.blocked, true);
    assert.match(check.reason!, /outcome is UNCERTAIN.*Manual reconciliation is required/);

    const latest = repo.getLatestAttemptForTrip(403);
    assert.equal(latest?.status, "UNCERTAIN");
    assert.match(latest?.errorMessage ?? "", /ETIMEDOUT/);

    repo.close();
  });

  it("persists booking attempts across restarts using disk file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "iti-db-test-"));
    const dbFile = path.join(tempDir, "bookings.db");

    try {
      // Instance 1: Create and confirm booking
      const repo1 = new BookingRepository(dbFile);
      const attemptId = repo1.createPendingAttempt({
        tripId: 404,
        pickupStopId: 19,
        tripDate: "2026-11-21",
        routeName: "خط 6 أكتوبر",
        pickupStopName: "ليلة القدر",
        direction: "return"
      });
      repo1.markConfirmed(attemptId, "BK999888", 3001);
      repo1.close();

      // Instance 2: Simulate agent restart by creating new repository instance on same file
      const repo2 = new BookingRepository(dbFile);
      const check = repo2.hasActiveOrConfirmedBooking(404, "2026-11-21");
      assert.equal(check.blocked, true);
      assert.match(check.reason!, /BK999888/);

      const latest = repo2.getLatestAttemptForTrip(404);
      assert.equal(latest?.bookingCode, "BK999888");
      assert.equal(latest?.status, "CONFIRMED");

      repo2.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
