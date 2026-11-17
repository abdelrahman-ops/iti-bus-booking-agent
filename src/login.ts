import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { openPersistentContext } from "./runtime.js";
import { SessionManager } from "./auth/session.js";
import { config } from "./config.js";
import { log } from "./log.js";

const context = await openPersistentContext(false);

try {
  const page = context.pages()[0] ?? (await context.newPage());
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

  // Export fresh storage state immediately
  const statePath = path.resolve("./data/storage-state.json");
  await context.storageState({ path: statePath });
  const rawJson = fs.readFileSync(statePath, "utf-8");
  const b64 = Buffer.from(rawJson, "utf-8").toString("base64");

  console.log("\n=======================================================");
  console.log("       ITI SESSION READY FOR GITHUB SECRETS            ");
  console.log("=======================================================\n");
  console.log("✅ Fresh session saved to: data/storage-state.json\n");
  console.log("👉 Copy the single-line string below into your GitHub Secret:");
  console.log("   Repo -> Settings -> Secrets and variables -> Actions");
  console.log("   Name: ITI_STORAGE_STATE\n");
  console.log(b64);
  console.log("\n=======================================================\n");
} finally {
  await context.close();
}
