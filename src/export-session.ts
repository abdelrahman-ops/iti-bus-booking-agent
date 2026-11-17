import fs from "node:fs";
import path from "node:path";
import { openPersistentContext } from "./runtime.js";

async function exportSession(): Promise<void> {
  const context = await openPersistentContext(true);
  const stateFile = path.resolve("./data/storage-state.json");
  await context.storageState({ path: stateFile });
  await context.close();

  const jsonStr = fs.readFileSync(stateFile, "utf-8");
  const b64 = Buffer.from(jsonStr, "utf-8").toString("base64");

  console.log("\n=======================================================");
  console.log("       ITI SESSION EXPORT FOR GITHUB SECRETS          ");
  console.log("=======================================================\n");
  console.log("✅ Successfully exported to: data/storage-state.json\n");
  console.log("👉 Copy the single-line string below and paste it into:");
  console.log("   GitHub Repo -> Settings -> Secrets and variables -> Actions");
  console.log("   Secret Name: ITI_STORAGE_STATE\n");
  console.log(b64);
  console.log("\n=======================================================\n");
}

await exportSession();
