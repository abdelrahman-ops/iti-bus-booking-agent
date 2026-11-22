# ITI Bus API & Routes Directory

Comprehensive technical reference for developers maintaining, extending, or integrating with the ITI Bus Booking backend (`schedule.iti.gov.eg`).

---

## 1. System Overview & Base Endpoints

- **Production Base URL:** `https://schedule.iti.gov.eg`
- **REST API Prefix:** `/api/v1`
- **Frontend App:** Flutter Web (CanvasKit / WASM)
- **Mandatory App Version Header:** `X-App-Build: 1` (fetched dynamically from `https://schedule.iti.gov.eg/version.json`). Requests omitting this header return `400 Bad Request` with code `APP_UPDATE_REQUIRED`.
- **Authentication Scheme:** Short-lived JWT Bearer token (`Authorization: Bearer <accessToken>`) combined with a 7-day HttpOnly cookie session (`refresh_token`).
- **Server Platform:** NGINX reverse proxy with rate limiting headers (`x-ratelimit-limit: 150`, `x-ratelimit-remaining: 146`, `x-ratelimit-reset: 60`).

---

## 2. Master Route Catalog

Below is the verified route catalog active on ITI's Smart Village fleet:

| Route ID | Route Name (`routeName`) | Start Location (`startLocation`) | Destination (`endLocation`) | Direction | Capacity | Requires Stop Selection? |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **18** | `خط 6 أكتوبر ليلة القدر 1` | `ليلة القدر` | `القرية الذكية` | Return (`true`) | 19 seats | Yes (`true`) |
| **24** | `خط 6 أكتوبر - حصرى 1` | `ليلة القدر` | `القرية الذكية` | Return (`true`) | 25 seats | Yes (`true`) |
| **23** | `خط 6 أكتوبر - حصرى 2` | `ليلة القدر` | `القرية الذكية` | Return (`true`) | 25 seats | Yes (`true`) |
| **25** | `خط 6 أكتوبر - حصرى 3` | `ليلة القدر` | `القرية الذكية` | Return (`true`) | 25 seats | Yes (`true`) |
| **16** | `خط رمسيس` | `التوحيد والنور` | `القرية الذكية` | Return (`true`) | 25 seats | Yes (`true`) |
| **15** | `خط الجيزة 1` | `التوحيد والنور` | `القرية الذكية` | Return (`true`) | 25 seats | Yes (`true`) |
| **19** | `خط الطريق الدائري - العاشر` | `موقف العاشر` | `القرية الذكية` | Return (`true`) | 25 seats | Yes (`true`) |

> **Important Architectural Note on Locations:**
> On the ITI backend, return trips departing from Smart Village display the passenger drop-off neighborhood in `startLocation` (e.g. `startLocation: "التوحيد والنور"` for Ramses, or `startLocation: "ليلة القدر"` for October), while `endLocation` is consistently `"القرية الذكية"`. The matcher inspects `trip.startLocation` directly.

---

## 3. REST API Specification

### 3.1. Authentication APIs

#### A. Direct Credential Login (Automated Fallback)
Authenticates a user directly without CAPTCHA or 2FA. Sets session cookies (`refresh_token`) on domain `schedule.iti.gov.eg`.

- **Method:** `POST`
- **Path:** `/api/v1/auth/login`
- **Headers:** `Content-Type: application/json`, `Accept: application/json`
- **Request Body:**
  ```json
  {
    "email": "student@example.com",
    "password": "your_password"
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "message": "Login successful",
    "data": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "tokenType": "Bearer"
    }
  }
  ```
- **Cookies Set by Server:**
  - `refresh_token`: Secure, HttpOnly, SameSite=Strict (Expires in 7 days).
  - `has_session`: `true`.
  - `iti_cache_cleared`: Timestamp integer.

#### B. Refresh Access Token
Exchanges the active `refresh_token` cookie for a fresh short-lived `accessToken`.

