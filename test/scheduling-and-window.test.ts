import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getCairoDateParts,
  getCairoTodayTime,
  getCairoWindowStatus,
  formatCairoTimeOnly,
  cairoDateAtOffset
} from "../src/dates.js";
import { BookingRepository } from "../src/storage/booking-repository.js";

describe("Scheduling, Booking Windows & Date Utilities", () => {
  it("extracts Cairo date parts accurately", () => {
    const parts = getCairoDateParts(new Date("2026-11-17T10:00:00Z"));
    assert.equal(parts.year, 2026);
    assert.equal(parts.month, 11);
    assert.equal(parts.day, 17);
    // In winter, Cairo is UTC+2, so 10:00 UTC = 12:00 Cairo
    assert.equal(parts.hour, 12);
  });

  it("calculates getCairoTodayTime for a given target HH:MM", () => {
    const reference = new Date("2026-11-17T08:00:00Z"); // 10:00 AM Cairo
    const target = getCairoTodayTime("11:45", reference);
    const targetParts = getCairoDateParts(target);

    assert.equal(targetParts.year, 2026);
    assert.equal(targetParts.month, 11);
    assert.equal(targetParts.day, 17);
    assert.equal(targetParts.hour, 11);
    assert.equal(targetParts.minute, 45);
  });

  it("detects BEFORE_WINDOW status when Cairo time is before dailyStartTime", () => {
    // 09:40 UTC = 11:40 AM Cairo (5 minutes before 11:45 AM window)
    const simulatedNow = new Date("2026-11-17T09:40:00Z");
    const status = getCairoWindowStatus("11:45", 30, simulatedNow);

    assert.equal(status.status, "BEFORE_WINDOW");
    assert.equal(status.msUntilStart, 5 * 60_000);
    assert.equal(status.msRemainingInWindow, 30 * 60_000);
  });

  it("detects INSIDE_WINDOW status when Cairo time is inside the active window", () => {
    // 09:50 UTC = 11:50 AM Cairo (5 minutes after 11:45 AM start, 25 minutes remaining)
    const simulatedNow = new Date("2026-11-17T09:50:00Z");
    const status = getCairoWindowStatus("11:45", 30, simulatedNow);

    assert.equal(status.status, "INSIDE_WINDOW");
    assert.equal(status.msUntilStart, 0);
    assert.equal(status.msRemainingInWindow, 25 * 60_000);
  });

  it("detects AFTER_WINDOW status when Cairo time is past the window end (e.g. evening)", () => {
    // 17:32 UTC = 19:32 Cairo (7:32 PM, hours past 12:15 PM window close)
    const simulatedNow = new Date("2026-11-17T17:32:00Z");
    const status = getCairoWindowStatus("11:45", 30, simulatedNow);

    assert.equal(status.status, "AFTER_WINDOW");
    assert.equal(status.msUntilStart, 0);
    assert.equal(status.msRemainingInWindow, 0);
  });

  it("formats Cairo time strings correctly", () => {
    const time = new Date("2026-11-17T09:45:00Z"); // 11:45 AM Cairo
    const formatted = formatCairoTimeOnly(time);
    assert.match(formatted, /11:45/);
  });

  it("retrieves confirmed booking for date and direction from BookingRepository", () => {
    const repo = new BookingRepository(":memory:");

    const attemptId = repo.createPendingAttempt({
      tripId: 408,
      pickupStopId: 19,
      tripDate: "2026-11-17",
      routeName: "6 أكتوبر",
      pickupStopName: "ليلة القدر",
      direction: "return"
    });

    repo.markConfirmed(attemptId, "BK160046", 1234, { success: true });

    const confirmed = repo.getConfirmedBookingForDate("2026-11-17", "return");
    assert.ok(confirmed);
    assert.equal(confirmed.bookingCode, "BK160046");
    assert.equal(confirmed.tripId, "408");

    // Returns null for different date
    const nonexistent = repo.getConfirmedBookingForDate("2026-11-18", "return");
    assert.equal(nonexistent, null);

    // Returns null for different direction if specified
    const wrongDir = repo.getConfirmedBookingForDate("2026-11-17", "outbound");
    assert.equal(wrongDir, null);

    repo.close();
  });
});
