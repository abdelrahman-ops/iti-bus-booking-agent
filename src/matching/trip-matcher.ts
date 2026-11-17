import { config } from "../config.js";
import { cairoDateAtOffset } from "../dates.js";

/**
 * Normalizes Arabic text by standardizing alefs, teh marbuta, alef maqsura,
 * and stripping diacritics (tashkeel) and tatweel.
 */
export function normalizeArabic(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .trim()
    .toLowerCase()
    // Remove Arabic diacritics (harakat / tashkeel)
    .replace(/[\u064B-\u065F\u0670]/g, "")
    // Standardize Alef variations (أ, إ, آ, ٱ -> ا)
    .replace(/[أإآٱ]/g, "ا")
    // Standardize Teh Marbuta (ة -> ه)
    .replace(/ة/g, "ه")
    // Standardize Alef Maqsura (ى -> ي)
    .replace(/ى/g, "ي")
    // Remove Tatweel (ـ)
    .replace(/ـ/g, "")
    // Collapse multiple whitespace characters
    .replace(/\s+/g, " ");
}

export interface NormalizedTrip {
  tripId: number;
  pickupStopId: number;
  routeName: string;
  pickupStopName: string;
  tripDate: string;
  isReturnTrip: boolean;
  departureTime?: string;
  availableSeats?: number;
  raw: Record<string, unknown>;
}

export type TripEvaluation =
  | {
      status: "MATCH";
      trip: NormalizedTrip;
      diagnostics: Record<string, unknown>;
    }
  | {
      status: "NO_MATCH";
      reason: string;
      diagnostics?: Record<string, unknown>;
    }
  | {
      status: "REFUSED_MISSING_FIELDS";
      reason: string;
      missingFields: string[];
      diagnostics: Record<string, unknown>;
    }
  | {
      status: "REFUSED_AMBIGUOUS";
      reason: string;
      ambiguousFields: string[];
      diagnostics: Record<string, unknown>;
    };

/**
 * Safely extracts tripId from an unknown record.
 */
function extractTripId(trip: Record<string, unknown>): number | null {
  const candidate = trip.tripId ?? trip.id;
  if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) {
    return candidate;
  }
  if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) {
    const parsed = Number(candidate.trim());
    return parsed > 0 ? parsed : null;
  }
  return null;
}

export interface RouteStopInfo {
  id: number;
  stopName: string;
}

/**
 * Safely resolves pickupStopId, checking direct properties, nested objects,
 * stops arrays, or external route stops. Rejects ambiguous multiple IDs.
 */
function resolvePickupStopId(
  trip: Record<string, unknown>,
  pickupKeyword: string,
  routeStops?: RouteStopInfo[]
): { id: number | null; ambiguous: boolean; candidateCount: number } {
  const normalizedKeyword = normalizeArabic(pickupKeyword);
  const candidateIds = new Set<number>();

  // 1. Direct fields: pickupStopId, pickupLocationId, stopId
  for (const field of ["pickupStopId", "pickupLocationId", "stopId"]) {
    const val = trip[field];
    if (typeof val === "number" && Number.isInteger(val) && val > 0) {
      candidateIds.add(val);
    } else if (typeof val === "string" && /^\d+$/.test(val.trim())) {
      candidateIds.add(Number(val.trim()));
    }
  }

  // 2. Nested pickup stop object (e.g. trip.pickupStop.id or trip.pickupLocation.id)
  for (const field of ["pickupStop", "pickupLocation"]) {
    const nested = trip[field];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedId = (nested as Record<string, unknown>).id;
      if (typeof nestedId === "number" && Number.isInteger(nestedId) && nestedId > 0) {
        candidateIds.add(nestedId);
      } else if (typeof nestedId === "string" && /^\d+$/.test(nestedId.trim())) {
        candidateIds.add(Number(nestedId.trim()));
      }
    }
  }

  // 3. Array of stops (e.g. trip.stops or trip.pickupStops)
  for (const field of ["stops", "pickupStops"]) {
    const stopsList = trip[field];
    if (Array.isArray(stopsList)) {
      for (const stop of stopsList) {
        if (stop && typeof stop === "object") {
          const stopObj = stop as Record<string, unknown>;
          const stopName = normalizeArabic(stopObj.name ?? stopObj.stopName ?? stopObj.pickupLocation ?? "");
          if (stopName.includes(normalizedKeyword)) {
            const sid = stopObj.id ?? stopObj.stopId;
            if (typeof sid === "number" && Number.isInteger(sid) && sid > 0) {
              candidateIds.add(sid);
            } else if (typeof sid === "string" && /^\d+$/.test(sid.trim())) {
              candidateIds.add(Number(sid.trim()));
            }
          }
        }
      }
    }
  }

  // 4. External route stops list (from GET /api/v1/routes/{routeId}/stops)
  if (candidateIds.size === 0 && Array.isArray(routeStops)) {
    for (const stop of routeStops) {
      if (normalizeArabic(stop.stopName).includes(normalizedKeyword)) {
        if (typeof stop.id === "number" && Number.isInteger(stop.id) && stop.id > 0) {
          candidateIds.add(stop.id);
        }
      }
    }
  }

  if (candidateIds.size === 1) {
    const [id] = Array.from(candidateIds);
    return { id: id ?? null, ambiguous: false, candidateCount: 1 };
  }

  if (candidateIds.size > 1) {
    return { id: null, ambiguous: true, candidateCount: candidateIds.size };
  }

  return { id: null, ambiguous: false, candidateCount: 0 };
}

