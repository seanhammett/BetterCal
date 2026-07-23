import {
  MAX_WEEK,
  MIN_WEEK,
  TOTAL_WEEKS,
  addDays,
  dateFromDayNumber,
  dayKey,
  dayNumber,
  fmtDow,
  fmtHour,
  fmtMinutes,
  fmtMonthShort,
  fmtMonthYear,
  isoWeek,
  weekIndexOf,
  weekStartDate,
} from "./dates.js";
import {
  ALLDAY_LANE_H,
  ALLDAY_MAX_LANES,
  DAY_HEAD_H,
  DENSE_DAY_W,
  HOUR_H,
  MAX_DAY_W,
  MIN_DAY_W,
  WEEK_BAR_H,
  allDayBandH,
  assignBannerLanes,
  eventKey,
  layoutBanners,
  layoutDayGrid,
  weekPitch,
} from "./layout.js";
import { contrastText, openDayInGoogleCalendar } from "./render.js";
import type { EventStore } from "./store.js";
import type { CalEvent, WeekStart } from "./types.js";

/** Extra weeks kept mounted left/right of the viewport. */
const RENDER_BUFFER = 2;
/** Extra weeks of events fetched beyond the mounted range. */
const PREFETCH_WEEKS = 12;
/** Click-to-create snaps to this many minutes. */
const SLOT_SNAP = 30;
/** Where the grid opens vertically, so the working day is on screen. */
const OPEN_AT_HOUR = 7;
/**
 * Weeks of history folded into the all-day lane assignment. A bar's lane
 * depends on the bars that started before it, which may have ended weeks ago
 * and be off screen — this is how far back that chain is followed.
 */
const LANE_LOOKBACK = 6;

export interface WeekViewDeps {
  store: EventStore;
  weekStart(): WeekStart;
  todayKey(): string;
  dayWidth(): number;
  /** Wake / sleep times as minutes from midnight; null hides that line. */
  dayHours(): { wake: number | null; sleep: number | null };
  onEventClick(event: CalEvent): void;
  /** Click on empty grid space — create at that day and time of day. */
  onSlotClick(date: Date, minutes: number): void;
  /** Something scrolled or remounted; the host refreshes the minimap. */
  onScroll(): void;
}

