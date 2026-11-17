import { openPersistentContext, validateDashboard } from "./runtime.js";
import { SessionManager } from "./auth/session.js";
import { ItiClient } from "./api/iti-client.js";
import { BookingRepository } from "./storage/booking-repository.js";
import { TelegramNotifier } from "./notifications/notifier.js";
import { BookingEngine } from "./booking/booking-engine.js";
import { AvailabilityMonitor } from "./monitor.js";
import { config } from "./config.js";
import { log } from "./log.js";

const repository = new BookingRepository(config.databasePath);
const notifier = new TelegramNotifier();
const context = await openPersistentContext();

let isShuttingDown = false;
let monitorRef: AvailabilityMonitor | null = null;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.warn(`Received ${signal}. Graceful shutdown initiated...`);

  if (monitorRef) {
    monitorRef.stop();
  }

  try {
    await context.close();
  } catch (err) {
    log.error("Error closing browser context during shutdown.", err);
  }

  try {
    repository.close();
  } catch (err) {
    log.error("Error closing database during shutdown.", err);
  }

  log.info("Agent shutdown complete.");
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  log.info("Starting ITI Bus Booking Agent...", {
    timezone: config.timezone,
    dailyStartTime: config.dailyStartTime,
    pollIntervalMs: config.pollIntervalMs,
    bookingEnabled: config.bookingEnabled
  });

  await validateDashboard(context);
  const session = new SessionManager(context);
  await session.refresh(true);

  const client = new ItiClient(context, session);
  const bookingEngine = new BookingEngine(client, repository, notifier, config.bookingEnabled);
  const monitor = new AvailabilityMonitor(client, bookingEngine, repository, notifier);
  monitorRef = monitor;

  await monitor.run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log.error("Fatal agent error. Stopping...", { error: message });
  try {
    await notifier.notifyAuthFailure(message);
  } catch {
    // Ignore notification failures during fatal exit
  }
  try {
    await context.close();
  } catch {
    // Ignore
  }
  try {
    repository.close();
  } catch {
    // Ignore
  }
  process.exit(1);
}
