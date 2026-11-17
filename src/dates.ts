import { config } from "./config.js";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: config.timezone,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hour12: false
});

export interface CairoDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function getCairoDateParts(date: Date = new Date()): CairoDateParts {
  const parts = timeFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const val = parts.find((p) => p.type === type)?.value;
    return val ? parseInt(val, 10) : 0;
  };

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second")
  };
}

export function cairoDateAtOffset(offsetDays: number, fromDate: Date = new Date()): string {
  const parts = dateFormatter.formatToParts(fromDate);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);

  // Use UTC arithmetic on the Cairo calendar date to avoid host timezone drift.
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export function parseTargetTime(timeStr: string): { hour: number; minute: number } {
  const [hStr, mStr] = timeStr.split(":");
  const hour = Number(hStr);
  const minute = Number(mStr);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`Invalid time format: "${timeStr}". Expected HH:MM in 24h format.`);
  }
  return { hour, minute };
}

export function isCairoTimePast(targetTime: string, fromDate: Date = new Date()): boolean {
  const { hour: targetHour, minute: targetMinute } = parseTargetTime(targetTime);
  const cairo = getCairoDateParts(fromDate);
  if (cairo.hour > targetHour) return true;
  if (cairo.hour === targetHour && cairo.minute >= targetMinute) return true;
  return false;
}

/**
 * Calculates the exact UTC Date and millisecond offset for the next occurrence
 * of a given HH:MM time in Africa/Cairo, accounting for DST changes.
 */
export function getNextCairoTargetTime(
  targetTime: string,
  fromDate: Date = new Date()
): { targetDate: Date; msUntil: number } {
  const { hour: targetHour, minute: targetMinute } = parseTargetTime(targetTime);
  const cairo = getCairoDateParts(fromDate);

  let targetYear = cairo.year;
  let targetMonth = cairo.month;
  let targetDay = cairo.day;

  // If target time for today has already passed, schedule for tomorrow
  if (cairo.hour > targetHour || (cairo.hour === targetHour && cairo.minute >= targetMinute)) {
    const nextDay = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay + 1));
    targetYear = nextDay.getUTCFullYear();
    targetMonth = nextDay.getUTCMonth() + 1;
    targetDay = nextDay.getUTCDate();
  }

  // Cairo is UTC+2 or UTC+3. Make an initial guess assuming UTC+2:
  let candidate = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay, targetHour - 2, targetMinute, 0, 0));
  let candidateCairo = getCairoDateParts(candidate);

  // If candidate is off by an hour due to DST transition, adjust:
  const hourDiff = targetHour - candidateCairo.hour;
  if (hourDiff !== 0) {
    candidate = new Date(candidate.getTime() + hourDiff * 3600_000);
  }

  const msUntil = Math.max(0, candidate.getTime() - fromDate.getTime());
  return { targetDate: candidate, msUntil };
}

export function formatCairoDateTime(date: Date = new Date()): string {
  return `${date.toLocaleString("en-US", { timeZone: config.timezone })} (${config.timezone})`;
}