- **Method:** `POST`
- **Path:** `/api/v1/auth/refresh`
- **Headers:** `Accept: application/json`, `Content-Type: application/json`
- **Credentials:** `include` (sends the `refresh_token` cookie)
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "message": "Token refreshed successfully",
    "data": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "tokenType": "Bearer"
    }
  }
  ```
- **Single-Use Rotation (RTR) Caution:**
  ITI enforces single-use refresh tokens (`jti`). When `/auth/refresh` succeeds, the server sets a **new** `refresh_token` cookie and **immediately revokes the previous token**. Any duplicate request using the previous token returns:
  ```json
  {
    "success": false,
    "message": "Invalid or expired refresh token",
    "error": "Business Logic Error",
    "status": 400
  }
  ```
  The agent handles this by caching rotated tokens via `actions/cache` and automatically falling back to `POST /api/v1/auth/login`.

---

### 3.2. Trips & Availability APIs

#### A. Query Available Trips
Fetches all active trips for a specific date (Cairo local date `YYYY-MM-DD`).

- **Method:** `GET`
- **Path:** `/api/v1/trips/available?date=YYYY-MM-DD`
- **Headers:**
  - `Authorization: Bearer <accessToken>`
  - `Accept: application/json`
- **Response `200 OK` (Live Production Sample):**
  ```json
  {
    "success": true,
    "message": "Available trips retrieved successfully",
    "data": [
      {
        "id": 405,
        "routeId": 16,
        "routeName": "خط رمسيس",
        "startLocation": "التوحيد والنور",
        "endLocation": "القرية الذكية",
        "tripDate": "2026-11-18",
        "departureTime": "16:00:00",
        "estimatedArrivalTime": "16:40:00",
        "pickupStopId": null,
        "pickupStopName": null,
        "totalCapacity": 25,
        "availableSeats": 5,
        "busNumber": "BUS-16",
        "isTemporaryRoute": false,
        "requiresPickupSelection": true,
        "isReturnTrip": true
      },
      {
        "id": 408,
        "routeId": 18,
        "routeName": "خط 6 أكتوبر ليلة القدر 1",
        "startLocation": "ليلة القدر",
        "endLocation": "القرية الذكية",
        "tripDate": "2026-11-18",
        "departureTime": "16:00:00",
        "estimatedArrivalTime": "16:30:00",
        "pickupStopId": null,
        "pickupStopName": null,
        "totalCapacity": 19,
        "availableSeats": 0,
        "busNumber": "BUS-18",
        "isTemporaryRoute": false,
        "requiresPickupSelection": true,
        "isReturnTrip": true
      }
    ],
    "timestamp": "2026-11-18T10:34:07.890621871"
  }
  ```

#### B. Fetch Route Stops
Retrieves all intermediate pickup/drop-off stops for a given `routeId` when `requiresPickupSelection: true` and `pickupStopId: null`.

- **Method:** `GET`
- **Path:** `/api/v1/routes/{routeId}/stops`
- **Headers:** `Authorization: Bearer <accessToken>`
- **Response `200 OK` Schema:**
  ```json
  {
    "success": true,
    "data": [
      {
        "id": 19,
        "routeId": 18,
        "stopName": "ليلة القدر",
        "stopOrder": 1,
        "arrivalTime": "16:30:00"
      },
      {
        "id": 31,
        "routeId": 16,
        "stopName": "التوحيد والنور",
        "stopOrder": 1,
        "arrivalTime": "16:40:00"
      }
    ]
  }
  ```

---

### 3.3. Bookings APIs

#### A. Execute Bus Booking
Books a seat on a target trip. Requires both `tripId` and `pickupStopId`.

- **Method:** `POST`
- **Path:** `/api/v1/bookings`
- **Headers:**
  - `Authorization: Bearer <accessToken>`
  - `Content-Type: application/json`
- **Request Body:**
  ```json
  {
    "tripId": 408,
    "pickupStopId": 19
  }
  ```
- **Response `201 Created` (Success):**
  ```json
  {
    "success": true,
    "message": "Booking created successfully",
    "data": {
      "id": 2188,
      "bookingCode": "BK160046",
      "tripId": 408,
      "routeName": "خط 6 أكتوبر ليلة القدر 1",
      "tripDate": "2026-11-18",
      "departureTime": "16:00:00",
      "pickupLocation": "ليلة القدر",
      "pickupStopName": "ليلة القدر",
      "seatNumber": 12,
      "status": "CONFIRMED",
      "isReturnTrip": true
    }
  }
  ```
- **Response `400 Bad Request` (No Seats / Already Booked):**
  ```json
  {
    "success": false,
    "message": "No available seats on this trip or user already has an active booking for this date.",
    "status": 400
  }
  ```

#### B. Fetch User Booking History
Retrieves all past and confirmed upcoming bookings for the authenticated user.

- **Method:** `GET`
- **Path:** `/api/v1/bookings?page=0&size=10`
- **Headers:** `Authorization: Bearer <accessToken>`, `X-App-Build: 1`
- **Response `200 OK` Structure:**
  ```json
  {
    "success": true,
    "data": {
      "content": [
        {
          "id": 2188,
          "bookingCode": "BK160046",
          "tripId": 408,
          "routeName": "خط 6 أكتوبر ليلة القدر 1",
          "tripDate": "2026-11-18",
          "pickupLocation": "ليلة القدر",
          "status": "CONFIRMED",
          "isReturnTrip": true,
          "bookedAt": "2026-11-17T11:46:12.000Z"
        }
      ]
    }
  }
  ```

#### C. Cancel Existing Booking
Cancels a previously booked seat.

- **Method:** `DELETE`
- **Path:** `/api/v1/bookings/{bookingId}`
- **Headers:**
  - `Authorization: Bearer <accessToken>`
  - `Content-Type: application/json`
  - `X-App-Build: 1`
- **Request Body (Optional reason):**
  ```json
  {
    "reason": "Sick leave / Online session"
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "message": "Booking cancelled successfully"
  }
  ```

---

### 3.4. Student Profile & Permissions APIs

#### A. Fetch Student Permissions & Restrictions
Checks whether the student is allowed to book, change routes, or has an active suspension/penalty.

- **Method:** `GET`
- **Path:** `/api/v1/students/me/permissions`
- **Headers:**
  - `Authorization: Bearer <accessToken>`
  - `X-App-Build: 1`
- **Response `200 OK` (Active Restriction Example):**
  ```json
  {
    "success": true,
    "message": "Permissions retrieved successfully",
    "data": {
      "canBookAllRoutes": false,
      "restrictedUntil": "2026-11-25",
      "canBookTrips": false,
      "canChangeRoute": false,
      "restrictionReason": null,
      "routeChangeUsed": false
    },
    "timestamp": "2026-11-22T11:04:37.870843339"
  }
  ```

#### B. Fetch Student Profile
Retrieves personal profile, track information, default route, and penalty counts.

- **Method:** `GET`
- **Path:** `/api/v1/students/me`
- **Headers:**
  - `Authorization: Bearer <accessToken>`
  - `X-App-Build: 1`
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "data": {
      "id": 615,
      "fullName": "Student Name",
      "email": "student@example.com",
      "phoneNumber": "01000000000",
      "trackName": "Open Source",
      "intakeNumber": 45,
      "routeName": "خط 6 أكتوبر ليلة القدر 1",
      "defaultPickupStopName": "ليلة القدر",
      "noShows": 1,
      "cancellations": 0
    }
  }
  ```

