import type { BrowserContext } from "playwright";
import { config } from "../config.js";
import { log } from "../log.js";
import { persistStorageState } from "../runtime.js";

interface RefreshResponse {
  success?: boolean;
  message?: string;
  data?: {
    accessToken?: string;
    tokenType?: string;
  };
}

export class SessionManager {
  private accessToken: string | null = null;
  private expiresAtMs = 0;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly context: BrowserContext) {}

  private decodeExpiry(token: string): number {
    try {
      const payload = token.split(".")[1];
      if (!payload) return Date.now() + 5 * 60_000;
      const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
      const decoded = JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as { exp?: number };
      return typeof decoded.exp === "number"
        ? decoded.exp * 1000
        : Date.now() + 5 * 60_000;
    } catch {
      return Date.now() + 5 * 60_000;
    }
  }

  async refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!force && this.accessToken && Date.now() < this.expiresAtMs - 60_000) return;

    this.refreshing = (async () => {
      // BrowserContext.request shares cookies with this context and processes Set-Cookie.
      const response = await this.context.request.post(
        `${config.baseUrl}/api/v1/auth/refresh`,
        {
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          failOnStatusCode: false,
          timeout: 15_000
        }
      );

      if (!response.ok()) {
        this.accessToken = null;
        throw new Error(`ITI refresh failed with HTTP ${response.status()}. Re-authenticate using npm run login.`);
      }

      const body = await response.json() as RefreshResponse;
      const token = body.data?.accessToken;
      if (!body.success || !token) {
        this.accessToken = null;
        throw new Error("Refresh response did not contain data.accessToken.");
      }

      this.accessToken = token;
      this.expiresAtMs = this.decodeExpiry(token);
      log.info("ITI session refreshed; access token retained in memory only.");

      // Persist rotated cookies to data/storage-state.json
      await persistStorageState(this.context);
    })().finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }

  async getAccessToken(): Promise<string> {
    await this.refresh();
    if (!this.accessToken) throw new Error("No access token available.");
    return this.accessToken;
  }

  invalidate(): void {
    this.accessToken = null;
    this.expiresAtMs = 0;
  }
}
