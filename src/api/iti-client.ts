import type { APIResponse, BrowserContext } from "playwright";
import { config } from "../config.js";
import { SessionManager } from "../auth/session.js";
import { log } from "../log.js";

export interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data: T;
  timestamp?: string;
}

export interface ConfirmedBookingResponseData {
  id: number;
  bookingCode: string;
  tripId: number;
  routeName: string;
  tripDate: string;
  departureTime?: string;
  pickupLocation: string;
  pickupStopName?: string;
  seatNumber?: string | number | null;
  status: string;
  isReturnTrip?: boolean;
}

export interface BookingHttpResult {
  status: number;
  body: unknown;
  rawHeaders: Record<string, string>;
}

export interface RouteStop {
  id: number;
  routeId: number;
  stopName: string;
  stopOrder: number;
  arrivalTime?: string;
}

export interface UserBookingRecord {
  id: number;
  bookingCode: string;
  tripId: number;
  routeName: string;
  tripDate: string;
  departureTime?: string;
  pickupLocation: string;
  pickupStopName?: string;
  status: string;
  bookedAt?: string;
  isReturnTrip?: boolean;
}

export class NetworkTimeoutError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "NetworkTimeoutError";
  }
}

export class RateLimitError extends Error {
  constructor(message: string, public readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class ItiClient {
  private readonly requestTimestamps: number[] = [];
  private readonly routeStopsCache = new Map<number, RouteStop[]>();
  private lastRequestTime = 0;

  constructor(
    private readonly context: BrowserContext,
    private readonly session: SessionManager
  ) {}

  /**
   * Enforces rate limiting (default 30 requests per 60 seconds) and minimum pacing.
   */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const windowStart = now - config.rateLimitWindowMs;

    // Prune old timestamps
    while (this.requestTimestamps.length > 0 && (this.requestTimestamps[0] ?? 0) < windowStart) {
      this.requestTimestamps.shift();
    }

    // Check sliding window limit
    if (this.requestTimestamps.length >= config.rateLimitMaxRequests) {
      const oldest = this.requestTimestamps[0] ?? windowStart;
      const waitMs = Math.max(100, config.rateLimitWindowMs - (now - oldest) + 50);
      log.warn("Rate limit threshold approached. Pacing requests...", {
        activeInWindow: this.requestTimestamps.length,
        waitMs
      });
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }

    // Minimum inter-request pacing (300ms)
    const timeSinceLast = Date.now() - this.lastRequestTime;
    if (timeSinceLast < 300) {
      await new Promise<void>((resolve) => setTimeout(resolve, 300 - timeSinceLast));
    }

    const currentTimestamp = Date.now();
    this.requestTimestamps.push(currentTimestamp);
    this.lastRequestTime = currentTimestamp;
  }

  /**
   * Parses Retry-After header from 429 response, returns wait time in ms.
   */
  private parseRetryAfter(response: APIResponse): number {
    const header = response.headers()["retry-after"];
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
      }
      const dateMs = Date.parse(header);
      if (!Number.isNaN(dateMs) && dateMs > Date.now()) {
        return dateMs - Date.now();
      }
    }
    return 30_000; // Default 30s backoff
  }

  async getAvailableTrips(date: string): Promise<unknown[]> {
    const executeRequest = async (): Promise<APIResponse> => {
      await this.throttle();
      const token = await this.session.getAccessToken();
      try {
        return await this.context.request.get(
          `${config.baseUrl}/api/v1/trips/available?date=${encodeURIComponent(date)}`,
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`
            },
            timeout: config.requestTimeoutMs,
            failOnStatusCode: false
          }
        );
      } catch (error) {
        throw new NetworkTimeoutError(
          `Network timeout or failure fetching available trips for ${date}: ${error instanceof Error ? error.message : String(error)}`,
          error
        );
      }
    };

    let response = await executeRequest();

    // Handle 401 Unauthorized: refresh token and retry once
    if (response.status() === 401) {
      log.warn("Available trips returned HTTP 401. Refreshing token and retrying once...");
      this.session.invalidate();
      await this.session.refresh(true);
      response = await executeRequest();
    }

    // Handle 429 Too Many Requests: backoff and retry once
    if (response.status() === 429) {
      const waitMs = this.parseRetryAfter(response);
      log.warn(`Rate limit HTTP 429 received. Backing off for ${waitMs / 1000}s...`);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      response = await executeRequest();
    }

    if (!response.ok()) {
      throw new Error(`Available trips request failed for ${date}: HTTP ${response.status()}`);
    }

    const body = (await response.json()) as Partial<ApiEnvelope<unknown>>;
    if (body.success !== true || !Array.isArray(body.data)) {
      throw new Error(
        `Unexpected available-trips response for ${date}; expected success=true and data=[].`
      );
    }

    return body.data;
  }

  /**
   * Submits booking creation request to ITI API:
   * POST /api/v1/bookings
   * Body: { tripId, pickupStopId }
   *
   * Distinguishes network timeout errors from HTTP responses.
   */
  async createBooking(tripId: number, pickupStopId: number): Promise<BookingHttpResult> {
    const executePost = async (): Promise<APIResponse> => {
      await this.throttle();
      const token = await this.session.getAccessToken();
      try {
        return await this.context.request.post(`${config.baseUrl}/api/v1/bookings`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          data: {
            tripId,
            pickupStopId
          },
          timeout: config.requestTimeoutMs,
          failOnStatusCode: false
        });
      } catch (error) {
        // Critical: Mark network errors distinctly so caller knows outcome is UNCERTAIN
        throw new NetworkTimeoutError(
          `Network failure or timeout during booking POST: ${error instanceof Error ? error.message : String(error)}`,
          error
        );
      }
    };

    let response = await executePost();

    // Handle 401: Refresh and retry once ONLY if request was cleanly rejected with 401 before processing
    if (response.status() === 401) {
      log.warn("Booking request returned HTTP 401. Refreshing token and retrying once...");
      this.session.invalidate();
      await this.session.refresh(true);
      response = await executePost();
    }

    // Handle 429 Too Many Requests
    if (response.status() === 429) {
      const waitMs = this.parseRetryAfter(response);
      log.warn(`Booking endpoint returned HTTP 429. Backing off for ${waitMs / 1000}s...`);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      response = await executePost();
    }

    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch {
      try {
        parsedBody = await response.text();
      } catch {
        parsedBody = null;
      }
    }

    return {
      status: response.status(),
      body: parsedBody,
      rawHeaders: response.headers()
    };
  }

  /**
   * Fetches stops for a given route (e.g. GET /api/v1/routes/18/stops).
   * Caches results in memory to avoid redundant calls.
   */
  async getRouteStops(routeId: number): Promise<RouteStop[]> {
    if (this.routeStopsCache.has(routeId)) {
      return this.routeStopsCache.get(routeId)!;
    }

    await this.throttle();
    const token = await this.session.getAccessToken();

    const response = await this.context.request.get(
      `${config.baseUrl}/api/v1/routes/${routeId}/stops`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        },
        timeout: config.requestTimeoutMs,
        failOnStatusCode: false
      }
    );

    if (!response.ok()) {
      throw new Error(`Failed to fetch stops for route ${routeId}: HTTP ${response.status()}`);
    }

    const body = (await response.json()) as Partial<ApiEnvelope<RouteStop[]>>;
    if (body.success && Array.isArray(body.data)) {
      this.routeStopsCache.set(routeId, body.data);
      return body.data;
    }
    return [];
  }

  /**
   * Retrieves the user's booking history from confirmed endpoint: GET /api/v1/bookings.
   */
  async getUserBookings(): Promise<UserBookingRecord[]> {
    await this.throttle();
    const token = await this.session.getAccessToken();

    const response = await this.context.request.get(`${config.baseUrl}/api/v1/bookings`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      timeout: config.requestTimeoutMs,
      failOnStatusCode: false
    });

    if (!response.ok()) {
      throw new Error(`Failed to fetch user bookings: HTTP ${response.status()}`);
    }

    const body = (await response.json()) as {
      success?: boolean;
      data?: { content?: UserBookingRecord[] };
    };

    if (body.success && Array.isArray(body.data?.content)) {
      return body.data.content;
    }
    return [];
  }
}
