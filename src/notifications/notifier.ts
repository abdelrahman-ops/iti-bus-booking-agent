import { config } from "../config.js";
import { log } from "../log.js";

export interface ConfirmedBookingDetails {
  bookingCode: string;
  tripId: number | string;
  routeName: string;
  tripDate: string;
  pickupLocation: string;
  departureTime?: string;
  seatNumber?: string | number | null;
}

export interface MatchedTripDetails {
  tripId: number;
  pickupStopId: number;
  routeName: string;
  pickupStopName: string;
  tripDate: string;
  departureTime?: string;
  isReturnTrip: boolean;
}

export interface ReconciliationDetails {
  attemptId: number;
  tripId: number | string;
  tripDate: string;
  routeName: string;
  error: string;
}

export interface Notifier {
  notifyMonitoringStarted(details: Record<string, unknown>): Promise<void>;
  notifyTripMatched(trip: MatchedTripDetails): Promise<void>;
  notifyBookingSubmitted(trip: MatchedTripDetails, attemptId: number): Promise<void>;
  notifyBookingConfirmed(booking: ConfirmedBookingDetails): Promise<void>;
  notifyAuthFailure(reason: string): Promise<void>;
  notifyReconciliationRequired(details: ReconciliationDetails): Promise<void>;
  notifyAlreadyBooked(details: { date: string; bookingCode: string; tripId: string | number; routeName: string }): Promise<void>;
  notifyWindowClosed(details: { reason: string; date: string }): Promise<void>;
}

export class TelegramNotifier implements Notifier {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly isConfigured: boolean;

