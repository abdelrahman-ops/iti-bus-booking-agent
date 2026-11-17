import { TelegramNotifier } from "./notifications/notifier.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  console.log("==================================================");
  console.log("       NOTIFICATION SERVICE CONNECTIVITY TEST     ");
  console.log("==================================================\n");

  const notifier = new TelegramNotifier();
  let anySuccess = false;

  // 1. Test Telegram
  console.log("[1] Testing Telegram Bot Connectivity:");
  const hasTelegram = Boolean(config.telegramBotToken && config.telegramChatId);
  console.log(`    • Configured: ${hasTelegram}`);

  if (hasTelegram) {
    const cleanToken = config.telegramBotToken.replace(/^bot/i, "").trim();
    console.log(`    • Bot Token:  ${cleanToken.slice(0, 6)}... (length: ${cleanToken.length})`);
    console.log(`    • Chat ID:    ${config.telegramChatId.trim()}`);
    console.log(`    • API Base:   ${config.telegramApiBase}`);

    try {
      // Diagnostic 1: Verify Bot identity via getMe (30s timeout)
      const getMeUrl = `${config.telegramApiBase}/bot${cleanToken}/getMe`;
      const getMeRes = await fetch(getMeUrl, { signal: AbortSignal.timeout(30_000) });
      const getMeData = (await getMeRes.json()) as { ok: boolean; result?: { username: string } };

      if (getMeRes.ok && getMeData.ok) {
        console.log(`    ✅ Token verified! Bot username: @${getMeData.result?.username}`);

        // Diagnostic 2: Send test message
        const sendRes = await notifier.sendTelegramMessage(
          "🤖 <b>ITI Bus Agent</b>: Telegram notification test successful! Connected to your bus booker."
        );
        if (sendRes) {
          console.log("    ✅ Test message delivered to your Telegram chat!");
          anySuccess = true;
        } else {
          console.log("    ⚠️ Failed to deliver message. Check if you have pressed /start in your bot chat.");
        }
      } else {
        console.log("    ❌ Telegram rejected token:", JSON.stringify(getMeData));
      }
    } catch (err) {
      const cause = (err as any)?.cause;
      const causeMsg = cause instanceof Error ? cause.message : String(cause || "");
      console.log(`    ⚠️ Telegram network error: ${err instanceof Error ? err.message : String(err)}`);
      if (causeMsg) {
        console.log(`       Cause: ${causeMsg}`);
      }
      console.log("       (Note: Direct connections to api.telegram.org may be dropped by Egyptian ISPs or throttled on public cloud IP ranges).");
    }
  } else {
    console.log("    ℹ️ Telegram token or chat ID is not configured.");
  }

  // 2. Test WhatsApp via CallMeBot
  console.log("\n[2] Testing WhatsApp (CallMeBot):");
  const hasWhatsApp = Boolean(config.whatsappPhone && config.whatsappApiKey);
  console.log(`    • Configured: ${hasWhatsApp}`);
  if (hasWhatsApp) {
    console.log(`    • Phone:      ${config.whatsappPhone}`);
    const res = await notifier.sendWhatsAppMessage(
      "🤖 ITI Bus Agent: WhatsApp notification test successful!"
    );
    if (res) {
      console.log("    ✅ WhatsApp message delivered to your phone!");
      anySuccess = true;
    } else {
      console.log("    ❌ Failed to deliver WhatsApp message via CallMeBot.");
    }
  } else {
    console.log("    ℹ️ WhatsApp is not configured.");
  }

  // 3. Test Discord Webhook (if configured)
  if (config.discordWebhookUrl) {
    console.log("\n[3] Testing Discord Webhook:");
    const discordRes = await notifier.sendDiscordMessage(
      "🤖 **ITI Bus Agent**: Discord notification test successful! Connected to bus booker."
    );
    if (discordRes) {
      console.log("    ✅ Discord message delivered successfully!");
      anySuccess = true;
    } else {
      console.log("    ❌ Failed to deliver Discord webhook message.");
    }
  }

  // 4. Test ntfy.sh (Instant phone push notifications)
  const ntfyTopic = (config.ntfyTopic || "iti-bus-01015372301").trim();
  console.log("\n[4] Testing Instant Phone Push Notifications (ntfy.sh):");
  console.log(`    • Topic:      https://ntfy.sh/${ntfyTopic}`);
  const ntfyRes = await notifier.sendNtfyMessage(
    "ITI Bus Agent",
    "🎉 Push notifications active! You will receive alerts here when trips are booked."
  );
  if (ntfyRes) {
    console.log("    ✅ Push notification published successfully!");
    console.log(`    📲 Open this link on your phone to receive instant alerts:`);
    console.log(`       👉 https://ntfy.sh/${ntfyTopic}`);
    console.log(`       (Works in your phone browser or the free ntfy Android/iOS app - zero registration required!)`);
    anySuccess = true;
  } else {
    console.log("    ❌ Failed to publish to ntfy.sh.");
  }

  console.log("\n==================================================");
  if (anySuccess) {
    console.log("✅ At least one notification channel is active and verified!");
  } else {
    console.error("❌ No notification channels succeeded.");
    process.exitCode = 1;
  }
}

await main();
