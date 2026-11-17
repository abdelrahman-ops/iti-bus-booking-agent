import "dotenv/config";
import path from "node:path";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() ?? fallback;
}

function numberList(value: string): number[] {
  const parsed = value.split(",").map((part) => Number(part.trim()));
  if (parsed.length === 0 || parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 30)) {
    throw new Error("WATCH_DATE_OFFSETS must be comma-separated integers between 0 and 30.");
  }
  return [...new Set(parsed)].sort((a, b) => a - b);
}

const direction = required("DIRECTION", "return");
if (!["return", "outbound", "either"].includes(direction)) {
  throw new Error("DIRECTION must be return, outbound, or either.");
}

export const config = {
  baseUrl: required("ITI_BASE_URL", "https://schedule.iti.gov.eg").replace(/\/$/, ""),
  dashboardPath: required("DASHBOARD_PATH", "/dashboard"),
  pollIntervalMs: Number(required("POLL_INTERVAL_MS", "30000")),
  dateOffsets: numberList(required("WATCH_DATE_OFFSETS", "0,1,2,3,4,5,6,7")),
  timezone: required("TIMEZONE", "Africa/Cairo"),
  routeKeyword: required("ROUTE_KEYWORD", "6 أكتوبر"),
  pickupKeyword: required("PICKUP_KEYWORD", "ليلة القدر"),
  direction: direction as "return" | "outbound" | "either",
  bookingEnabled: required("BOOKING_ENABLED", "false") === "true",
  browserProfileDir: path.resolve(required("BROWSER_PROFILE_DIR", "./data/browser-profile")),
  databasePath: path.resolve(required("DATABASE_PATH", "./data/bookings.db")),
  headless: required("HEADLESS", "true") === "true",
  dailyStartTime: required("DAILY_START_TIME", "11:45"),
  waitForSchedule: required("WAIT_FOR_SCHEDULE", "true") === "true",
  telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),
  telegramChatId: optional("TELEGRAM_CHAT_ID"),
  rateLimitMaxRequests: Number(required("RATE_LIMIT_MAX_REQUESTS", "30")),
  rateLimitWindowMs: Number(required("RATE_LIMIT_WINDOW_MS", "60000")),
  requestTimeoutMs: Number(required("REQUEST_TIMEOUT_MS", "15000")),
  exitOnSuccess: optional("EXIT_ON_SUCCESS", "false") === "true"
};

if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 15000) {
  throw new Error("POLL_INTERVAL_MS must be at least 15000.");
}

if (!/^\d{2}:\d{2}$/.test(config.dailyStartTime)) {
  throw new Error("DAILY_START_TIME must be in HH:MM 24-hour format (e.g. 11:45).");
}

