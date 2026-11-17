import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTrip,
  normalizeArabic,
  safeTripDiagnostic,
  tripMatches
} from "../src/matching/trip-matcher.js";
import { cairoDateAtOffset } from "../src/dates.js";

describe("Trip Matcher & Normalization", () => {
  const validToday = cairoDateAtOffset(0);

  it("normalizes Arabic text with various spellings, diacritics, and alef forms", () => {
    // Normalizes alefs with hamza to bare alef
    assert.equal(normalizeArabic("6 أكتوبر"), normalizeArabic("6 اكتوبر"));
    assert.equal(normalizeArabic("أكتوبر"), "اكتوبر");
    assert.equal(normalizeArabic("إكتوبر"), "اكتوبر");
    assert.equal(normalizeArabic("آكتوبر"), "اكتوبر");

    // Normalizes teh marbuta to heh
    assert.equal(normalizeArabic("ليلة القدر"), normalizeArabic("ليله القدر"));

    // Strips tashkeel (diacritics)
    assert.equal(normalizeArabic("لَيْلَةُ الْقَدْرِ"), "ليله القدر");

    // Collapses whitespace
    assert.equal(normalizeArabic("  6   أكتوبر  "), "6 اكتوبر");
  });

  it("matches a valid trip satisfying all 6 conditions", () => {
    const trip = {
      id: 400,
      pickupStopId: 19,
      routeName: "خط 6 أكتوبر ليلة القدر 1",
      pickupStopName: "ليلة القدر",
      tripDate: validToday,
      isReturnTrip: true,
      departureTime: "16:00:00"
    };

    const evaluation = evaluateTrip(trip, validToday);
    assert.equal(evaluation.status, "MATCH");
    if (evaluation.status === "MATCH") {
      assert.equal(evaluation.trip.tripId, 400);
      assert.equal(evaluation.trip.pickupStopId, 19);
      assert.equal(evaluation.trip.isReturnTrip, true);
      assert.equal(evaluation.trip.tripDate, validToday);
      assert.equal(evaluation.trip.routeName, "خط 6 أكتوبر ليلة القدر 1");
      assert.equal(evaluation.trip.pickupStopName, "ليلة القدر");
    }

    assert.equal(tripMatches(trip), true);
  });

  it("resolves pickupStopId from a nested pickupStop object", () => {
    const trip = {
      tripId: 405,
      routeName: "6 أكتوبر - ليلة القدر",
      pickupStop: {
        id: 25,
        name: "ليلة القدر"
      },
      tripDate: validToday,
      isReturnTrip: true
    };

    const evaluation = evaluateTrip(trip, validToday);
    assert.equal(evaluation.status, "MATCH");
    if (evaluation.status === "MATCH") {
      assert.equal(evaluation.trip.tripId, 405);
      assert.equal(evaluation.trip.pickupStopId, 25);
    }
  });

  it("resolves pickupStopId from a stops array", () => {
    const trip = {
      id: 500,
      routeName: "خط 6 أكتوبر",
      stops: [
        { id: 10, name: "الحصري" },
        { id: 19, name: "ليلة القدر" }
      ],
      tripDate: validToday,
      isReturnTrip: true
    };

    const evaluation = evaluateTrip(trip, validToday);
    assert.equal(evaluation.status, "MATCH");
    if (evaluation.status === "MATCH") {
      assert.equal(evaluation.trip.pickupStopId, 19);
    }
  });

  it("refuses to match when route does not contain route keyword", () => {
    const trip = {
      id: 400,
      pickupStopId: 19,
      routeName: "خط المعادي الجديدة",
      pickupStopName: "ليلة القدر",
      tripDate: validToday,
      isReturnTrip: true
    };

    const evaluation = evaluateTrip(trip, validToday);
    assert.equal(evaluation.status, "NO_MATCH");
    assert.match(evaluation.reason, /does not contain/);
  });

  it("refuses to match when pickup location does not contain pickup keyword", () => {
    const trip = {
      id: 400,
      pickupStopId: 19,
      routeName: "خط 6 أكتوبر",
      pickupStopName: "ميدان الحصري",
      tripDate: validToday,
      isReturnTrip: true
    };

    const evaluation = evaluateTrip(trip, validToday);
    assert.equal(evaluation.status, "NO_MATCH");
    assert.match(evaluation.reason, /does not contain/);
  });

  it("refuses to match when isReturnTrip is not true for return direction", () => {
    const outboundTrip = {
      id: 400,
      pickupStopId: 19,
      routeName: "خط 6 أكتوبر",
      pickupStopName: "ليلة القدر",
      tripDate: validToday,
      isReturnTrip: false
    };

    const evaluation = evaluateTrip(outboundTrip, validToday);
    assert.equal(evaluation.status, "NO_MATCH");
    assert.match(evaluation.reason, /isReturnTrip.*is not exactly true/);
  });

  it("refuses to match when trip date is outside monitoring horizon", () => {
    const pastTrip = {
      id: 400,
      pickupStopId: 19,
      routeName: "خط 6 أكتوبر",
      pickupStopName: "ليلة القدر",
      tripDate: "2020-01-01",
      isReturnTrip: true
    };

    const evaluation = evaluateTrip(pastTrip, "2020-01-01");
    assert.equal(evaluation.status, "NO_MATCH");
    assert.match(evaluation.reason, /outside monitored date horizon/);
  });

  it("refuses to book when pickupStopId is missing and reports missing fields", () => {
    const tripWithoutStopId = {
      id: 400,
      routeName: "خط 6 أكتوبر",
      pickupStopName: "ليلة القدر",
      tripDate: validToday,
      isReturnTrip: true
      // pickupStopId is intentionally omitted
    };

    const evaluation = evaluateTrip(tripWithoutStopId, validToday);
    assert.equal(evaluation.status, "REFUSED_MISSING_FIELDS");
    if (evaluation.status === "REFUSED_MISSING_FIELDS") {
      assert.ok(evaluation.missingFields.some((f) => f.includes("pickupStopId")));
    }
  });

  it("refuses to book when pickupStopId is ambiguous", () => {
    const tripWithConflictingStops = {
      id: 400,
      routeName: "خط 6 أكتوبر",
      pickupStopId: 19,
      stops: [
        { id: 22, name: "ليلة القدر محطة أ" },
        { id: 35, name: "ليلة القدر محطة ب" }
      ],
      tripDate: validToday,
      isReturnTrip: true
    };

    const evaluation = evaluateTrip(tripWithConflictingStops, validToday);
    assert.equal(evaluation.status, "REFUSED_AMBIGUOUS");
    if (evaluation.status === "REFUSED_AMBIGUOUS") {
      assert.match(evaluation.reason, /Multiple conflicting pickup-stop IDs found/);
    }
  });

  it("generates safe diagnostic structure with sensitive values removed", () => {
    const rawTrip = {
      id: 400,
      routeName: "خط 6 أكتوبر",
      secretToken: "secret_value_xyz",
      driverPhone: "01000000000",
      stops: [{ id: 19, name: "ليلة القدر" }]
    };

    const diag = safeTripDiagnostic(rawTrip);
    assert.ok(Array.isArray(diag.keysPresent));
    assert.ok((diag.keysPresent as string[]).includes("id"));
    assert.ok((diag.keysPresent as string[]).includes("routeName"));
    assert.ok((diag.keysPresent as string[]).includes("driverPhone"));

    const schema = diag.schema as Record<string, string>;
    assert.equal(schema.id, "number");
    assert.equal(schema.routeName, "string");
    assert.equal(schema.driverPhone, "string");
    assert.equal(schema.stops, "Array(1)");

    // Raw sensitive strings are not leaked into summary
    const summary = diag.summary as Record<string, unknown>;
    assert.equal(summary.id, 400);
    assert.equal(summary.routeName, "خط 6 أكتوبر");
    assert.equal((summary as Record<string, unknown>).secretToken, undefined);
  });
});
