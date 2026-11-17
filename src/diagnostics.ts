import { openPersistentContext, validateDashboard } from "./runtime.js";
import { SessionManager } from "./auth/session.js";
import { ItiClient } from "./api/iti-client.js";
import { BookingRepository } from "./storage/booking-repository.js";
import { TelegramNotifier } from "./notifications/notifier.js";
import { evaluateTrip, safeTripDiagnostic } from "./matching/trip-matcher.js";
import { cairoDateAtOffset, formatCairoDateTime } from "./dates.js";
import { config } from "./config.js";
import { log } from "./log.js";

async function runDiagnostics(): Promise<void> {
  console.log("\n==================================================");
  console.log("       ITI BUS AGENT - DIAGNOSTIC SYSTEM CHECK    ");
  console.log("==================================================\n");

  console.log(`[1] Configuration:`);
  console.log(`    • ITI Base URL:       ${config.baseUrl}`);
  console.log(`    • Timezone:           ${config.timezone}`);
  console.log(`    • Cairo Current Time: ${formatCairoDateTime()}`);
  console.log(`    • Daily Start Time:   ${config.dailyStartTime}`);
  console.log(`    • Route Keyword:      "${config.routeKeyword}"`);
  console.log(`    • Pickup Keyword:     "${config.pickupKeyword}"`);
  console.log(`    • Direction:          ${config.direction}`);
  console.log(`    • Date Offsets:       ${config.dateOffsets.join(", ")}`);
  console.log(`    • Auto-Book:          ${config.bookingEnabled ? "ENABLED" : "DISABLED (Dry Run Safe Mode)"}`);
  console.log(`    • Browser Profile:    ${config.browserProfileDir}`);
  console.log(`    • Database:           ${config.databasePath}`);

  // Test Database
  console.log(`\n[2] Database & Persistent Storage Check:`);
  let repo: BookingRepository | null = null;
  try {
    repo = new BookingRepository(config.databasePath);
    const recent = repo.listAttempts(5);
    console.log(`    ✅ SQLite database initialized successfully.`);
    console.log(`    • Total recent recorded attempts: ${recent.length}`);
    for (const att of recent) {
      console.log(`      - Attempt #${att.id}: Trip ${att.tripId} [${att.tripDate}] -> ${att.status} (Code: ${att.bookingCode ?? "N/A"})`);
    }
  } catch (err) {
    console.error(`    ❌ Database initialization failed:`, err);
  }

  // Test Telegram
  console.log(`\n[3] Notification Service Check:`);
  const notifier = new TelegramNotifier();
  if (config.telegramBotToken && config.telegramChatId) {
    console.log(`    • Telegram configured. Testing connection...`);
    const testResult = await notifier.testConnection();
    if (testResult.success) {
      console.log(`    ✅ ${testResult.message}`);
    } else {
      console.log(`    ⚠️ ${testResult.message}`);
    }
  } else {
    console.log(`    ℹ️ Telegram bot token or chat ID not set. Notifications will route to console logs only.`);
  }

  // Test Playwright & Authentication
  console.log(`\n[4] Browser Profile & Authentication Check:`);
  let context;
  try {
    context = await openPersistentContext(true);
    console.log(`    ✅ Playwright persistent browser context launched.`);
  } catch (err) {
    console.error(`    ❌ Failed to launch browser profile from ${config.browserProfileDir}.`);
    console.error(`       If this is the first run, execute "npm run login" first to initialize the session.`);
    repo?.close();
    process.exit(1);
  }

  const session = new SessionManager(context);
  let client: ItiClient;

  try {
    await validateDashboard(context);
    console.log(`    • Refreshing session token via POST /api/v1/auth/refresh...`);
    await session.refresh(true);
    console.log(`    ✅ Session refresh succeeded. Valid access token held in memory.`);
    client = new ItiClient(context, session);
  } catch (err) {
    console.error(`    ❌ Authentication check failed:`, err instanceof Error ? err.message : String(err));
    console.error(`       Please re-authenticate interactively by running "npm run login".`);
    await context.close();
    repo?.close();
    process.exit(1);
  }

  // Test Availability API
  console.log(`\n[5] User Booking History Check:`);
  try {
    const userBookings = await client.getUserBookings();
    console.log(`    ✅ Retrieved ${userBookings.length} existing booking(s) from ITI:`);
    for (const b of userBookings.slice(0, 5)) {
      console.log(
        `      • Booking #${b.bookingCode} | Trip #${b.tripId} [${b.tripDate}] | Route: "${b.routeName}" | Pickup: "${b.pickupLocation}" | Status: ${b.status}`
      );
    }
  } catch (err) {
    console.error(`    ❌ Booking history check failed:`, err instanceof Error ? err.message : String(err));
  }

  console.log(`\n[6] Available Trips Endpoint Check (Scanning offsets: ${config.dateOffsets.join(", ")}):`);
  for (const offset of config.dateOffsets) {
    const testDate = cairoDateAtOffset(offset);
    try {
      console.log(`    • Querying GET /api/v1/trips/available?date=${testDate}...`);
      const trips = await client.getAvailableTrips(testDate);
      console.log(`      Received ${trips.length} trip(s) for ${testDate}.`);

      if (trips.length > 0) {
        console.log(`\n      [List of All ${trips.length} Available Trips for ${testDate}]`);
        for (const t of trips as Record<string, unknown>[]) {
          console.log(
            `      • Trip #${t.id} (Route #${t.routeId}): "${t.routeName}" | PickupStopId: ${t.pickupStopId} | PickupStopName: "${t.pickupStopName}" | Seats: ${t.availableSeats} | Return: ${t.isReturnTrip} | RequiresPickupSelection: ${t.requiresPickupSelection}`
          );
        }

        const sample = trips[0];
        console.log(`\n      [Detailed Diagnostic Inspection of Sample Trip (Redacted)]`);
        console.log(JSON.stringify(safeTripDiagnostic(sample), null, 2));

        // Evaluate all trips against criteria
        for (const rawTrip of trips) {
          const tripObj = rawTrip as Record<string, unknown>;
          let routeStops: Array<{ id: number; stopName: string }> | undefined;
          if (!tripObj.pickupStopId && typeof tripObj.routeId === "number") {
            try {
              routeStops = await client.getRouteStops(tripObj.routeId);
            } catch {
              // Ignore
            }
          }

          const evalResult = evaluateTrip(rawTrip, testDate, routeStops);
          if (evalResult.status === "MATCH") {
            console.log(
              `      🎯 MATCH FOUND: Trip ID ${evalResult.trip.tripId}, Pickup Stop ID ${evalResult.trip.pickupStopId} ("${evalResult.trip.pickupStopName}"), Route: "${evalResult.trip.routeName}"`
            );
          } else if (evalResult.status === "REFUSED_MISSING_FIELDS") {
            console.log(
              `      ⚠️ Filter matched keywords but missing booking fields: ${evalResult.missingFields.join(", ")}`
            );
          } else if (evalResult.status === "REFUSED_AMBIGUOUS") {
            console.log(`      ⚠️ Filter matched keywords but pickup stop ID is AMBIGUOUS: ${evalResult.reason}`);
          }
        }
      }
    } catch (err) {
      console.error(`      ❌ Availability fetch failed for ${testDate}:`, err instanceof Error ? err.message : String(err));
    }
  }

  await context.close();
  repo?.close();

  console.log("\n==================================================");
  console.log("             DIAGNOSTICS FINISHED                 ");
  console.log("==================================================\n");
}

await runDiagnostics();
