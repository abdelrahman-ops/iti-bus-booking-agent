import { chromium, type BrowserContext } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";

export const storageStateFile = path.resolve("./data/storage-state.json");

export async function persistStorageState(context: BrowserContext): Promise<void> {
  if (typeof context.storageState !== "function") return;
  try {
    await context.storageState({ path: storageStateFile });
  } catch (err) {
    log.warn("Could not persist storage state to disk.", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function openPersistentContext(headless = config.headless): Promise<BrowserContext> {
  const dir = path.dirname(storageStateFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // 1. If ITI_STORAGE_STATE environment variable is provided (e.g. from GitHub Secrets), restore it
  if (process.env.ITI_STORAGE_STATE) {
    let raw = process.env.ITI_STORAGE_STATE.trim();
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

  // 2. Launch persistent context
  const context = await chromium.launchPersistentContext(config.browserProfileDir, {
    headless,
    acceptDownloads: false,
    serviceWorkers: "allow",
    args: ["--disable-dev-shm-usage"]
  });

  // 3. Inject cookies and localStorage from storage-state.json into context
  if (fs.existsSync(storageStateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(storageStateFile, "utf-8"));
      if (Array.isArray(state.cookies) && state.cookies.length > 0) {
        await context.addCookies(state.cookies);
        log.info(`Injected ${state.cookies.length} session cookies into browser context.`);
      }

      if (Array.isArray(state.origins)) {
        for (const origin of state.origins) {
          if (origin.origin === config.baseUrl && Array.isArray(origin.localStorage)) {
            await context.addInitScript((entries: Array<{ name: string; value: string }>) => {
              for (const item of entries) {
                try {
                  window.localStorage.setItem(item.name, item.value);
                } catch {
                  // ignore storage errors
                }
              }
            }, origin.localStorage);
          }
        }
      }
    } catch (err) {
      log.warn("Could not inject cookies or storage from storage-state.json", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return context;
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
