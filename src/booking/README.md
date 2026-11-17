# Booking Engine & Confirmed ITI Contracts

## 1. Confirmed ITI API Booking Contract

### Endpoint
```http
POST https://schedule.iti.gov.eg/api/v1/bookings
```

### Headers
```http
Authorization: Bearer <accessToken>
Content-Type: application/json
Accept: application/json
```

### Request Payload
```json
{
  "tripId": 400,
  "pickupStopId": 19
}
```

### Confirmed Success Response (HTTP 201 Created)
```json
{
  "success": true,
  "message": "Booking created successfully",
  "data": {
    "id": 1962,
    "bookingCode": "BK752632",
    "tripId": 400,
    "routeName": "خط 6 أكتوبر ليلة القدر 1",
    "tripDate": "2026-11-16",
    "departureTime": "16:00:00",
    "pickupLocation": "ليلة القدر",
    "seatNumber": null,
    "status": "CONFIRMED",
    "pickupStopName": "ليلة القدر",
    "isReturnTrip": true
  }
}
```

## 2. Duplicate Protection & Idempotency Protocol

- Every booking submission begins by acquiring a persistent atomic lock in SQLite (`status: 'PENDING'`).
- Successful HTTP 201 responses are strictly validated before transitioning the record to `status: 'CONFIRMED'`.
- If an in-flight booking request encounters a network timeout, socket hang up, or connection drop:
  - The record is transitioned to `status: 'UNCERTAIN'`.
  - An urgent alert is dispatched to Telegram.
  - **The engine NEVER blindly retries an uncertain outcome**, preventing double-booking on the server.
  - Subsequent monitoring cycles block attempts for this trip until manual reconciliation.

## 3. Verified API Contracts

All API contracts have been verified with live server ground truth:

1. **Available Trips Endpoint**:
   - `GET /api/v1/trips/available?date=YYYY-MM-DD`
   - Returns available trips with `id` (tripId), `routeId`, `routeName`, `tripDate`, and `requiresPickupSelection: true`.

2. **Route Stops Endpoint**:
   - `GET /api/v1/routes/{routeId}/stops`
   - For Route #18 (`خط 6 أكتوبر ليلة القدر 1`):
     - Stop ID `19`: `ليلة القدر`
     - Stop ID `20`: `الحصري`
     - Stop ID `21`: `جهينة`
     - Stop ID `22`: `هايبر`
   - The agent resolves `PICKUP_KEYWORD=ليلة القدر` to stop ID `19`.

3. **Remote Booking History**:
   - `GET /api/v1/bookings`
   - Returns user booking records with `id`, `bookingCode`, `tripId`, `status`, and `tripDate`.
   - Synchronized on startup to prevent duplicate reservations.
