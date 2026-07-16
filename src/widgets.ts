import { fmtTime } from "./dates.js";
import type { Settings } from "./types.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/* ---------------- Clock + extra time zones ---------------- */

const clockTimeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const clockDateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

function zoneShortName(zone: string): string {
  return zone.split("/").pop()!.replace(/_/g, " ");
}

/** Offset from local time, e.g. "+9h", "−3:30", "same". */
function zoneDelta(zone: string, now: Date): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value; // "GMT-7" / "GMT+5:30" / "GMT"
  const m = /GMT([+-])?(\d{1,2})?(?::(\d{2}))?/.exec(part ?? "");
  if (!m) return "";
  const sign = m[1] === "-" ? -1 : 1;
  const zoneMin = sign * ((Number(m[2]) || 0) * 60 + (Number(m[3]) || 0));
  const delta = zoneMin - -now.getTimezoneOffset();
  if (delta === 0) return "same";
  const s = delta < 0 ? "−" : "+";
  const h = Math.floor(Math.abs(delta) / 60);
  const min = Math.abs(delta) % 60;
  return min ? `${s}${h}:${String(min).padStart(2, "0")}` : `${s}${h}h`;
}

export function initClock(settings: Settings, save: () => void): void {
  const timeEl = $("clock-time");
  const dateEl = $("clock-date");
  const listEl = $("tz-list");
  const select = $<HTMLSelectElement>("tz-select");
  const addBtn = $("btn-tz-add");

  const zoneFmts = new Map<string, Intl.DateTimeFormat>();
  const fmtFor = (zone: string): Intl.DateTimeFormat => {
    let f = zoneFmts.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat(undefined, {
        timeZone: zone,
        hour: "numeric",
        minute: "2-digit",
      });
      zoneFmts.set(zone, f);
    }
    return f;
  };

  function buildZoneRows(): void {
    listEl.textContent = "";
    const now = new Date();
    for (const zone of settings.timeZones) {
      const row = document.createElement("div");
      row.className = "tz-row";
      const name = document.createElement("span");
      name.className = "tz-name";
      name.textContent = zoneShortName(zone);
      name.title = zone;
      const time = document.createElement("span");
      time.className = "tz-time";
      time.dataset.zone = zone;
      const delta = document.createElement("span");
      delta.className = "tz-delta";
      delta.textContent = zoneDelta(zone, now);
      const del = document.createElement("button");
      del.className = "tz-del";
      del.textContent = "✕";
      del.title = `Remove ${zone}`;
      del.addEventListener("click", () => {
        settings.timeZones = settings.timeZones.filter((z) => z !== zone);
        save();
        buildZoneRows();
      });
      row.append(name, time, delta, del);
      listEl.appendChild(row);
    }
    tick();
  }

  function tick(): void {
    const now = new Date();
    // Render the seconds (and their leading separator) in a muted span.
    const parts = clockTimeFmt.formatToParts(now);
    timeEl.innerHTML = parts
      .map((p, i) =>
        p.type === "second" || (p.type === "literal" && parts[i + 1]?.type === "second")
          ? `<span class="clock-sec">${p.value}</span>`
          : p.value,
      )
      .join("");
    dateEl.textContent = clockDateFmt.format(now);
    for (const el of listEl.querySelectorAll<HTMLElement>(".tz-time")) {
      el.textContent = fmtFor(el.dataset.zone!).format(now);
    }
  }

  // Zone picker: a native select filled with all IANA zones, shown on demand.
  for (const zone of Intl.supportedValuesOf("timeZone")) {
    const opt = document.createElement("option");
    opt.value = zone;
    opt.textContent = zone.replace(/_/g, " ");
    select.appendChild(opt);
  }
  addBtn.addEventListener("click", () => {
    select.hidden = false;
    select.focus();
  });
  select.addEventListener("change", () => {
    const zone = select.value;
    if (zone && !settings.timeZones.includes(zone)) {
      settings.timeZones = [...settings.timeZones, zone];
      save();
      buildZoneRows();
    }
    select.hidden = true;
  });
  select.addEventListener("blur", () => {
    select.hidden = true;
  });

  buildZoneRows();
  setInterval(tick, 1000);
}

/* ---------------- Weather + sunrise/sunset (Open-Meteo, no key) ---------------- */

const WMO_ICONS: [number, string, string][] = [
  [0, "☀️", "Clear"],
  [1, "🌤", "Mostly clear"],
  [2, "⛅", "Partly cloudy"],
  [3, "☁️", "Overcast"],
  [48, "🌫", "Fog"],
  [57, "🌦", "Drizzle"],
  [67, "🌧", "Rain"],
  [77, "🌨", "Snow"],
  [82, "🌧", "Showers"],
  [86, "🌨", "Snow showers"],
  [99, "⛈", "Thunderstorm"],
];

function describeWeather(code: number): [string, string] {
  for (const [max, icon, label] of WMO_ICONS) {
    if (code <= max) return [icon, label];
  }
  return ["🌡", ""];
}

interface OpenMeteoResponse {
  current?: { temperature_2m?: number; weather_code?: number };
  daily?: { sunrise?: string[]; sunset?: string[] };
}

/** Returns a refresh function (used when e.g. the unit setting changes). */
export function initWeather(settings: Settings): () => void {
  const mainEl = $("weather-main");
  const sunRow = $("weather-sun");
  const sunriseEl = $("sunrise");
  const sunsetEl = $("sunset");
  const section = document.querySelector<HTMLElement>(".side-weather")!;

  async function fetchWeather(lat: number, lon: number): Promise<void> {
    const fahrenheit =
      settings.tempUnit === "f" ||
      (settings.tempUnit === "auto" && /^en-(US|BS|BZ|KY)/.test(navigator.language));
    const url =
      "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
      "&current=temperature_2m,weather_code&daily=sunrise,sunset" +
      `&timezone=auto&forecast_days=1${fahrenheit ? "&temperature_unit=fahrenheit" : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as OpenMeteoResponse;

    const temp = data.current?.temperature_2m;
    const [icon, label] = describeWeather(data.current?.weather_code ?? -1);
    mainEl.textContent =
      temp != null ? `${icon} ${Math.round(temp)}°${fahrenheit ? "F" : "C"} ${label}` : "—";

    const sunrise = data.daily?.sunrise?.[0];
    const sunset = data.daily?.sunset?.[0];
    if (sunrise && sunset) {
      // timezone=auto → ISO strings without offset, parsed as local time.
      sunriseEl.textContent = `↑ ${fmtTime(new Date(sunrise))}`;
      sunsetEl.textContent = `↓ ${fmtTime(new Date(sunset))}`;
      sunRow.hidden = false;
    }
  }

  function refresh(): void {
    mainEl.textContent = "Weather…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        fetchWeather(pos.coords.latitude, pos.coords.longitude).catch(() => {
          mainEl.textContent = "Weather unavailable — click to retry";
        });
      },
      () => {
        mainEl.textContent = "Location off — click to retry";
      },
      { maximumAge: 15 * 60_000, timeout: 10_000 },
    );
  }

  section.addEventListener("click", refresh);
  refresh();
  setInterval(refresh, 20 * 60_000);
  return refresh;
}
