import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { openPersistentContext } from "./runtime.js";
import { SessionManager } from "./auth/session.js";
import { config } from "./config.js";
import { log } from "./log.js";

const context = await openPersistentContext(false);

try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${config.baseUrl}${config.dashboardPath}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000
  });

  log.info("Complete ITI login manually in the opened browser. Do not share credentials or tokens.");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  await rl.question("After you reach the authenticated ITI dashboard, press Enter here...");
  rl.close();

  const session = new SessionManager(context);
  await session.refresh(true);
  log.info("Login bootstrap validated. Persistent browser profile is ready.");
} finally {
  await context.close();
}
