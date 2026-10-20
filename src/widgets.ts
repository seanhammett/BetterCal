import { CITIES } from "./cities.js";
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

/** UTC offset for the note beside the clock, e.g. "UTC+2", "UTC−3:30", "UTC+0". */
function utcLabel(min: number): string {
  const s = min < 0 ? "−" : "+";
  const h = Math.floor(Math.abs(min) / 60);
  const mm = Math.abs(min) % 60;
  return `UTC${s}${h}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
}

/** A lettered abbreviation for a zone ("CEST", "EDT"), or "" when no locale
 *  has one and would only spell out the offset ("GMT+9"). en-US knows the
 *  American names, en-GB the European ones. */
function zoneAbbrev(zone: string, now: Date): string {
  for (const locale of [undefined, "en-US", "en-GB"]) {
    const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value;
    if (name && /^[A-Z]{2,5}$/.test(name) && name !== "GMT" && name !== "UTC") return name;
  }
  return "";
}

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Folded for search: lower case, accents dropped ("Málaga" → "malaga"). */
const fold = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const cityChoices = CITIES.map(([name, country, zone]) => ({
  label: `${name}, ${country}`,
  name: fold(name),
  key: fold(`${name}, ${country}`),
  zone,
}));

/** The city shown when the user hasn't picked one: the browser zone's own city
 *  if it's in the list (Europe/Paris → "Paris, France"), else any city in that
 *  zone, else the zone's last segment. */
function defaultCity(): string {
  const short = zoneShortName(localZone);
  const inZone = cityChoices.filter((c) => c.zone === localZone);
  return (inZone.find((c) => c.name === fold(short)) ?? inZone[0])?.label ?? short;
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
  const cityEl = $("clock-city");
  const tzAbbrEl = $("clock-tz-abbr");
  const tzOffEl = $("clock-tz-off");
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
    // Re-read each second so a DST change flips the note on the spot.
    tzAbbrEl.textContent = zoneAbbrev(localZone, now);
    tzOffEl.textContent = utcLabel(-now.getTimezoneOffset());
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
  initCityPicker(settings, save, () => {
    cityEl.textContent = settings.homeCity ?? defaultCity();
  });
}

/* ---------------- Home city (Settings) ---------------- */

/**
 * A search box over CITIES. The box shows the current city; focusing it opens
 * the list, typing narrows it, and blur or Escape puts the current city back.
 * The first row, while the box is empty, returns to the automatic city.
 */
function initCityPicker(settings: Settings, save: () => void, apply: () => void): void {
  const input = $<HTMLInputElement>("city-search");
  const optionsEl = $("city-options");
  const now = new Date();

  const current = (): string => settings.homeCity ?? defaultCity();

  function pick(city: string | null): void {
    settings.homeCity = city;
    save();
    apply();
    close();
    input.blur();
  }

  function addOption(text: string, sub: string, city: string | null): void {
    const opt = document.createElement("div");
    opt.className = "tz-opt";
    opt.setAttribute("role", "option");
    const name = document.createElement("span");
    name.className = "tz-opt-name";
    name.textContent = text;
    const off = document.createElement("span");
    off.className = "tz-opt-off";
    off.textContent = sub;
    opt.append(name, off);
    // mousedown so the pick lands before the input's blur closes the list.
    opt.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pick(city);
    });
    optionsEl.appendChild(opt);
  }

  function render(query: string): void {
    const q = fold(query.trim());
    optionsEl.textContent = "";
    if (!q) addOption(`Automatic (${defaultCity()})`, "", null);
    // Cities whose name starts with the query lead; then any other match on
    // "name, country" (so "france" lists every French city).
    const starts = cityChoices.filter((c) => q && c.name.startsWith(q));
    const rest = cityChoices.filter((c) => !(q && c.name.startsWith(q)) && c.key.includes(q));
    for (const c of [...starts, ...rest].slice(0, 100)) {
      addOption(c.label, offsetLabel(zoneOffsetMinutes(c.zone, now)), c.label);
    }
    optionsEl.hidden = !optionsEl.firstChild;
    input.setAttribute("aria-expanded", String(!optionsEl.hidden));
  }

  function close(): void {
    optionsEl.hidden = true;
    optionsEl.textContent = "";
    input.setAttribute("aria-expanded", "false");
    input.value = current();
  }

  input.addEventListener("focus", () => {
    input.value = "";
    render("");
  });
  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      input.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      optionsEl.querySelector<HTMLElement>(".tz-opt")?.dispatchEvent(new MouseEvent("mousedown"));
    }
  });
  input.addEventListener("blur", close);

  input.value = current();
  apply();
}