export interface WeekView {
  /** Show the grid, anchored on `date`. */
  activate(date: Date): void;
  hide(): void;
  layout(): void;
  /**
   * Re-render every mounted panel. All-day lanes are assigned across weeks, so
   * new events can move bars in weeks they don't themselves touch.
   */
  rerender(): void;
  /** Throw away every panel (week-start or calendar selection changed). */
  reset(): void;
  scrollToDate(date: Date, smooth: boolean): void;
  jumpToDay(day: number, smooth: boolean): void;
  anchorDate(): Date;
  /** Inclusive day-number range currently on screen. */
  visibleDayRange(): [number, number];
  applyDayWidth(width: number, reanchor: boolean): void;
  /** Move the current-time line (called once a minute). */
  tick(): void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function initWeekView(deps: WeekViewDeps): WeekView {
  const root = $("weekview");
  const scroller = $("wk-scroller");
  const sizer = $("wk-sizer");
  const hoursInner = $("wk-hours-inner");
  const stickyLabel = $("wk-sticky-label");

  const mounted = new Map<number, HTMLElement>();
  let dayWidth = deps.dayWidth();
  let bandLanes = 1;
  /** Cross-week all-day lane assignment, keyed by eventKey(). */
  let laneMap = new Map<string, number>();
  /** Set while activate() is restoring a scroll position, to skip layout churn. */
  let active = false;

  /* ---------------- Geometry ---------------- */

  const pitch = (): number => weekPitch(dayWidth);
  const headH = (): number => WEEK_BAR_H + DAY_HEAD_H + allDayBandH(bandLanes);

  function applyGeometry(): void {
    root.classList.toggle("dense", dayWidth < DENSE_DAY_W);
    root.style.setProperty("--day-w", `${dayWidth}px`);
    root.style.setProperty("--wk-head-h", `${headH()}px`);
    root.style.setProperty("--wk-allday-h", `${allDayBandH(bandLanes)}px`);
    sizer.style.width = `${TOTAL_WEEKS * pitch()}px`;
    sizer.style.height = `${headH() + 24 * HOUR_H}px`;
  }

  function buildHourGutter(): void {
    hoursInner.textContent = "";
    for (let h = 1; h < 24; h++) {
      const el = document.createElement("div");
      el.className = "wk-hr";
      el.style.top = `${h * HOUR_H}px`;
      el.textContent = fmtHour(h);
      hoursInner.appendChild(el);
    }
  }

  /* ---------------- Rendering one week panel ---------------- */

  function buildDayHead(date: Date, todayKey: string): HTMLElement {
    const el = document.createElement("div");
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    el.className = `wk-dh${weekend ? " weekend" : ""}`;
    if (dayKey(date) === todayKey) el.classList.add("today");

    const dow = document.createElement("div");
    dow.className = "wk-dow";
    dow.textContent = fmtDow(date);
    const num = document.createElement("div");
    num.className = "wk-dnum";
    num.textContent = String(date.getDate());
    el.append(dow, num);

    if (date.getDate() === 1) {
      const mon = document.createElement("div");
      mon.className = "wk-dmon";
      mon.textContent = fmtMonthShort(date);
      el.appendChild(mon);
    }
    return el;
  }

  function buildBanner(
    e: CalEvent,
    lane: number,
    colStart: number,
    cols: number,
    contL: boolean,
    contR: boolean,
  ): HTMLElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "chip banner wk-band";
    if (contL) el.classList.add("cont-l");
    if (contR) el.classList.add("cont-r");
    el.style.background = e.color;
    el.style.color = contrastText(e.color);
    // A bar that carries on into the next week is drawn straight across the
    // seam, ending exactly where the next week's half of it starts, so the two
    // halves read as one ribbon laid over the break.
    const pad = contL ? 0 : 2;
    el.style.left = `calc(${colStart} * var(--day-w) + ${pad}px)`;
    el.style.width = contR
      ? `calc(${cols} * var(--day-w) + var(--wk-gap) - ${pad}px)`
      : `calc(${cols} * var(--day-w) - ${pad + 2}px)`;
    el.style.top = `${lane * ALLDAY_LANE_H}px`;
    el.title = e.title;

    const title = document.createElement("span");
    title.className = "ctitle";
    title.textContent = e.title;
    el.appendChild(title);
    el.addEventListener("click", () => deps.onEventClick(e));
    return el;
  }

  function buildBlock(e: CalEvent, box: { left: number; width: number; top: number; height: number }, col: number): HTMLElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "wk-block";
    // Short blocks put the time next to the title instead of on its own line.
    if (box.height < 34) el.classList.add("compact");
    el.style.background = e.color;
    el.style.color = contrastText(e.color);
    el.style.left = `calc((${col} + ${box.left}) * var(--day-w) + 1px)`;
    el.style.width = `calc(${box.width} * var(--day-w) - 3px)`;
    el.style.top = `${box.top}px`;
    el.style.height = `${box.height}px`;
    el.title = `${fmtMinutes(e.startMinutes)}–${fmtMinutes(e.endMinutes)} ${e.title}`;

