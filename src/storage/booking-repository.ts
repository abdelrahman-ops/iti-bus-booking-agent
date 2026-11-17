import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";

export type BookingStatus = "PENDING" | "CONFIRMED" | "FAILED" | "UNCERTAIN";

export interface BookingAttempt {
  id: number;
  tripId: string;
  pickupStopId: string;
  tripDate: string;
  routeName: string;
  pickupStopName: string;
  direction: string;
  status: BookingStatus;
  bookingCode: string | null;
  bookingId: number | null;
  responsePayload: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewAttemptInput {
  tripId: number | string;
  pickupStopId: number | string;
  tripDate: string;
  routeName: string;
  pickupStopName: string;
  direction: string;
}

interface RawRow {
  id: number;
  trip_id: string;
  pickup_stop_id: string;
  trip_date: string;
  route_name: string;
  pickup_stop_name: string;
  direction: string;
  status: BookingStatus;
  booking_code: string | null;
  booking_id: number | null;
  response_payload: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: RawRow): BookingAttempt {
  return {
    id: row.id,
    tripId: row.trip_id,
    pickupStopId: row.pickup_stop_id,
    tripDate: row.trip_date,
    routeName: row.route_name,
    pickupStopName: row.pickup_stop_name,
    direction: row.direction,
    status: row.status,
    bookingCode: row.booking_code,
    bookingId: row.booking_id,
    responsePayload: row.response_payload,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class BookingRepository {
  private db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    }

    this.db = new DatabaseSync(dbPath);
    this.initSchema();
    this.secureFilePermissions();
  }

  private secureFilePermissions(): void {
    if (this.dbPath !== ":memory:" && process.platform !== "win32") {
      try {
        fs.chmodSync(this.dbPath, 0o600);
      } catch {
        // Ignored if file creation is pending or not permitted
      }
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS booking_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id TEXT NOT NULL,
        pickup_stop_id TEXT NOT NULL,
        trip_date TEXT NOT NULL,
        route_name TEXT NOT NULL,
        pickup_stop_name TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        booking_code TEXT,
        booking_id INTEGER,
        response_payload TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attempts_trip_date ON booking_attempts (trip_id, trip_date);
      CREATE INDEX IF NOT EXISTS idx_attempts_status ON booking_attempts (status);
      CREATE INDEX IF NOT EXISTS idx_attempts_date_dir ON booking_attempts (trip_date, direction, status);
    `);
  }

  /**
   * Retrieves the latest attempt for a given trip ID (and optional date).
   */
  getLatestAttemptForTrip(tripId: number | string, tripDate?: string): BookingAttempt | null {
    const tid = String(tripId);
    let row: RawRow | undefined;
    if (tripDate) {
      const stmt = this.db.prepare(
        "SELECT * FROM booking_attempts WHERE trip_id = ? AND trip_date = ? ORDER BY id DESC LIMIT 1"
      );
      row = stmt.get(tid, tripDate) as RawRow | undefined;
    } else {
      const stmt = this.db.prepare(
        "SELECT * FROM booking_attempts WHERE trip_id = ? ORDER BY id DESC LIMIT 1"
      );
      row = stmt.get(tid) as RawRow | undefined;
    }
    return row ? mapRow(row) : null;
  }

  /**
   * Checks whether a booking attempt is already active, confirmed, or uncertain for this trip.
   * If an attempt is UNCERTAIN, automatic retries are blocked until manual reconciliation.
   */
  hasActiveOrConfirmedBooking(tripId: number | string, tripDate?: string): { blocked: boolean; reason?: string } {
    const latest = this.getLatestAttemptForTrip(tripId, tripDate);
    if (!latest) {
      return { blocked: false };
    }

    if (latest.status === "CONFIRMED") {
      return {
        blocked: true,
        reason: `Trip ${tripId} is already confirmed (Booking Code: ${latest.bookingCode ?? "N/A"}).`
      };
    }

    if (latest.status === "PENDING") {
      return {
        blocked: true,
        reason: `Trip ${tripId} has a booking submission currently in progress.`
      };
    }

    if (latest.status === "UNCERTAIN") {
      return {
        blocked: true,
        reason: `Trip ${tripId} outcome is UNCERTAIN from a prior timeout/network failure. Manual reconciliation is required before retrying.`
      };
    }

    return { blocked: false };
  }

  /**
   * Checks if there is already a confirmed booking for the specified date and direction.
   */
  hasConfirmedBookingForDate(tripDate: string, direction: string): boolean {
    const stmt = this.db.prepare(
      "SELECT id FROM booking_attempts WHERE trip_date = ? AND direction = ? AND status = 'CONFIRMED' LIMIT 1"
    );
    const row = stmt.get(tripDate, direction);
    return row !== undefined;
  }

  /**
   * Records the start of a booking attempt atomically, locking out concurrent submissions.
   */
  createPendingAttempt(input: NewAttemptInput): number {
    const tid = String(input.tripId);
    const stopId = String(input.pickupStopId);
    const check = this.hasActiveOrConfirmedBooking(input.tripId, input.tripDate);
    if (check.blocked) {
      throw new Error(`Cannot create booking attempt: ${check.reason}`);
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO booking_attempts (
        trip_id, pickup_stop_id, trip_date, route_name, pickup_stop_name, direction,
        status, booking_code, booking_id, response_payload, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, NULL, NULL, ?, ?)
    `);

    const result = stmt.run(
      tid,
      stopId,
      input.tripDate,
      input.routeName,
      input.pickupStopName,
      input.direction,
      now,
      now
    );

    const insertId = Number(result.lastInsertRowid);
    log.info("Recorded pending booking attempt in database.", {
      attemptId: insertId,
      tripId: tid,
      pickupStopId: stopId,
      date: input.tripDate
    });
    return insertId;
  }

  markConfirmed(
    attemptId: number,
    bookingCode: string,
    bookingId?: number | null,
    responsePayload?: unknown
  ): void {
    const now = new Date().toISOString();
    const payloadStr = responsePayload ? JSON.stringify(responsePayload) : null;
    const stmt = this.db.prepare(`
      UPDATE booking_attempts
      SET status = 'CONFIRMED',
          booking_code = ?,
          booking_id = ?,
          response_payload = ?,
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(bookingCode, bookingId ?? null, payloadStr, now, attemptId);
    log.info("Booking attempt marked CONFIRMED in database.", {
      attemptId,
      bookingCode,
      bookingId
    });
  }

  markFailed(attemptId: number, errorMessage: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE booking_attempts
      SET status = 'FAILED',
          error_message = ?,
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(errorMessage, now, attemptId);
    log.warn("Booking attempt marked FAILED in database.", {
      attemptId,
      error: errorMessage
    });
  }

  /**
   * Marks an attempt as UNCERTAIN after a network timeout or connection drop.
   * This guarantees it is never blindly retried.
   */
  markUncertain(attemptId: number, errorMessage: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE booking_attempts
      SET status = 'UNCERTAIN',
          error_message = ?,
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(errorMessage, now, attemptId);
    log.error("Booking attempt marked UNCERTAIN in database. Automatic retries blocked.", {
      attemptId,
      error: errorMessage
    });
  }

  listAttempts(limit = 50): BookingAttempt[] {
    const stmt = this.db.prepare("SELECT * FROM booking_attempts ORDER BY id DESC LIMIT ?");
    const rows = stmt.all(limit) as unknown as RawRow[];
    return rows.map(mapRow);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore if already closed
    }
  }
}
