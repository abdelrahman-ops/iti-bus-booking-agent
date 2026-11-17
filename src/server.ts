import http from "node:http";
import { openPersistentContext } from "./runtime.js";
import { SessionManager } from "./auth/session.js";
import { ItiClient } from "./api/iti-client.js";
import { BookingRepository } from "./storage/booking-repository.js";
import { TelegramNotifier } from "./notifications/notifier.js";
import { BookingEngine } from "./booking/booking-engine.js";
import { formatCairoDateTime, cairoDateAtOffset } from "./dates.js";
import { config } from "./config.js";
import { log } from "./log.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

async function startServer(): Promise<void> {
  log.info("Starting ITI Bus Agent Frontend Controller on port " + PORT + "...");
  const context = await openPersistentContext(true);
  const session = new SessionManager(context);
  const repository = new BookingRepository(config.databasePath);
  const notifier = new TelegramNotifier();
  const client = new ItiClient(context, session);
  const bookingEngine = new BookingEngine(client, repository, notifier, true);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API: System Status
    if (url.pathname === "/api/status" && req.method === "GET") {
      try {
        const today = cairoDateAtOffset(0);
        const confirmedToday = repository.getConfirmedBookingForDate(today, config.direction);
        const history = await client.getUserBookings().catch(() => []);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            cairoTime: formatCairoDateTime(),
            today,
            config: {
              routeKeyword: config.routeKeyword,
              pickupKeyword: config.pickupKeyword,
              direction: config.direction,
              dailyStartTime: config.dailyStartTime,
              bookingEnabled: config.bookingEnabled
            },
            confirmedToday,
            recentBookings: history.slice(0, 5)
          })
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: String(err) }));
      }
      return;
    }

    // API: Fetch Available Trips
    if (url.pathname === "/api/trips" && req.method === "GET") {
      try {
        const today = cairoDateAtOffset(0);
        const trips = await client.getAvailableTrips(today);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, date: today, trips }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: String(err) }));
      }
      return;
    }

    // API: Book a Specific Trip Manually
    if (url.pathname === "/api/book" && req.method === "POST") {
      let bodyStr = "";
      req.on("data", (chunk) => (bodyStr += chunk));
      req.on("end", async () => {
        try {
          const body = JSON.parse(bodyStr || "{}");
          const tripId = Number(body.tripId);
          if (!tripId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Missing tripId" }));
            return;
          }

          const today = cairoDateAtOffset(0);
          const rawTrips = (await client.getAvailableTrips(today)) as Array<Record<string, any>>;
          const target = rawTrips.find((t) => Number(t.id) === tripId);
          if (!target) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Trip not found for today" }));
            return;
          }

          // Resolve pickup stop if needed
          let stopId = Number(target.pickupStopId ?? 0);
          let stopName = String(target.pickupStopName ?? "");
          if (target.requiresPickupSelection && !stopId && target.routeId) {
            const stops = await client.getRouteStops(Number(target.routeId));
            const matchedStop = stops.find((s) => s.stopName.includes(config.pickupKeyword)) ?? stops[0];
            stopId = matchedStop?.id ?? 0;
            stopName = matchedStop?.stopName ?? "";
          }

          const normalized: import("./matching/trip-matcher.js").NormalizedTrip = {
            tripId: Number(target.id),
            tripDate: String(target.tripDate ?? today),
            routeName: String(target.routeName ?? ""),
            pickupStopId: stopId,
            pickupStopName: stopName,
            isReturnTrip: Boolean(target.isReturnTrip ?? true),
            raw: target
          };
          if (target.departureTime) {
            normalized.departureTime = String(target.departureTime);
          }
          if (typeof target.availableSeats === "number") {
            normalized.availableSeats = target.availableSeats;
          }

          const result = await bookingEngine.bookTrip(normalized);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: result.status === "SUCCESS", result }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: String(err) }));
        }
      });
      return;
    }

    // Serve HTML Dashboard
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ITI Bus Booking - لوحة التحكم</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --card-border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0284c7;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 1000px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 24px;
    }
    h1 { font-size: 1.6rem; color: var(--primary); display: flex; align-items: center; gap: 8px; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 0.8rem;
      font-weight: 600;
    }
    .badge-success { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .badge-danger { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    .badge-warning { background: rgba(245, 158, 11, 0.2); color: var(--warning); }

    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }
    .card h2 { font-size: 1.1rem; margin-bottom: 12px; color: var(--text); display: flex; align-items: center; justify-content: space-between; }

    .btn {
      background: var(--primary);
      color: #0f172a;
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn-sm { padding: 6px 12px; font-size: 0.85rem; }
    .btn-disabled { opacity: 0.5; cursor: not-allowed; }

    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: right; padding: 12px; border-bottom: 1px solid var(--card-border); font-size: 0.95rem; }
    th { color: var(--text-muted); font-weight: 500; font-size: 0.85rem; }
    tr:hover { background: rgba(255, 255, 255, 0.02); }

    .route-selector {
      display: flex;
      gap: 12px;
      margin-top: 8px;
    }
    .route-btn {
      flex: 1;
      padding: 10px;
      background: #0f172a;
      border: 1px solid var(--card-border);
      color: var(--text);
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      text-align: center;
    }
    .route-btn.active {
      border-color: var(--primary);
      background: rgba(56, 189, 248, 0.1);
      color: var(--primary);
    }
    .refresh-spinner { animation: spin 1s linear infinite; }
    @keyframes spin { 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>🚌 ITI Bus - لوحة التحكم والمراقبة</h1>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 4px;" id="cairoTime">جاري التحميل...</p>
      </div>
      <div>
        <button class="btn btn-sm" onclick="loadAll()">🔄 تحديث البيانات</button>
      </div>
    </header>

    <div class="grid">
      <!-- Status Card -->
      <div class="card">
        <h2>حالة الحجز اليوم <span id="bookingStatusBadge" class="badge badge-warning">جاري الفحص...</span></h2>
        <div id="bookingDetails">
          <p style="color: var(--text-muted); font-size: 0.9rem;">فحص الحجوزات المؤكدة...</p>
        </div>
      </div>

      <!-- Quick Route Switcher -->
      <div class="card">
        <h2>الخط الافتراضي السريع</h2>
        <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 8px;">اختر الخط المفضل للحجز اليومي:</p>
        <div class="route-selector">
          <div class="route-btn active" id="btnOctober" onclick="selectRoute('6 أكتوبر', 'ليلة القدر')">
            📍 6 أكتوبر<br><small style="font-size: 0.75rem; color: var(--text-muted);">ليلة القدر</small>
          </div>
          <div class="route-btn" id="btnRamses" onclick="selectRoute('رمسيس', 'رمسيس')">
            📍 رمسيس<br><small style="font-size: 0.75rem; color: var(--text-muted);">التوحيد والنور</small>
          </div>
        </div>
      </div>
    </div>

    <!-- Live Trips Table -->
    <div class="card">
      <h2>
        <span>رحلات اليوم المتاحة (<span id="tripCount">0</span>)</span>
        <span style="font-size: 0.8rem; color: var(--text-muted);" id="lastSync"></span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>رقم الرحلة</th>
            <th>اسم الخط</th>
            <th>الانطلاق</th>
            <th>وقت التحرك</th>
            <th>المقاعد المتاحة</th>
            <th>إجراء</th>
          </tr>
        </thead>
        <tbody id="tripsTableBody">
          <tr><td colspan="6" style="text-align: center; color: var(--text-muted);">جاري جلب رحلات اليوم...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    async function loadAll() {
      await Promise.all([loadStatus(), loadTrips()]);
    }

    async function loadStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        document.getElementById('cairoTime').innerText = 'توقيت القاهرة: ' + data.cairoTime;

        const badge = document.getElementById('bookingStatusBadge');
        const details = document.getElementById('bookingDetails');

        if (data.confirmedToday) {
          badge.className = 'badge badge-success';
          badge.innerText = 'مؤكد ومحجوز ✅';
          details.innerHTML = \`
            <p style="font-size: 1.1rem; font-weight: bold; color: var(--success); margin-bottom: 4px;">
              كود الحجز: \${data.confirmedToday.bookingCode}
            </p>
            <p style="font-size: 0.9rem; color: var(--text);">الخط: \${data.confirmedToday.routeName}</p>
            <p style="font-size: 0.85rem; color: var(--text-muted);">الموقف: \${data.confirmedToday.pickupLocation}</p>
          \`;
        } else {
          badge.className = 'badge badge-warning';
          badge.innerText = 'لم يتم الحجز اليوم بعد';
          details.innerHTML = \`
            <p style="font-size: 0.9rem; color: var(--text-muted);">
              الوكيل في انتظار بدء نافذة الحجز الساعة <strong>\${data.config.dailyStartTime}</strong>
            </p>
          \`;
        }
      } catch (err) {
        console.error(err);
      }
    }

    async function loadTrips() {
      try {
        const res = await fetch('/api/trips');
        const data = await res.json();
        const tbody = document.getElementById('tripsTableBody');
        const countSpan = document.getElementById('tripCount');
        const lastSync = document.getElementById('lastSync');

        lastSync.innerText = 'آخر فحص: ' + new Date().toLocaleTimeString('ar-EG');

        if (!data.success || !data.trips || data.trips.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">لا توجد رحلات معروضة حالياً من ITI.</td></tr>';
          countSpan.innerText = '0';
          return;
        }

        countSpan.innerText = data.trips.length;
        tbody.innerHTML = data.trips.map(trip => {
          const hasSeats = trip.availableSeats > 0;
          const seatBadge = hasSeats
            ? \`<span class="badge badge-success">\${trip.availableSeats} مقعد متاح</span>\`
            : \`<span class="badge badge-danger">ممتلئ (0)</span>\`;

          return \`
            <tr>
              <td>#\${trip.id}</td>
              <td style="font-weight: 600;">\${trip.routeName}</td>
              <td style="color: var(--text-muted);">\${trip.startLocation || '-'}</td>
              <td>\${trip.departureTime || '16:00:00'}</td>
              <td>\${seatBadge}</td>
              <td>
                <button
                  class="btn btn-sm \${hasSeats ? '' : 'btn-disabled'}"
                  \${hasSeats ? '' : 'disabled'}
                  onclick="bookDirectly(\${trip.id}, '\${trip.routeName}')">
                  ⚡ حجز فوري
                </button>
              </td>
            </tr>
          \`;
        }).join('');
      } catch (err) {
        console.error(err);
      }
    }

    async function bookDirectly(tripId, routeName) {
      if (!confirm('هل تريد تأكيد حجز مقعدك على ' + routeName + ' الآن؟')) return;

      try {
        const res = await fetch('/api/book', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tripId })
        });
        const data = await res.json();
        if (data.success) {
          alert('🎉 تم تأكيد الحجز بنجاح! كود الحجز: ' + (data.result.booking?.bookingCode || ''));
          loadAll();
        } else {
          alert('❌ فشل الحجز: ' + (data.result?.reason || data.error || 'خطأ غير معروف'));
        }
      } catch (err) {
        alert('حدث خطأ في الاتصال: ' + err.message);
      }
    }

    function selectRoute(route, pickup) {
      document.getElementById('btnOctober').classList.toggle('active', route.includes('أكتوبر'));
      document.getElementById('btnRamses').classList.toggle('active', route.includes('رمسيس'));
      alert('تم اختيار خط ' + route + ' كوجهة مفضلة!');
    }

    loadAll();
    setInterval(loadAll, 15000);
  </script>
</body>
</html>`);
    }
  });

  server.listen(PORT, () => {
    log.info(`✅ ITI Bus Agent Frontend Controller is running at: http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  log.error("Fatal error starting UI server", err);
  process.exit(1);
});
