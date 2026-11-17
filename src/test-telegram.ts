import { TelegramNotifier } from "./notifications/notifier.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  console.log("Testing Telegram Bot connectivity...");
  console.log(`• Telegram configured: ${Boolean(config.telegramBotToken && config.telegramChatId)}`);

  const notifier = new TelegramNotifier();
  const result = await notifier.testConnection();

  console.log("• Result:", result);

  if (result.success) {
    console.log("✅ Message successfully delivered to your Telegram!");
  } else {
    console.error("❌ Failed to deliver message to Telegram.");
    process.exitCode = 1;
  }
}

await main();
