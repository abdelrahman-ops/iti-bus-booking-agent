# ITI Bus Booking Agent

An automated, reliable ITI bus monitoring and booking agent built with Node.js, TypeScript, and Playwright. The agent is designed to run in GitHub Actions or 24/7 on an Ubuntu Linux VPS under `systemd`, independently of local desktop browser sessions.

> 📖 **Developer Documentation:** For complete backend REST API endpoints, schemas, authentication flows, and the verified ITI bus routes directory, see [ROUTES.md](file:///e:/Technology/GitHub%20REPOS/iti-bus-booker/ROUTES.md).

---

## 1. Features & Architecture

- **Authenticated Session Management**:
  - Leverages Playwright persistent browser context and its associated API request context.
  - Automatically sends and receives HttpOnly refresh cookies without exposing them.
  - Token refresh via `POST /api/v1/auth/refresh`; access tokens are maintained in-memory only and never logged or persisted.
  - Handles HTTP 401 Unauthorized responses with automatic session refresh and single-request retry.

- **Automated Scheduling & Timezone Precision**:
  - Native timezone support for `Africa/Cairo` with automatic Daylight Saving Time (DST) handling.
  - Starts its daily monitoring cycle at **11:45 AM Cairo time** (configurable via `DAILY_START_TIME` and `WAIT_FOR_SCHEDULE`).
  - Monitors today through the next 7 days (offsets `0,1,2,3,4,5,6,7`) with configurable polling intervals.

- **Intelligent Trip Matching & Safe Normalization**:
  - Normalizes Arabic text across spelling variants (e.g. Alef variations `أ`/`إ`/`آ`, Teh Marbuta `ة`/`ه`, Alef Maqsura `ى`/`ي`, diacritics/tashkeel, and tatweel).
  - Enforces strict satisfaction of all 6 matching rules:
    1. Route name contains `6 أكتوبر`.
    2. Pickup stop name matches `ليلة القدر`.
    3. `isReturnTrip === true` (for return trip direction).
    4. Trip date is within monitored horizon.
    5. Valid `tripId` exists.
    6. Valid `pickupStopId` exists.
  - Resolves `pickupStopId` from root fields, nested objects, or stops lists.
  - **Fail-closed safety**: If `pickupStopId` is missing or ambiguous (e.g. multiple conflicting candidate stop IDs), the agent **refuses to book** and logs diagnostic details.

- **Confirmed Booking Execution & Strict Verification**:
  - Implements the confirmed booking endpoint:
    `POST https://schedule.iti.gov.eg/api/v1/bookings`
    Payload: `{"tripId": <id>, "pickupStopId": <id>}`
  - Requires HTTP `201 Created` and validates the response schema (`success === true`, valid `id`, matching `tripId`, non-empty `bookingCode`).
  - Safe dry-run mode: `BOOKING_ENABLED=false` by default to verify trip schema before live submissions.

- **Persistent Duplicate Protection & Concurrency Locks**:
  - Persistent SQLite database (`data/bookings.db`) with zero external native build dependencies using Node.js built-in `node:sqlite`.
  - Atomic in-flight locking: Prevents simultaneous monitoring cycles from attempting the same trip.
  - State machine: `PENDING` → `CONFIRMED` | `FAILED` | `UNCERTAIN`.
  - **Never blindly retry**: If a network timeout, socket drop, or connection abort occurs while a booking POST is in-flight, the record is marked `UNCERTAIN`. The agent blocks automatic retries and triggers an alert for manual reconciliation.

- **Rate Limiting & Reliability**:
  - Sliding-window rate limiter ensuring requests never exceed the confirmed limit of 30 requests per 60 seconds.
  - Inter-request pacing (minimum 300ms) to prevent burst 429s.
  - Respects HTTP 429 responses, parsing `Retry-After` headers and applying exponential backoff.
  - Graceful shutdown on `SIGINT` and `SIGTERM` with clean browser context and database teardown.

- **Telegram Notifications**:
  - Real-time alerts for: monitoring started, matching trip found, booking submitted, booking confirmed (with code and trip details), auth failure, and uncertain outcomes requiring reconciliation.
  - Credentials and tokens are strictly excluded from notifications.

- **Diagnostic Mode (`npm run diagnose`)**:
  - Standalone verification utility checking configuration, persistent browser profile, session refresh, available trips endpoint, SQLite database, and Telegram connectivity without placing bookings.

---

## 2. Configuration (`.env`)

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

| Variable | Default | Description |
| :--- | :--- | :--- |
| `ITI_BASE_URL` | `https://schedule.iti.gov.eg` | ITI base URL (no `/api/v1`) |
| `DASHBOARD_PATH` | `/dashboard` | Path to authenticated dashboard |
| `TIMEZONE` | `Africa/Cairo` | Timezone for date calculation and scheduling |
| `DAILY_START_TIME` | `11:45` | Cairo time (HH:MM 24h) when daily monitoring starts |
| `WAIT_FOR_SCHEDULE` | `true` | If true, waits until `DAILY_START_TIME` before polling |
| `POLL_INTERVAL_MS` | `30000` | Polling interval in ms (minimum 15000) |
| `WATCH_DATE_OFFSETS` | `0,1,2,3,4,5,6,7` | Day offsets from today (today..7 days ahead) |
| `ROUTE_KEYWORD` | `6 أكتوبر` | Matching keyword in route name |
| `PICKUP_KEYWORD` | `ليلة القدر` | Matching keyword in pickup stop name |
| `DIRECTION` | `return` | Direction: `return`, `outbound`, or `either` |
| `BOOKING_ENABLED` | `false` | `false` = Dry Run; `true` = Automatic Booking |
| `DATABASE_PATH` | `./data/bookings.db` | SQLite database file location |
| `TELEGRAM_BOT_TOKEN` | *(optional)* | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | *(optional)* | Telegram recipient chat ID from @userinfobot |
| `RATE_LIMIT_MAX_REQUESTS` | `30` | Max requests per rate limit window (per 60s) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window duration (ms) |
| `REQUEST_TIMEOUT_MS` | `15000` | Network request timeout (ms) |
| `BROWSER_PROFILE_DIR` | `./data/browser-profile` | Playwright persistent profile storage |
| `HEADLESS` | `true` | Run Chromium in headless mode |

---

## 3. Database Schema

The SQLite database (`data/bookings.db`) automatically initializes with the following schema:

```sql
CREATE TABLE IF NOT EXISTS booking_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL,
  pickup_stop_id TEXT NOT NULL,
  trip_date TEXT NOT NULL,
  route_name TEXT NOT NULL,
  pickup_stop_name TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'PENDING' | 'CONFIRMED' | 'FAILED' | 'UNCERTAIN'
  booking_code TEXT,                  -- Returned booking reference (e.g. BK752632)
  booking_id INTEGER,                 -- Server booking record ID (e.g. 1962)
  response_payload TEXT,              -- Sanitized JSON response payload
  error_message TEXT,                 -- Failure or timeout diagnostic message
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_trip_date ON booking_attempts (trip_id, trip_date);
CREATE INDEX IF NOT EXISTS idx_attempts_status ON booking_attempts (status);
CREATE INDEX IF NOT EXISTS idx_attempts_date_dir ON booking_attempts (trip_date, direction, status);
```

---

## 4. Local Quickstart Commands

### 1. Install Dependencies
```bash
npm install
npx playwright install --with-deps chromium
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your preferred settings
```

### 3. Bootstrap Authentication (Interactive)
```bash
npm run login
```
A Chromium browser window will open to `https://schedule.iti.gov.eg/dashboard`. Log in with your ITI credentials and complete any OTP or verification steps. Once on the dashboard, return to the terminal and press `Enter`. The persistent profile will be saved to `data/browser-profile`.

### 4. Run Diagnostics
```bash
npm run diagnose
```
Checks your environment configuration, database readiness, Telegram alerts, persistent profile session refresh, and queries the live available trips endpoint with diagnostic output.

### 5. Run Tests
```bash
npm test
```
Executes all 30 unit and mocked API tests verifying trip matching, ambiguous pickup stop refusal, duplicate protection, response validation, and uncertain timeout isolation.

### 6. Build and Start Agent
```bash
npm run typecheck
npm run build
npm start
```

---

## 5. Ubuntu VPS Deployment Guide

### Prerequisites
- Ubuntu 22.04 or 24.04 LTS VPS
- Node.js 22.x or 24.x LTS
- Git

### Step 1: Create Dedicated System User
```bash
sudo useradd --system --create-home --home-dir /var/lib/itiagent --shell /usr/sbin/nologin itiagent
```

### Step 2: Clone & Install the Application
```bash
sudo mkdir -p /opt/iti-bus-agent
sudo chown -R $USER:$USER /opt/iti-bus-agent
git clone <repo-url> /opt/iti-bus-agent
cd /opt/iti-bus-agent

npm install
npx playwright install --with-deps chromium
npm run build
```

### Step 3: Configure Environment & Directory Permissions
```bash
cp .env.example .env
# Edit .env:
# nano .env

# Create data directory and enforce restrictive file permissions
mkdir -p /opt/iti-bus-agent/data
chmod 700 /opt/iti-bus-agent/data
chmod 600 /opt/iti-bus-agent/.env

# Hand ownership over to the dedicated service user
sudo chown -R itiagent:itiagent /opt/iti-bus-agent
```

### Step 4: Bootstrap Session on VPS
Because the initial login requires entering credentials / OTP in a visible browser:
- **Option A (Desktop/VNC)**: Connect via SSH tunnel with X11 forwarding or TigerVNC and execute `npm run login`.
- **Option B (Local Sync)**: Complete `npm run login` on your local machine, then securely copy the generated `data/browser-profile` directory to the VPS:
  ```bash
  rsync -avz -e ssh ./data/browser-profile/ itiagent@<vps-ip>:/opt/iti-bus-agent/data/browser-profile/
  sudo chown -R itiagent:itiagent /opt/iti-bus-agent/data/browser-profile
  chmod -R 700 /opt/iti-bus-agent/data/browser-profile
  ```

### Step 5: Test with Diagnostic Check
```bash
sudo -u itiagent -s /bin/bash -c "cd /opt/iti-bus-agent && npm run diagnose"
```
Ensure all 5 diagnostic checks pass (Profile, Session Refresh, and Database).

### Step 6: Install and Enable systemd Service
```bash
sudo cp deploy/iti-bus-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now iti-bus-agent
```

### Step 7: Service Monitoring & Maintenance
```bash
# Check service status
sudo systemctl status iti-bus-agent

# Follow real-time structured logs
journalctl -u iti-bus-agent -f

# Restart or stop the agent
sudo systemctl restart iti-bus-agent
sudo systemctl stop iti-bus-agent
```

---

## 6. Verified API Contracts & Integration

All previously unverified API contracts have now been confirmed with live ITI ground truth:

1. **Available Trips Endpoint**:
   - `GET /api/v1/trips/available?date=YYYY-MM-DD`
   - Returns trips with: `id` (tripId), `routeId`, `routeName`, `tripDate`, `departureTime`, `isReturnTrip`, `availableSeats`, and `requiresPickupSelection`.

2. **Route Stops Resolution**:
   - `GET /api/v1/routes/{routeId}/stops`
   - For Route #18 (`خط 6 أكتوبر ليلة القدر 1`), the API returns:
     - Stop `19`: `ليلة القدر`
     - Stop `20`: `الحصري`
     - Stop `21`: `جهينة`
     - Stop `22`: `هايبر`
   - The agent automatically resolves `PICKUP_KEYWORD=ليلة القدر` to stop ID `19`.

3. **Remote Booking History**:
   - `GET /api/v1/bookings`
   - Retrieves active and past user bookings (e.g., `BK160046` for Trip #408).
   - The agent synchronizes remote history on startup to prevent double-booking across server reboots.

4. **Booking Submission**:
   - `POST /api/v1/bookings`
   - Payload: `{"tripId": 408, "pickupStopId": 19}`
   - Confirmed response: HTTP `201 Created` with booking code.