    const title = document.createElement("span");
    title.className = "wk-btitle";
    title.textContent = e.title;
    const time = document.createElement("span");
    time.className = "wk-btime";
    time.textContent = fmtMinutes(e.startMinutes);
    el.append(title, time);
    el.addEventListener("click", () => deps.onEventClick(e));
    return el;
  }

  function renderPanel(panel: HTMLElement, weekIdx: number): void {
    const { store } = deps;
    const weekStart = deps.weekStart();
    const todayKey = deps.todayKey();
    panel.textContent = "";

    const start = weekStartDate(weekIdx, weekStart);
    const firstDay = dayNumber(start);
    const state = store.chunkStateForWeek(weekIdx);
    const events = state === "loaded" || state === "error" ? store.eventsForWeek(weekIdx) : [];

    /* --- Pinned head: week bar, day names/dates, all-day band --- */
    const head = document.createElement("div");
    head.className = "wk-head";

    // A thin bar across the full width of the week — it labels the week and
    // caps it, so each week reads as one block between two seams.
    const bar = document.createElement("div");
    bar.className = "wk-bar";
    const barLabel = document.createElement("span");
    barLabel.className = "wk-bar-label";
    barLabel.textContent = `Week ${isoWeek(addDays(start, weekStart === 0 ? 4 : 3))}`;
    bar.appendChild(barLabel);
    head.appendChild(bar);

    const days = document.createElement("div");
    days.className = "wk-days";
    for (let i = 0; i < 7; i++) days.appendChild(buildDayHead(addDays(start, i), todayKey));
    head.appendChild(days);

    const band = document.createElement("div");
    band.className = "wk-allday";
    const spans = layoutBanners(events, firstDay, laneMap);
    let hidden = 0;
    for (const s of spans) {
      if (s.lane >= ALLDAY_MAX_LANES) {
        hidden++;
        continue;
      }
      band.appendChild(
        buildBanner(
          s.event,
          s.lane,
          s.colStart,
          s.colEnd - s.colStart + 1,
          s.continuesLeft,
          s.continuesRight,
        ),
      );
    }
    if (hidden > 0) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "wk-band-more";
      more.textContent = `+${hidden}`;
      more.title = "More all-day events — open the week in Google Calendar";
      more.addEventListener("click", () => openDayInGoogleCalendar(start));
      band.appendChild(more);
    }
    head.appendChild(band);
    panel.appendChild(head);

    /* --- Body: hour grid, day columns, timed blocks --- */
    const body = document.createElement("div");
    body.className = "wk-body";

    const cols = document.createElement("div");
    cols.className = "wk-cols";
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      const weekend = date.getDay() === 0 || date.getDay() === 6;
      const col = document.createElement("div");
      col.className = `wk-col${weekend ? " weekend" : ""}`;
      if (dayKey(date) === todayKey) col.classList.add("today");
      if (date.getDate() === 1) col.classList.add("month-start");
      col.addEventListener("click", (e) => {
        const y = e.clientY - col.getBoundingClientRect().top;
        const mins = Math.max(
          0,
          Math.min(1440 - SLOT_SNAP, Math.floor(y / HOUR_H / (SLOT_SNAP / 60)) * SLOT_SNAP),
        );
        deps.onSlotClick(date, mins);
      });
      cols.appendChild(col);
    }
    body.appendChild(cols);

    // Wake / sleep markers: a faint pair of rules straight across the week,
    // bracketing the hours the user is actually awake for.
    const { wake, sleep } = deps.dayHours();
    for (const mins of [wake, sleep]) {
      if (mins === null) continue;
      const mark = document.createElement("div");
      mark.className = "wk-daymark";
      mark.style.top = `${(mins / 60) * HOUR_H}px`;
      body.appendChild(mark);
    }

    const ev = document.createElement("div");
    ev.className = "wk-ev";
    if (state === "loaded" || state === "error") {
      for (let c = 0; c < 7; c++) {
        for (const box of layoutDayGrid(events, firstDay + c)) {
          ev.appendChild(buildBlock(box.event, box, c));
        }
      }
    } else {
      for (const [c, top, h] of [
        [1, 9, 2],
        [3, 11, 1.5],
        [5, 14, 1],
      ] as const) {
        const sk = document.createElement("div");
        sk.className = "skel";
        sk.style.left = `calc(${c} * var(--day-w) + 2px)`;
        sk.style.width = `calc(var(--day-w) - 6px)`;
        sk.style.top = `${top * HOUR_H}px`;
        sk.style.height = `${h * HOUR_H}px`;
        ev.appendChild(sk);
      }
    }

    // Current-time line, drawn only in the week that contains today.
    const now = new Date();
    const todayCol = dayNumber(now) - firstDay;
    if (todayCol >= 0 && todayCol <= 6) {
      const line = document.createElement("div");
      line.className = "wk-now";
      line.style.top = `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_H}px`;
      line.style.left = `calc(${todayCol} * var(--day-w))`;
      line.style.width = "var(--day-w)";
      ev.appendChild(line);
    }
    body.appendChild(ev);
    panel.appendChild(body);

    // The seam that separates this week from the next.
    const seam = document.createElement("div");
    seam.className = "wk-seam";
    panel.appendChild(seam);
  }

  /* ---------------- Virtualization ---------------- */

  function visibleWeekRange(): [number, number] {
    const p = pitch();
    const first = MIN_WEEK + Math.floor(scroller.scrollLeft / p);
    const last = MIN_WEEK + Math.floor((scroller.scrollLeft + scroller.clientWidth) / p);
    return [Math.max(MIN_WEEK, first), Math.min(MAX_WEEK, last)];
  }

  function anchorWeek(): number {
    return Math.min(MAX_WEEK, MIN_WEEK + Math.round(scroller.scrollLeft / pitch()));
  }

  function anchorDate(): Date {
    return addDays(weekStartDate(anchorWeek(), deps.weekStart()), 3);
  }

  function visibleDayRange(): [number, number] {
    const p = pitch();
    const ws = deps.weekStart();
    const [firstW, lastW] = visibleWeekRange();
    // Sub-week precision: how far into the first week the left edge sits.
    const into = (scroller.scrollLeft - (firstW - MIN_WEEK) * p) / dayWidth;
    const firstDay =
      dayNumber(weekStartDate(firstW, ws)) + Math.max(0, Math.min(6, Math.floor(into)));
    const lastDay = dayNumber(weekStartDate(lastW, ws)) + 6;
    return [firstDay, Math.max(firstDay, lastDay)];
  }

  function mountWeek(weekIdx: number): void {
    const panel = document.createElement("div");
    panel.className = "wk";
    panel.style.left = `${(weekIdx - MIN_WEEK) * pitch()}px`;
    renderPanel(panel, weekIdx);
    sizer.appendChild(panel);
    mounted.set(weekIdx, panel);
  }

  /**
   * Recompute the cross-week all-day lanes over [lo, hi] plus a run of history.
   * Returns whether anything moved, since a change invalidates panels outside
   * the weeks whose events actually changed.
   */
  function rebuildLanes(lo: number, hi: number): boolean {
    const seen = new Set<string>();
    const banners: CalEvent[] = [];
    for (let w = Math.max(MIN_WEEK, lo - LANE_LOOKBACK); w <= hi; w++) {
      for (const e of deps.store.eventsForWeek(w)) {
        if (!e.banner) continue;
        const key = eventKey(e);
        if (seen.has(key)) continue;
        seen.add(key);
        banners.push(e);
      }
    }
    const next = assignBannerLanes(banners);
    if (next.size === laneMap.size) {
      let same = true;
      for (const [key, lane] of next) {
        if (laneMap.get(key) !== lane) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }
    laneMap = next;
    return true;
  }

  /** All-day lanes needed by the weeks on screen, so the band sizes to fit. */
  function neededLanes(first: number, last: number): number {
    let lanes = 1;
    for (let w = first; w <= last; w++) {
      for (const e of deps.store.eventsForWeek(w)) {
        if (e.banner) lanes = Math.max(lanes, (laneMap.get(eventKey(e)) ?? 0) + 1);
      }
    }
    return Math.min(ALLDAY_MAX_LANES, lanes);
  }

  function layout(): void {
    if (!active) return;
    const [first, last] = visibleWeekRange();
    const lo = Math.max(MIN_WEEK, first - RENDER_BUFFER);
    const hi = Math.min(MAX_WEEK, last + RENDER_BUFFER);

    for (const [idx, el] of mounted) {
      if (idx < lo || idx > hi) {
        el.remove();
        mounted.delete(idx);
      }
    }

    // Lanes first — panels are rendered from the map, and the band's height
    // (a CSS var read by every panel) follows from it.
    const lanesMoved = rebuildLanes(lo, hi);
    const lanes = neededLanes(first, last);
    if (lanes !== bandLanes) {
      bandLanes = lanes;
      applyGeometry();
    }
    if (lanesMoved) {
      for (const [idx, el] of mounted) renderPanel(el, idx);
    }

    for (let idx = lo; idx <= hi; idx++) {
      if (!mounted.has(idx)) mountWeek(idx);
    }

    deps.store.ensureRange(
      Math.max(MIN_WEEK, lo - PREFETCH_WEEKS),
      Math.min(MAX_WEEK, hi + PREFETCH_WEEKS),
    );

    hoursInner.style.transform = `translateY(${-scroller.scrollTop}px)`;
    updateStickyMonth();
    deps.onScroll();
  }

  /**
   * Pinned month label — the horizontal mirror of the month view's sticky
   * pill. It names the month at the left edge of the grid and is pushed out of
   * the way when the next month's first day scrolls up against it.
   */
  function updateStickyMonth(): void {
    const ws = deps.weekStart();
    const [firstDay] = visibleDayRange();
    const current = dateFromDayNumber(firstDay);
    stickyLabel.textContent = fmtMonthYear(current);

    // Find the next month boundary within the label's reach.
    let push = 0;
    const leftPx = scroller.scrollLeft;
    for (let d = firstDay + 1; d <= firstDay + 8; d++) {
      const date = dateFromDayNumber(d);
      if (date.getDate() !== 1) continue;
      const w = weekIndexOf(date, ws);
      const col = d - dayNumber(weekStartDate(w, ws));
      const x = (w - MIN_WEEK) * pitch() + col * dayWidth;
      const dist = x - leftPx;
      const clearance = 8 + stickyLabel.offsetWidth;
      if (dist < clearance) push = dist - clearance;
      break;
    }
    stickyLabel.style.transform = `translateX(${push}px)`;
  }

  let queued = false;
  function queueLayout(): void {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      layout();
    });
  }

  function rerender(): void {
    let lo = Infinity;
    let hi = -Infinity;
    for (const idx of mounted.keys()) {
      lo = Math.min(lo, idx);
      hi = Math.max(hi, idx);
    }
    if (lo > hi) return;
    rebuildLanes(lo, hi);
    for (const [idx, panel] of mounted) renderPanel(panel, idx);
  }

  function unmountAll(): void {
    for (const el of mounted.values()) el.remove();
    mounted.clear();
  }

  /* ---------------- Navigation ---------------- */

  function scrollToWeek(weekIdx: number, smooth: boolean): void {
    const clamped = Math.max(MIN_WEEK, Math.min(MAX_WEEK, weekIdx));
    scroller.scrollTo({
      left: (clamped - MIN_WEEK) * pitch(),
      behavior: smooth ? "smooth" : "auto",
    });
  }

  function scrollToDate(date: Date, smooth: boolean): void {
    scrollToWeek(weekIndexOf(date, deps.weekStart()), smooth);
  }

  function jumpToDay(day: number, smooth: boolean): void {
    scrollToDate(dateFromDayNumber(day), smooth);
  }

  /* ---------------- Public surface ---------------- */

  function activate(date: Date): void {
    active = true;
    root.hidden = false;
    dayWidth = deps.dayWidth();
    applyGeometry();
    unmountAll();
    scrollToDate(date, false);
    // Open on the working day rather than at midnight — but only the first
    // time, so switching tabs back and forth keeps the user's scroll position.
    if (scroller.scrollTop === 0) scroller.scrollTop = OPEN_AT_HOUR * HOUR_H;
    layout();
  }

  function hide(): void {
    active = false;
    root.hidden = true;
  }

  function applyDayWidth(width: number, reanchor: boolean): void {
    const keep = anchorWeek();
    dayWidth = Math.max(MIN_DAY_W, Math.min(MAX_DAY_W, Math.round(width)));
    applyGeometry();
    for (const [idx, panel] of mounted) {
      panel.style.left = `${(idx - MIN_WEEK) * pitch()}px`;
    }
    if (reanchor) scrollToWeek(keep, false);
    layout();
  }

  function tick(): void {
    if (!active) return;
    const line = sizer.querySelector<HTMLElement>(".wk-now");
    if (!line) return;
    const now = new Date();
    line.style.top = `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_H}px`;
  }

  /* ---------------- Wiring ---------------- */

  buildHourGutter();
  applyGeometry();
  // Scrolling is left to the browser: a vertical wheel walks the hours, and a
  // trackpad swipe (or Shift+wheel) walks the weeks. Overriding the axis would
  // make the 24-hour grid unreachable.
  scroller.addEventListener("scroll", queueLayout);

  return {
    activate,
    hide,
    layout: queueLayout,
    rerender,
    reset: unmountAll,
    scrollToDate,
    jumpToDay,
    anchorDate,
    visibleDayRange,
    applyDayWidth,
    tick,
  };
}
