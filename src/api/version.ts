import { config } from "../config.js";
import { log } from "../log.js";

let cachedBuildNumber = "1";
let lastFetchedMs = 0;

/**
 * Dynamically queries https://schedule.iti.gov.eg/version.json to get the latest
 * build_number required by the ITI API backend (e.g. X-App-Build header).
 * Falls back to "1" if unreachable or not found.
 */
export async function getAppBuildNumber(): Promise<string> {
  // Cache for 10 minutes to minimize overhead
  if (Date.now() - lastFetchedMs < 10 * 60_000) {
    return cachedBuildNumber;
  }

  try {
    const res = await fetch(`${config.baseUrl}/version.json`, {
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) {
      const data = (await res.json()) as { build_number?: string | number };
      if (data.build_number != null) {
        cachedBuildNumber = String(data.build_number).trim();
        lastFetchedMs = Date.now();
      }
    }
  } catch (err) {
    log.warn("Could not fetch remote version.json; using fallback build number.", {
      buildNumber: cachedBuildNumber,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return cachedBuildNumber;
}

/**
 * Returns base HTTP headers required by ITI API backend, including
 * X-App-Build and Accept: application/json.
 */
export async function getItiApiHeaders(
  additional: Record<string, string> = {}
): Promise<Record<string, string>> {
  const buildNumber = await getAppBuildNumber();
  return {
    Accept: "application/json",
    "X-App-Build": buildNumber,
    ...additional
  };
}
