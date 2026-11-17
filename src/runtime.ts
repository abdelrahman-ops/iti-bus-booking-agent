import { chromium, type BrowserContext, type LaunchOptions } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";

const storageStateFile = path.resolve("./data/storage-state.json");

export async function openPersistentContext(headless = config.headless): Promise<BrowserContext> {
  // If ITI_STORAGE_STATE environment variable is provided (e.g. from GitHub Secrets), restore it
  if (process.env.ITI_STORAGE_STATE) {
    const dir = path.dirname(storageStateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    let raw = process.env.ITI_STORAGE_STATE.trim();
    // Support base64 or raw JSON
    if (!raw.startsWith("{")) {
      try {
        raw = Buffer.from(raw, "base64").toString("utf-8");
      } catch {
        // use as-is
      }
    }
    fs.writeFileSync(storageStateFile, raw, { mode: 0o600 });
    log.info("Restored authentication session from ITI_STORAGE_STATE environment variable.");
  }

  const options: Record<string, unknown> = {
    headless,
    acceptDownloads: false,
    serviceWorkers: "allow",
    args: ["--disable-dev-shm-usage"]
  };

  if (fs.existsSync(storageStateFile)) {
    options.storageState = storageStateFile;
    log.info("Loading session storage state from data/storage-state.json");
  }

  return chromium.launchPersistentContext(config.browserProfileDir, options);
}

export async function validateDashboard(context: BrowserContext): Promise<void> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${config.baseUrl}${config.dashboardPath}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000
  });
  log.info("Opened ITI dashboard in browser profile.", {
    url: page.url()
  });
}