/**
 * Checks whether tripDate is within the configured monitoring horizon.
 */
function isDateWithinHorizon(tripDate: string): boolean {
  if (!tripDate || typeof tripDate !== "string") return false;
  const watchedDates = new Set(config.dateOffsets.map((offset) => cairoDateAtOffset(offset)));
  return watchedDates.has(tripDate.trim());
}

/**
 * Normalizes and evaluates a raw trip object against the 6 confirmed matching rules:
 * 1. Route name contains routeKeyword (normalized)
 * 2. Pickup stop name matches pickupKeyword (normalized)
 * 3. isReturnTrip matches configured direction (exactly true for "return")
 * 4. Trip date is within configured horizon
 * 5. Valid trip ID exists
 * 6. Valid pickup-stop ID exists (without ambiguity)
 */
export function evaluateTrip(
  rawTrip: unknown,
  fallbackDate?: string,
  routeStops?: RouteStopInfo[]
): TripEvaluation {
  if (!rawTrip || typeof rawTrip !== "object" || Array.isArray(rawTrip)) {
    return {
      status: "NO_MATCH",
      reason: "Trip item is not a valid JSON object."
    };
  }

  const trip = rawTrip as Record<string, unknown>;
  const diagnostics = safeTripDiagnostic(trip);

  // Extract Route Name
  const rawRouteName = trip.routeName ?? trip.route ?? trip.name ?? "";
  const routeName = typeof rawRouteName === "string" ? rawRouteName.trim() : "";
  const normalizedRoute = normalizeArabic(routeName);
  const normalizedRouteKeyword = normalizeArabic(config.routeKeyword);

  const normalizedPickupKeyword = normalizeArabic(config.pickupKeyword);

  // Extract Pickup Stop Name
  let rawPickupName =
    trip.pickupLocation ??
    trip.pickupStopName ??
    (typeof trip.pickupStop === "object" && trip.pickupStop !== null
      ? (trip.pickupStop as Record<string, unknown>).name
      : "");

  // If root doesn't specify pickup location name, check if any stop in stops array matches
  if (!rawPickupName && Array.isArray(trip.stops)) {
    const matchingStop = trip.stops.find((s) => {
      if (s && typeof s === "object") {
        const name = (s as Record<string, unknown>).name ?? (s as Record<string, unknown>).stopName;
        return typeof name === "string" && normalizeArabic(name).includes(normalizedPickupKeyword);
      }
      return false;
    });
    if (matchingStop) {
      rawPickupName =
        (matchingStop as Record<string, unknown>).name ??
        (matchingStop as Record<string, unknown>).stopName ??
        "";
    }
  }

  // If still not found, check routeStops if supplied
  if (!rawPickupName && Array.isArray(routeStops)) {
    const matchingRouteStop = routeStops.find((s) =>
      normalizeArabic(s.stopName).includes(normalizedPickupKeyword)
    );
    if (matchingRouteStop) {
      rawPickupName = matchingRouteStop.stopName;
    }
  }

  // If still not found, check if route name contains pickup keyword (e.g. "خط 6 أكتوبر ليلة القدر 1")
  if (!rawPickupName && normalizedRoute.includes(normalizedPickupKeyword)) {
    rawPickupName = config.pickupKeyword;
  }

  const pickupStopName = typeof rawPickupName === "string" ? rawPickupName.trim() : "";
  const normalizedPickup = normalizeArabic(pickupStopName);

  // Extract Direction
  const isReturnTrip = trip.isReturnTrip;

  // Extract Date
  const rawDate = trip.tripDate ?? trip.date ?? fallbackDate ?? "";
  const tripDate = typeof rawDate === "string" ? rawDate.trim() : "";

  // 1. Check Route Name
  if (!normalizedRoute.includes(normalizedRouteKeyword)) {
    return {
      status: "NO_MATCH",
      reason: `Route name "${routeName}" does not contain "${config.routeKeyword}".`
    };
  }

  // 2. Check Pickup Stop Name
  if (!normalizedPickup.includes(normalizedPickupKeyword)) {
    return {
      status: "NO_MATCH",
      reason: `Pickup stop "${pickupStopName}" does not contain "${config.pickupKeyword}".`
    };
  }

  // 3. Check Direction
  if (config.direction === "return" && isReturnTrip !== true) {
    return {
      status: "NO_MATCH",
      reason: `Trip isReturnTrip (${String(isReturnTrip)}) is not exactly true (direction required: return).`
    };
  }
  if (config.direction === "outbound" && isReturnTrip !== false) {
    return {
      status: "NO_MATCH",
      reason: `Trip isReturnTrip (${String(isReturnTrip)}) is not false (direction required: outbound).`
    };
  }
  if (typeof isReturnTrip !== "boolean" && config.direction !== "either") {
    return {
      status: "NO_MATCH",
      reason: `Trip direction is undefined/non-boolean (${String(isReturnTrip)}).`
    };
  }

  // 4. Check Date Horizon
  if (!isDateWithinHorizon(tripDate)) {
    return {
      status: "NO_MATCH",
      reason: `Trip date "${tripDate}" is outside monitored date horizon.`
    };
  }

  // At this point, Route, Pickup Name, Direction, and Date match!
  // Now verify Trip ID (Rule 5) and Pickup Stop ID (Rule 6)

  const tripIdNum = extractTripId(trip);
  const missingFields: string[] = [];
  if (tripIdNum === null) {
    missingFields.push("tripId (or id)");
  }

  const stopResolution = resolvePickupStopId(trip, config.pickupKeyword, routeStops);
  if (stopResolution.ambiguous) {
    return {
      status: "REFUSED_AMBIGUOUS",
      reason: `Multiple conflicting pickup-stop IDs found (${stopResolution.candidateCount} candidates). Refusing to guess stop ID.`,
      ambiguousFields: ["pickupStopId"],
      diagnostics
    };
  }

  if (stopResolution.id === null) {
    missingFields.push("pickupStopId (or pickupLocationId / nested stop ID)");
  }

  if (missingFields.length > 0) {
    return {
      status: "REFUSED_MISSING_FIELDS",
      reason: `Trip matches route and pickup criteria, but required booking fields are missing: ${missingFields.join(", ")}.`,
      missingFields,
      diagnostics
    };
  }

  const departureTime =
    typeof trip.departureTime === "string" ? trip.departureTime.trim() : undefined;
  const availableSeats =
    typeof trip.availableSeats === "number" ? trip.availableSeats : undefined;

  const normalizedTrip: NormalizedTrip = {
    tripId: tripIdNum!,
    pickupStopId: stopResolution.id!,
    routeName,
    pickupStopName,
    tripDate,
    isReturnTrip: Boolean(isReturnTrip),
    ...(departureTime ? { departureTime } : {}),
    ...(availableSeats !== undefined ? { availableSeats } : {}),
    raw: trip
  };

  return {
    status: "MATCH",
    trip: normalizedTrip,
    diagnostics
  };
}

