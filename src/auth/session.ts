import type { BrowserContext } from "playwright";
import { config } from "../config.js";
import { log } from "../log.js";
import { persistStorageState } from "../runtime.js";
import { getItiApiHeaders } from "../api/version.js";

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

  async loginWithCredentials(): Promise<void> {
    if (!config.itiEmail || !config.itiPassword) {
      throw new Error("ITI_EMAIL and ITI_PASSWORD are required for automated credential login.");
    }

    log.info("Attempting automated login via ITI_EMAIL and ITI_PASSWORD credentials...");
    const headers = await getItiApiHeaders({ "Content-Type": "application/json" });
    const response = await this.context.request.post(
      `${config.baseUrl}/api/v1/auth/login`,
      {
        headers,
        data: {
          email: config.itiEmail,
          password: config.itiPassword
        },
        failOnStatusCode: false,
        timeout: 15_000
      }
    );

    if (!response.ok()) {
      const errText = await response.text();
      this.accessToken = null;
      throw new Error(`ITI automated login failed with HTTP ${response.status()}: ${errText}`);
    }

    const body = await response.json() as RefreshResponse;
    const token = body.data?.accessToken;
    if (!token) {
      this.accessToken = null;
      throw new Error("Login response did not contain data.accessToken.");
    }

    this.accessToken = token;
    this.expiresAtMs = this.decodeExpiry(token);
    log.info("ITI credentials login succeeded. Session refreshed and persisted.");
    await persistStorageState(this.context);
  }

  async refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!force && this.accessToken && Date.now() < this.expiresAtMs - 60_000) return;

    this.refreshing = (async () => {
      // BrowserContext.request shares cookies with this context and processes Set-Cookie.
      const headers = await getItiApiHeaders({ "Content-Type": "application/json" });
      const response = await this.context.request.post(
        `${config.baseUrl}/api/v1/auth/refresh`,
        {
          headers,
          failOnStatusCode: false,
          timeout: 15_000
        }
      );

      if (!response.ok()) {
        if (config.itiEmail && config.itiPassword) {
          log.warn(`Token refresh failed with HTTP ${response.status()}. Falling back to credential auto-login...`);
          await this.loginWithCredentials();
          return;
        }
        this.accessToken = null;
        throw new Error(`ITI refresh failed with HTTP ${response.status()}. Re-authenticate using npm run login or set ITI_EMAIL and ITI_PASSWORD.`);
      }

      const body = await response.json() as RefreshResponse;
      const token = body.data?.accessToken;
      if (!body.success || !token) {
        if (config.itiEmail && config.itiPassword) {
          log.warn("Refresh body lacked access token. Falling back to credential auto-login...");
          await this.loginWithCredentials();
          return;
        }
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