  constructor(botToken = config.telegramBotToken, chatId = config.telegramChatId) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.isConfigured = Boolean(botToken && chatId);
  }

  async sendTelegramMessage(text: string): Promise<boolean> {
    if (!this.isConfigured) {
      log.info(`[Notification (No Telegram Configured)]\n${text}`);
      return false;
    }

    const token = this.botToken.replace(/^bot/i, "").trim();
    const chatId = this.chatId.trim();

    try {
      const url = `${config.telegramApiBase}/bot${token}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        }),
        signal: AbortSignal.timeout(20_000)
      });

      if (!response.ok) {
        const errorText = await response.text();
        log.warn("Failed to deliver Telegram notification.", {
          status: response.status,
          response: errorText
        });
        return false;
      }
      return true;
    } catch (error) {
      const cause = (error as any)?.cause;
      const causeMsg = cause instanceof Error ? cause.message : String(cause || "");
      const code = (cause as any)?.code || (error as any)?.code || "";
      log.warn("Telegram notification request encountered network error.", {
        error: error instanceof Error ? error.message : String(error),
        cause: causeMsg || undefined,
        code: code || undefined
      });
      return false;
    }
  }

  async sendWhatsAppMessage(text: string): Promise<boolean> {
    if (!config.whatsappPhone || !config.whatsappApiKey) {
      return false;
    }

    try {
      const phone = config.whatsappPhone.replace(/[^0-9]/g, "");
      const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(text)}&apikey=${config.whatsappApiKey.trim()}`;
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(15_000)
      });

      if (!response.ok) {
        log.warn("CallMeBot WhatsApp notification rejected.", {
          status: response.status,
          statusText: response.statusText
        });
        return false;
      }

      log.info(`WhatsApp notification delivered to ${config.whatsappPhone} via CallMeBot.`);
      return true;
    } catch (error) {
      log.warn("CallMeBot WhatsApp notification network error.", {
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  async sendNtfyMessage(title: string, text: string): Promise<boolean> {
    if (!config.ntfyTopic) {
      return false;
    }

    try {
      const url = `https://ntfy.sh/${encodeURIComponent(config.ntfyTopic)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Title: title,
          Priority: "high",
          Tags: "bus"
        },
        body: text,
        signal: AbortSignal.timeout(10_000)
      });

      if (!response.ok) {
        log.warn("ntfy push notification failed.", { status: response.status });
        return false;
      }

      log.info(`Push notification delivered via ntfy.sh topic "${config.ntfyTopic}".`);
      return true;
    } catch (error) {
      log.warn("ntfy push notification network error.", {
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  async broadcastMessage(title: string, htmlText: string): Promise<boolean> {
    const plainText = htmlText
      .replace(/<b>(.*?)<\/b>/g, "*$1*")
      .replace(/<code>(.*?)<\/code>/g, "$1")
      .replace(/<.*?>/g, "");

    const tasks: Promise<boolean>[] = [];

    if (this.isConfigured) {
      tasks.push(this.sendTelegramMessage(htmlText));
    }

    if (config.whatsappPhone && config.whatsappApiKey) {
      tasks.push(this.sendWhatsAppMessage(plainText));
    }

    if (config.ntfyTopic) {
      tasks.push(this.sendNtfyMessage(title, plainText));
    }

    if (tasks.length === 0) {
      log.info(`[Notification (No Channel Configured)]\n${plainText}`);
      return false;
    }

    const results = await Promise.allSettled(tasks);
    return results.some((r) => r.status === "fulfilled" && r.value === true);
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    const success = await this.broadcastMessage(
      "ITI Bus Agent - Test Notification",
      "🤖 <b>ITI Bus Agent</b>: Test notification. Connection established successfully!"
    );
    return success
      ? { success: true, message: "Notification test message delivered successfully." }
      : { success: false, message: "Notification test message delivery failed." };
  }

  async notifyMonitoringStarted(details: Record<string, unknown>): Promise<void> {
    const text = [
      "🚀 <b>ITI Bus Agent: Monitoring Started</b>",
      `• Route: <code>${config.routeKeyword}</code>`,
      `• Pickup: <code>${config.pickupKeyword}</code>`,
      `• Direction: <code>${config.direction}</code>`,
      `• Interval: <code>${config.pollIntervalMs / 1000}s</code>`,
      `• Auto-Book: <code>${config.bookingEnabled ? "ENABLED" : "DISABLED (Dry Run)"}</code>`,
      `• Search Offsets: <code>${config.dateOffsets.join(", ")}</code>`
    ].join("\n");
    await this.broadcastMessage("ITI Bus Agent - Monitoring Started", text);
  }

  async notifyTripMatched(trip: MatchedTripDetails): Promise<void> {
    const text = [
      "🎯 <b>ITI Bus Agent: Matching Trip Found!</b>",
      `• Date: <b>${trip.tripDate}</b>`,
      `• Route: ${trip.routeName}`,
      `• Pickup: ${trip.pickupStopName} (Stop ID: ${trip.pickupStopId})`,
      `• Trip ID: <code>${trip.tripId}</code>`,
      trip.departureTime ? `• Departure: ${trip.departureTime}` : "",
      `• Auto-Book: ${config.bookingEnabled ? "Submitting..." : "OFF (Monitoring only)"}`
    ]
      .filter(Boolean)
      .join("\n");
    await this.broadcastMessage("ITI Bus Agent - Matching Trip Found!", text);
  }

  async notifyBookingSubmitted(trip: MatchedTripDetails, attemptId: number): Promise<void> {
    const text = [
      "⏳ <b>ITI Bus Agent: Booking Submitted</b>",
      `• Attempt ID: <code>${attemptId}</code>`,
      `• Trip ID: <code>${trip.tripId}</code>`,
      `• Pickup Stop ID: <code>${trip.pickupStopId}</code>`,
      `• Date: ${trip.tripDate}`,
      `• Route: ${trip.routeName}`,
      "Awaiting server confirmation..."
    ].join("\n");
    await this.broadcastMessage("ITI Bus Agent - Booking Submitted", text);
  }

  async notifyBookingConfirmed(booking: ConfirmedBookingDetails): Promise<void> {
    const text = [
      "🎉 <b>ITI Bus Agent: BOOKING CONFIRMED!</b>",
      `• Booking Code: <b><code>${booking.bookingCode}</code></b>`,
      `• Date: <b>${booking.tripDate}</b>`,
      `• Route: ${booking.routeName}`,
      `• Pickup: ${booking.pickupLocation}`,
      `• Trip ID: <code>${booking.tripId}</code>`,
      booking.departureTime ? `• Departure: ${booking.departureTime}` : "",
      booking.seatNumber ? `• Seat: ${booking.seatNumber}` : "",
      "Status: <b>CONFIRMED</b> ✅"
    ]
      .filter(Boolean)
      .join("\n");
    await this.broadcastMessage("ITI Bus Agent - BOOKING CONFIRMED! 🎉", text);
  }

  async notifyAuthFailure(reason: string): Promise<void> {
    const text = [
      "⚠️ <b>ITI Bus Agent: Authentication Failure!</b>",
      `Reason: ${reason}`,
      "The refresh session has expired or is invalid. Please run <code>npm run login</code> to re-authenticate."
    ].join("\n");
    await this.broadcastMessage("ITI Bus Agent - Auth Failure", text);
  }

  async notifyReconciliationRequired(details: ReconciliationDetails): Promise<void> {
    const text = [
      "🚨 <b>ITI Bus Agent: ACTION REQUIRED - Uncertain Booking Outcome</b>",
      `• Trip ID: <code>${details.tripId}</code>`,
      `• Date: <b>${details.tripDate}</b>`,
      `• Route: ${details.routeName}`,
      `• Attempt ID: <code>${details.attemptId}</code>`,
      `• Error: ${details.error}`,
      "",
      "⚠️ A network timeout or connection reset occurred while waiting for the booking response.",
      "The booking may or may not have been created on the server.",
      "<b>Automatic retries have been BLOCKED.</b>",
      "Please check your ITI booking dashboard manually to reconcile."
    ].join("\n");
    await this.broadcastMessage("ITI Bus Agent - Action Required", text);
  }

  async notifyAlreadyBooked(details: {
    date: string;
    bookingCode: string;
    tripId: string | number;
    routeName: string;
  }): Promise<void> {
    const text = [
      "ℹ️ <b>ITI Bus Agent: Already Booked</b>",
      `• Date: <b>${details.date}</b>`,
      `• Booking Code: <b><code>${details.bookingCode}</code></b>`,
      `• Route: ${details.routeName}`,
      `• Trip ID: <code>${details.tripId}</code>`,
      "No additional booking action is needed for this date."
    ].join("\n");
    await this.broadcastMessage("ITI Bus Agent - Already Booked", text);
  }

  async notifyWindowClosed(details: { reason: string; date: string }): Promise<void> {
    const text = [
      "ℹ️ <b>ITI Bus Agent: Booking Window Ended</b>",
      `• Date: <b>${details.date}</b>`,
      `• Outcome: ${details.reason}`,
      "Daily monitoring session completed cleanly."
    ].join("\n");
    await this.broadcastMessage("ITI Bus Agent - Window Closed", text);
  }
}