/**
 * Diagnostic helper that strips sensitive values (e.g. personal data, auth tokens, phone numbers)
 * while preserving schema structure, keys, and value types.
 */
export function safeTripDiagnostic(trip: unknown): Record<string, unknown> {
  if (!trip || typeof trip !== "object") {
    return { type: typeof trip, value: String(trip) };
  }

  const obj = trip as Record<string, unknown>;
  const keys = Object.keys(obj);
  const schema: Record<string, string> = {};

  for (const key of keys) {
    const val = obj[key];
    if (val === null) {
      schema[key] = "null";
    } else if (Array.isArray(val)) {
      schema[key] = `Array(${val.length})`;
    } else if (typeof val === "object") {
      schema[key] = `Object(${Object.keys(val as Record<string, unknown>).join(",")})`;
    } else {
      schema[key] = typeof val;
    }
  }

  return {
    keysPresent: keys,
    schema,
    summary: {
      id: obj.id ?? obj.tripId,
      routeName: obj.routeName ?? obj.route,
      pickup: obj.pickupLocation ?? obj.pickupStopName,
      isReturnTrip: obj.isReturnTrip,
      date: obj.tripDate ?? obj.date
    }
  };
}

// Backwards-compatible legacy exports
export function tripMatches(value: unknown): boolean {
  const result = evaluateTrip(value);
  return result.status === "MATCH";
}

export function tripId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = extractTripId(value as Record<string, unknown>);
  return id !== null ? String(id) : null;
}

export function safeTripSummary(value: unknown): Record<string, unknown> {
  const diag = safeTripDiagnostic(value);
  return (diag.summary as Record<string, unknown>) ?? { value };
}
