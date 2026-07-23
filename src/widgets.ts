import type { Settings } from "./types.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/* ---------------- Clock + extra time zones ---------------- */

const clockTimeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const clockDowFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const clockDateFmt = new Intl.DateTimeFormat(undefined, {
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
  const dowEl = $("clock-dow");
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
    // Hours and minutes carry the size; the seconds and any am/pm are demoted
    // to a muted span (along with the separator that leads into them) so the
    // big reading stays legible at a glance.
    const parts = clockTimeFmt.formatToParts(now);
    const demoted = (i: number): string => {
      const type = parts[i].type === "literal" ? parts[i + 1]?.type : parts[i].type;
      if (type === "second") return "clock-sec";
      return type === "dayPeriod" ? "clock-ap" : "";
    };
    timeEl.innerHTML = parts
      .map((p, i) => {
        const cls = demoted(i);
        return cls ? `<span class="${cls}">${p.value}</span>` : p.value;
      })
      .join("");
    dowEl.textContent = clockDowFmt.format(now);
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
