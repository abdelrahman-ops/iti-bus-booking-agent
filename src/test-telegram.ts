import { TelegramNotifier } from "./notifications/notifier.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  console.log("==================================================");
  console.log("       TELEGRAM BOT CONNECTIVITY TEST             ");
  console.log("==================================================\n");

  const notifier = new TelegramNotifier();

  const hasTelegram = Boolean(config.telegramBotToken && config.telegramChatId);
  console.log(`• Telegram Configured: ${hasTelegram}`);

  if (!hasTelegram) {
    console.error("❌ Telegram token or chat ID is missing in configuration.");
    process.exitCode = 1;
    return;
  }

  const cleanToken = config.telegramBotToken.replace(/^bot/i, "").trim();
  console.log(`• Bot Token:           ${cleanToken.slice(0, 6)}... (length: ${cleanToken.length})`);
  console.log(`• Chat ID:             ${config.telegramChatId.trim()}`);
  console.log(`• API Base:            ${config.telegramApiBase}\n`);

  try {
    // 1. Verify Bot identity via getMe
    console.log("1. Verifying bot credentials via getMe...");
    const getMeUrl = `${config.telegramApiBase}/bot${cleanToken}/getMe`;
    const getMeRes = await fetch(getMeUrl, { signal: AbortSignal.timeout(30_000) });
    const getMeData = (await getMeRes.json()) as { ok: boolean; result?: { username: string } };

    if (!getMeRes.ok || !getMeData.ok) {
      console.error("❌ Telegram rejected token:", JSON.stringify(getMeData));
      process.exitCode = 1;
      return;
    }

    console.log(`✅ Token verified! Bot username: @${getMeData.result?.username}\n`);

    // 2. Send test message
    console.log("2. Sending test notification message...");
    const sendRes = await notifier.sendTelegramMessage(
      "🤖 <b>ITI Bus Agent</b>: Telegram notification test successful! Connected to your bus booker."
    );

    if (sendRes) {
      console.log("✅ Message successfully delivered to your Telegram chat!");
      console.log("\n==================================================");
      console.log("🎉 Telegram notification service is 100% operational!");
      console.log("==================================================");
    } else {
      console.error("❌ Failed to deliver message to Telegram chat.");
      process.exitCode = 1;
    }
  } catch (err) {
    const cause = (err as any)?.cause;
    const causeMsg = cause instanceof Error ? cause.message : String(cause || "");
    console.error(`❌ Telegram network error: ${err instanceof Error ? err.message : String(err)}`);
    if (causeMsg) {
      console.error(`   Cause: ${causeMsg}`);
    }
    process.exitCode = 1;
  }
}

await main();