#### C. Switch Return Bus Route
Allows a student to switch their assigned return bus to a different route.

- **Method:** `POST`
- **Path:** `/api/v1/students/return-bus-switch`
- **Headers:**
  - `Authorization: Bearer <accessToken>`
  - `Content-Type: application/json`
  - `X-App-Build: 1`
- **Request Body:**
  ```json
  {
    "routeId": 16,
    "pickupStopId": 31
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "message": "Return route switched successfully"
  }
  ```

---

## 4. Matching Logic & Normalization Rules

Implemented in [`src/matching/trip-matcher.ts`](file:///e:/Technology/GitHub%20REPOS/iti-bus-booker/src/matching/trip-matcher.ts):

1. **Arabic Text Normalization (`normalizeArabic`)**:
   - `أ`, `إ`, `آ`, `ٱ` $\rightarrow$ `ا`
   - `ة` $\rightarrow$ `ه`
   - `ى` $\rightarrow$ `ي`
   - Strips all Harakat / Tashkeel (`َ ً ُ ٌ ِ ٍ ْ ّ`) and Tatweel (`ـ`).
   - Normalizes Eastern Arabic numerals (`٠-٩` $\rightarrow$ `0-9`).
2. **Pickup Stop Extraction Hierarchy**:
   1. `trip.startLocation` (e.g. `التوحيد والنور`, `ليلة القدر`).
   2. `trip.pickupLocation` or `trip.pickupStopName`.
   3. `trip.stops` array lookup.
   4. External `/api/v1/routes/{routeId}/stops` lookup.
3. **Route & Location Aliases**:
   - For **Ramses** (`ROUTE_KEYWORD="رمسيس"`): automatically resolves and matches `startLocation: "التوحيد والنور"` or `stopName: "التوحيد والنور"`.
   - For **October** (`ROUTE_KEYWORD="6 أكتوبر"`): automatically matches `startLocation: "ليلة القدر"` or any `حصرى` variant.

---

## 5. Telegram Notification & Cloudflare Proxy Architecture

Direct requests to `https://api.telegram.org` from Egyptian ISPs and Azure Cloud IP ranges are subject to DPI drops or timeouts.

```
[GitHub Actions Runner / Local Node.js]
                 │
                 ▼  (HTTPS POST)
[Cloudflare Worker Reverse Proxy]
https://telegram-proxy.abdelrahmanataa17.workers.dev/bot<TOKEN>/sendMessage
                 │
                 ▼  (Global Edge Routing)
[Telegram Bot API: api.telegram.org]
                 │
                 ▼
[Student's Private Telegram: @my_iti_alert_bot]
```

- **Environment Config:** Set `TELEGRAM_API_BASE=https://telegram-proxy.abdelrahmanataa17.workers.dev` (built-in default).
- **Security:** Bot tokens and chat IDs are never logged in plain text or transmitted to external services.
