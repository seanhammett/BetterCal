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

/** Whole UTC offset in minutes for a zone right now (GMT-7 → −420). */
function zoneOffsetMinutes(zone: string, now: Date): number {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])?(\d{1,2})?(?::(\d{2}))?/.exec(part ?? "");
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * ((Number(m[2]) || 0) * 60 + (Number(m[3]) || 0));
}

/** UTC offset as a compact label, e.g. "GMT", "GMT−8", "GMT+5:30". */
function offsetLabel(min: number): string {
  if (min === 0) return "GMT";
  const s = min < 0 ? "−" : "+";
  const h = Math.floor(Math.abs(min) / 60);
  const mm = Math.abs(min) % 60;
  return `GMT${s}${h}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
}

/** Every IANA zone, ordered by current UTC offset (west → east, −12 → +14) so
 *  the picker reads in a predictable sweep. Built once; the live rows below
 *  re-read the clock each second, so a stale DST offset here only affects
 *  ordering, never the times shown. */
const zoneChoices: { zone: string; name: string; offLabel: string }[] = (() => {
  const now = new Date();
  return Intl.supportedValuesOf("timeZone")
    .map((zone) => ({ zone, off: zoneOffsetMinutes(zone, now) }))
    .sort((a, b) => a.off - b.off || a.zone.localeCompare(b.zone))
    .map(({ zone, off }) => ({
      zone,
      name: zone.replace(/_/g, " "),
      offLabel: offsetLabel(off),
    }));
})();

export function initClock(settings: Settings, save: () => void): void {
  const timeEl = $("clock-time");
  const dowEl = $("clock-dow");
  const dateEl = $("clock-date");
  const listEl = $("tz-list");
  const picker = $("tz-picker");
  const searchEl = $<HTMLInputElement>("tz-search");
  const optionsEl = $("tz-options");
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
    // Ordered by current UTC offset (west → east) so the rows read like the
    // picker — Los Angeles, London, Paris — no matter when each was added.
    const zones = [...settings.timeZones].sort(
      (a, b) => zoneOffsetMinutes(a, now) - zoneOffsetMinutes(b, now) || a.localeCompare(b),
    );
    for (const zone of zones) {
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
    // Hours and minutes lead; the seconds (and the colon before them) drop to a
    // light, muted span and any am/pm is shrunk. Every colon separator also gets
    // a little breathing room on each side.
    const parts = clockTimeFmt.formatToParts(now);
    const classFor = (i: number): string => {
      const p = parts[i];
      const type = p.type === "literal" ? parts[i + 1]?.type : p.type;
      const size = type === "second" ? "clock-sec" : type === "dayPeriod" ? "clock-ap" : "";
      const colon = p.type === "literal" && p.value.includes(":") ? "clock-colon" : "";
      return [size, colon].filter(Boolean).join(" ");
    };
    timeEl.innerHTML = parts
      .map((p, i) => {
        const cls = classFor(i);
        return cls ? `<span class="${cls}">${p.value}</span>` : p.value;
      })
      .join("");
    dowEl.textContent = clockDowFmt.format(now);
    dateEl.textContent = clockDateFmt.format(now);
    for (const el of listEl.querySelectorAll<HTMLElement>(".tz-time")) {
      el.textContent = fmtFor(el.dataset.zone!).format(now);
    }
  }

  // Zone picker: a search box over every IANA zone (ordered −12 → +14),
  // filtered as you type. Shown on demand under the "+ time zone" link.
  function renderOptions(query: string): void {
    const q = query.trim().toLowerCase();
    const added = new Set(settings.timeZones);
    optionsEl.textContent = "";
    let shown = 0;
    for (const z of zoneChoices) {
      if (added.has(z.zone)) continue;
      if (q && !z.name.toLowerCase().includes(q) && !z.offLabel.toLowerCase().includes(q)) continue;
      const opt = document.createElement("div");
      opt.className = "tz-opt";
      opt.setAttribute("role", "option");
      opt.dataset.zone = z.zone;
      const name = document.createElement("span");
      name.className = "tz-opt-name";
      name.textContent = z.name;
      const off = document.createElement("span");
      off.className = "tz-opt-off";
      off.textContent = z.offLabel;
      opt.append(name, off);
      // mousedown (not click) so the pick lands before the input's blur closes
      // the picker; preventDefault keeps focus on the search box.
      opt.addEventListener("mousedown", (e) => {
        e.preventDefault();
        addZone(z.zone);
      });
      optionsEl.appendChild(opt);
      if (++shown >= 100) break; // cap the DOM; typing narrows the rest in
    }
  }

  function addZone(zone: string): void {
    if (!settings.timeZones.includes(zone)) {
      settings.timeZones = [...settings.timeZones, zone];
      save();
      buildZoneRows();
    }
    closePicker();
  }

  function openPicker(): void {
    picker.hidden = false;
    searchEl.value = "";
    renderOptions("");
    searchEl.focus();
  }

  function closePicker(): void {
    picker.hidden = true;
    searchEl.value = "";
    optionsEl.textContent = "";
  }

  addBtn.addEventListener("click", () => {
    if (picker.hidden) openPicker();
    else closePicker();
  });
  searchEl.addEventListener("input", () => renderOptions(searchEl.value));
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closePicker();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const zone = optionsEl.querySelector<HTMLElement>(".tz-opt")?.dataset.zone;
      if (zone) addZone(zone);
    }
  });
  searchEl.addEventListener("blur", () => closePicker());

  buildZoneRows();
  setInterval(tick, 1000);
}
