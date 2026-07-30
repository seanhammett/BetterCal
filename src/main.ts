import { AuthRequiredError, ensureSignedIn, signIn, signOut } from "./auth.js";
import {
  MAX_WEEK,
  MIN_WEEK,
  TOTAL_WEEKS,
  addDays,
  dateFromDayNumber,
  dayKey,
  dayNumber,
  fmtDow,
  fmtMonthShort,
  fmtMonthYear,
  parseDateOnly,
  weekIndexOf,
  weekStartDate,
} from "./dates.js";
import { type DragMode, buildDragPayload, dragDays } from "./drag.js";
import { type Editor, initEditor } from "./editor.js";
import { ConflictError, listCalendars, patchEvent } from "./gcal.js";
import {
  DEFAULT_DAY_W,
  DEFAULT_ROW_H,
  DOW_H,
  MAX_DAY_W,
  MAX_HOUR_H,
  MAX_ROW_H,
  MIN_DAY_W,
  MIN_HOUR_H,
  MIN_ROW_H,
} from "./layout.js";
import { type DragPreview, renderWeekContents } from "./render.js";
import { EventStore } from "./store.js";
import { initClock } from "./widgets.js";
import {
  type CalEvent,
  type CalendarInfo,
  type Settings,
  type ViewMode,
  type WeekStart,
  canWriteCalendar,
} from "./types.js";
import { type WeekView, initWeekView } from "./weekview.js";

/** Extra weeks kept mounted above/below the viewport. */
const RENDER_BUFFER = 3;
/** Extra weeks of events fetched beyond the mounted range. */
const PREFETCH_WEEKS = 12;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const scroller = $<HTMLElement>("scroller");
const sizer = $<HTMLElement>("sizer");
const dowRow = $<HTMLElement>("dow-row");
const panel = $<HTMLElement>("panel");
const toast = $<HTMLElement>("toast");

const monthOverlay = $<HTMLElement>("sticky-month");
const sidebar = $<HTMLElement>("sidebar");
const zoomInput = $<HTMLInputElement>("zoom");
const vzoomInput = $<HTMLInputElement>("vzoom");
const vzoomRow = $<HTMLElement>("side-vzoom");
const minimap = $<HTMLElement>("minimap");
const miniTrack = $<HTMLElement>("mini-track");
const miniMonths = $<HTMLElement>("mini-months");
const miniViewport = $<HTMLElement>("mini-viewport");
const miniYearEl = $<HTMLElement>("mini-year");
const miniToday = $<HTMLElement>("mini-today");

const store = new EventStore();
const settings: Settings = {
  weekStart: 0,
  selectedCalendarIds: null,
  rowHeight: DEFAULT_ROW_H,
  dayWidth: DEFAULT_DAY_W,
  hourHeight: null,
  view: "month",
  wakeMinutes: null,
  sleepMinutes: null,
  clockInMinutes: null,
  clockOutMinutes: null,
  sidebarCollapsed: false,
  timeZones: [],
};

const mounted = new Map<number, HTMLElement>();
/** Reusable pool of floating month labels, kept in #sticky-month. */
const monthPills: HTMLElement[] = [];
let todayKey = dayKey(new Date());
let rowHeight = DEFAULT_ROW_H;
let miniYear = NaN;
let editor: Editor;
let weekView: WeekView;

const inWeekView = (): boolean => settings.view === "week";

const ctx = () => ({
  store,
  weekStart: settings.weekStart,
  todayKey,
  rowHeight,
  onEventClick: handleEventClick,
  onDayClick: handleDayClick,
  canEditEvent,
  onEventDragStart: handleDragStart,
  dragPreview,
});

/* ---------------- Event editing ---------------- */

// Recurring instances and read-only calendars aren't editable in-app yet —
// those are routed to Google Calendar rather than silently doing the wrong thing.
function canEditEvent(ev: CalEvent): boolean {
  if (ev.recurringEventId || !ev.rawStart || !ev.rawEnd) return false;
  const cal = store.calendars.find((c) => c.id === ev.calendarId);
  return !!cal && canWriteCalendar(cal);
}

function handleEventClick(ev: CalEvent): void {
  if (!canEditEvent(ev)) {
    if (ev.htmlLink) window.open(ev.htmlLink, "_blank");
    return;
  }
  editor.openEdit(ev);
}

function handleDayClick(date: Date, startMinutes?: number): void {
  const writable = store.calendars.filter(canWriteCalendar);
  if (writable.length === 0) return;
  const preferred =
    writable.find((c) => c.primary && store.selectedIds.has(c.id)) ??
    writable.find((c) => store.selectedIds.has(c.id)) ??
    writable[0];
  editor.openCreate(date, preferred.id, startMinutes);
}

function handleSaved(minDay: number, maxDay: number): void {
  const firstW = weekIndexOf(dateFromDayNumber(minDay), settings.weekStart);
  const lastW = weekIndexOf(dateFromDayNumber(maxDay), settings.weekStart);
  store.invalidateWeeks(firstW, lastW);
  rerenderMounted();
  weekView.rerender();
  activeLayout(); // ensureRange refetches the invalidated chunks that are in view
}

/* ---------------- Drag to move / resize events ---------------- */

interface DragState {
  ev: CalEvent;
  mode: DragMode;
  x0: number;
  y0: number;
  /** Day under the pointer at pointerdown (anchor for "move" deltas). */
  grabDay: number;
  /** True once the pointer has travelled past the click threshold. */
  active: boolean;
  days: { startDay: number; endDay: number };
}

let drag: DragState | null = null;
let dragPreview: DragPreview | null = null;

/** Local day number under a viewport point (clamped to the 7 columns). */
function dayAtPoint(clientX: number, clientY: number): number {
  const rect = scroller.getBoundingClientRect();
  const gutter =
    parseFloat(getComputedStyle(scroller).getPropertyValue("--wk-gutter")) || 22;
  const colW = (rect.width - gutter) / 7;
  const col = Math.max(0, Math.min(6, Math.floor((clientX - rect.left - gutter) / colW)));
  const contentY = scroller.scrollTop + (clientY - rect.top) - DOW_H;
  const week = Math.max(
    MIN_WEEK,
    Math.min(MAX_WEEK, MIN_WEEK + Math.floor(contentY / rowHeight)),
  );
  return dayNumber(weekStartDate(week, settings.weekStart)) + col;
}

function rerenderDaySpan(minDay: number, maxDay: number): void {
  const firstW = weekIndexOf(dateFromDayNumber(minDay), settings.weekStart);
  const lastW = weekIndexOf(dateFromDayNumber(maxDay), settings.weekStart);
  for (const [idx, row] of mounted) {
    if (idx >= firstW && idx <= lastW) renderWeekContents(row, idx, ctx());
  }
}

function handleDragStart(ev: CalEvent, mode: DragMode, pe: PointerEvent): void {
  if (pe.button !== 0 || drag) return;
  pe.preventDefault(); // no text selection / native button focus while dragging
  drag = {
    ev,
    mode,
    x0: pe.clientX,
    y0: pe.clientY,
    grabDay: dayAtPoint(pe.clientX, pe.clientY),
    active: false,
    days: { startDay: ev.startDay, endDay: ev.endDay },
  };
}

function onDragMove(pe: PointerEvent): void {
  if (!drag) return;
  if (!drag.active) {
    if (Math.abs(pe.clientX - drag.x0) < 4 && Math.abs(pe.clientY - drag.y0) < 4) return;
    drag.active = true;
    document.body.classList.add(drag.mode === "move" ? "dragging-move" : "dragging-resize");
  }
  const next = dragDays(drag.ev, drag.mode, dayAtPoint(pe.clientX, pe.clientY), drag.grabDay);
  const prev = drag.days;
  if (next.startDay === prev.startDay && next.endDay === prev.endDay) return;
  drag.days = next;
  dragPreview = { event: drag.ev, startDay: next.startDay, endDay: next.endDay };
  rerenderDaySpan(Math.min(prev.startDay, next.startDay), Math.max(prev.endDay, next.endDay));
}

/** Eat the click that follows an actual drag so it doesn't open the editor. */
function swallowNextClick(): void {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

function onDragEnd(): void {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.active) return; // plain click — the chip's click handler takes over
  document.body.classList.remove("dragging-move", "dragging-resize");
  swallowNextClick();
  dragPreview = null;
  if (d.days.startDay === d.ev.startDay && d.days.endDay === d.ev.endDay) {
    rerenderDaySpan(d.days.startDay, d.days.endDay); // clear the preview styling
    return;
  }
  void commitDrag(d.ev, d.days.startDay, d.days.endDay);
}

function onDragCancel(): void {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.active) return;
  document.body.classList.remove("dragging-move", "dragging-resize");
  dragPreview = null;
  rerenderDaySpan(
    Math.min(d.days.startDay, d.ev.startDay),
    Math.max(d.days.endDay, d.ev.endDay),
  );
}

async function commitDrag(ev: CalEvent, startDay: number, endDay: number): Promise<void> {
  const payload = buildDragPayload(ev, startDay, endDay);
  if (!payload) return;
  const minDay = Math.min(ev.startDay, startDay);
  const maxDay = Math.max(ev.endDay, endDay);
  const etag = ev.etag;

  // Optimistic: re-bucket locally right away, then confirm with the server.
  store.applyDayShift(ev, startDay, endDay, payload.start, payload.end);
  rerenderDaySpan(minDay, maxDay);

  try {
    const updated = await patchEvent(ev.calendarId, ev.id, payload, etag);
    ev.etag = updated.etag; // future drags/edits stay conflict-checked
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      unmountAll();
      showScreen("signin");
      return;
    }
    showToast(
      err instanceof ConflictError
        ? "This event changed elsewhere — reloading the latest version."
        : `Couldn't move event — ${err instanceof Error ? err.message : String(err)}`,
    );
    handleSaved(minDay, maxDay); // refetch the truth, restoring the event
  }
}

/* ---------------- Settings persistence ---------------- */

/** A stored wake/sleep time, or null if it was never set (or is nonsense). */
function validMinutes(v: unknown): number | null {
  return typeof v === "number" && v >= 0 && v < 1440 ? Math.round(v) : null;
}

/** Minutes from midnight ⇄ an <input type="time"> value. */
function toTimeValue(mins: number | null): string {
  if (mins === null) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(mins / 60))}:${p(mins % 60)}`;
}
function fromTimeValue(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  return m ? validMinutes(Number(m[1]) * 60 + Number(m[2])) : null;
}

async function loadSettings(): Promise<void> {
  const data = await chrome.storage.sync.get("settings");
  const saved = data.settings as Partial<Settings> | undefined;
  if (saved) {
    if (saved.weekStart === 0 || saved.weekStart === 1) settings.weekStart = saved.weekStart;
    if (Array.isArray(saved.selectedCalendarIds)) {
      settings.selectedCalendarIds = saved.selectedCalendarIds;
    }
    if (typeof saved.rowHeight === "number") {
      settings.rowHeight = Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, saved.rowHeight));
    }
    if (typeof saved.dayWidth === "number") {
      settings.dayWidth = Math.max(MIN_DAY_W, Math.min(MAX_DAY_W, saved.dayWidth));
    }
    // null (or absent) keeps the auto-fit; a number is a saved manual vertical zoom.
    if (typeof saved.hourHeight === "number") {
      settings.hourHeight = Math.max(MIN_HOUR_H, Math.min(MAX_HOUR_H, saved.hourHeight));
    }
    if (saved.view === "month" || saved.view === "week") settings.view = saved.view;
    settings.wakeMinutes = validMinutes(saved.wakeMinutes);
    settings.sleepMinutes = validMinutes(saved.sleepMinutes);
    settings.clockInMinutes = validMinutes(saved.clockInMinutes);
    settings.clockOutMinutes = validMinutes(saved.clockOutMinutes);
    if (typeof saved.sidebarCollapsed === "boolean") {
      settings.sidebarCollapsed = saved.sidebarCollapsed;
    }
    if (Array.isArray(saved.timeZones)) {
      settings.timeZones = saved.timeZones.filter((z): z is string => typeof z === "string");
    }
  }
  rowHeight = settings.rowHeight;
}

// Debounced so rapid changes (e.g. dragging the zoom slider) coalesce into a
// single write and stay under chrome.storage.sync's per-minute write quota.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function flushSettings(): void {
  saveTimer = undefined;
  void chrome.storage.sync.set({ settings });
}
function saveSettings(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettings, 500);
}

/* ---------------- Screens ---------------- */

type Screen = "signin" | "loading" | "boot-error" | "calendar";

function showScreen(screen: Screen): void {
  $("signin").hidden = screen !== "signin";
  $("loading").hidden = screen !== "loading";
  $("boot-error").hidden = screen !== "boot-error";
  $("body-row").hidden = screen !== "calendar";
}

/* ---------------- Virtualized week list ---------------- */

function visibleWeekRange(): [number, number] {
  const top = scroller.scrollTop;
  const first = MIN_WEEK + Math.floor(top / rowHeight);
  const last = MIN_WEEK + Math.floor((top + scroller.clientHeight - DOW_H) / rowHeight);
  return [Math.max(MIN_WEEK, first), Math.min(MAX_WEEK, last)];
}

/** Week index nearest the top of the viewport. */
function anchorWeek(): number {
  return Math.min(MAX_WEEK, MIN_WEEK + Math.round(scroller.scrollTop / rowHeight));
}

/** Date at the middle of the anchor week. */
function anchorDate(): Date {
  return addDays(weekStartDate(anchorWeek(), settings.weekStart), 3);
}

function mountWeek(weekIdx: number): void {
  const row = document.createElement("div");
  row.className = "week";
  row.style.top = `${(weekIdx - MIN_WEEK) * rowHeight}px`;
  renderWeekContents(row, weekIdx, ctx());
  sizer.appendChild(row);
  mounted.set(weekIdx, row);
}

function layout(): void {
  const [first, last] = visibleWeekRange();
  const lo = Math.max(MIN_WEEK, first - RENDER_BUFFER);
  const hi = Math.min(MAX_WEEK, last + RENDER_BUFFER);

  for (const [idx, el] of mounted) {
    if (idx < lo || idx > hi) {
      el.remove();
      mounted.delete(idx);
    }
  }
  for (let idx = lo; idx <= hi; idx++) {
    if (!mounted.has(idx)) mountWeek(idx);
  }

  store.ensureRange(
    Math.max(MIN_WEEK, lo - PREFETCH_WEEKS),
    Math.min(MAX_WEEK, hi + PREFETCH_WEEKS),
  );

  positionMonthLabels();
  updateMinimap();
}

/** Week index of the first week to *begin* in a date's month (start day 1–7). */
function monthBoundaryWeek(d: Date): number {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const w = weekIndexOf(first, settings.weekStart);
  return weekStartDate(w, settings.weekStart).getMonth() === first.getMonth() ? w : w + 1;
}

/** A floating month label, lazily grown into a reusable pool. */
function pillAt(i: number): HTMLElement {
  let p = monthPills[i];
  if (!p) {
    p = document.createElement("div");
    p.className = "month-pill";
    monthOverlay.appendChild(p);
    monthPills[i] = p;
  }
  return p;
}

/**
 * Position the floating month labels — one deterministic spot per pill, so there
 * is never a second copy lagging a frame behind. Each month gets exactly one
 * pill: it rides the top border of the week that *begins* the month, then clamps
 * at the resting line once that week reaches the top edge. The label for the
 * month in effect stays docked there — it lives in this pinned overlay rather
 * than a week row, so it survives the rows being recycled beneath it. As the
 * next month's pill climbs to the line it shoves the docked one up out of sight,
 * a few px clear — the mirror of iOS's section headers.
 */
function positionMonthLabels(): void {
  const topPx = scroller.scrollTop;
  const viewportH = scroller.clientHeight - DOW_H;

  // All pills share one height; measure it to place the resting line.
  const probe = pillAt(0);
  probe.style.display = "";
  if (!probe.textContent) probe.textContent = " ";
  const labelH = probe.offsetHeight;
  const restCenter = 6 + labelH / 2; // matches the old pinned label's centre
  const sep = labelH + 6; // min centre-to-centre gap so two pills never touch

  // Docked label = latest month boundary at/above the resting line; then walk
  // forward over every boundary week still within the viewport.
  const thresholdWeek = Math.max(
    MIN_WEEK,
    Math.min(MAX_WEEK, MIN_WEEK + Math.floor((topPx + restCenter) / rowHeight)),
  );
  let b = Math.max(MIN_WEEK, monthBoundaryWeek(weekStartDate(thresholdWeek, settings.weekStart)));
  const lastWeek = MIN_WEEK + Math.ceil((topPx + viewportH) / rowHeight);
  const weeks: number[] = [];
  while (b <= lastWeek && b <= MAX_WEEK) {
    weeks.push(b);
    const bs = weekStartDate(b, settings.weekStart);
    b = monthBoundaryWeek(new Date(bs.getFullYear(), bs.getMonth() + 1, 1));
  }

  for (let i = 0; i < weeks.length; i++) {
    const rowTop = (weeks[i] - MIN_WEEK) * rowHeight - topPx;
    let center = Math.max(restCenter, rowTop); // never rise above the resting line
    if (i + 1 < weeks.length) {
      const nextTop = (weeks[i + 1] - MIN_WEEK) * rowHeight - topPx;
      center = Math.min(center, nextTop - sep); // the arriving pill pushes this one up
    }
    const pill = pillAt(i);
    pill.textContent = fmtMonthYear(weekStartDate(weeks[i], settings.weekStart));
    pill.style.display = "";
    // translateX(-50%) centres the pill on the first day column (its `left` is
    // that column's centre); translateY carries the docking / hand-off motion.
    pill.style.transform = `translateX(-50%) translateY(calc(${center}px - 50%))`;
  }
  for (let i = weeks.length; i < monthPills.length; i++) monthPills[i].style.display = "none";
}

let layoutQueued = false;
function queueLayout(): void {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layout();
  });
}

function rerenderMounted(): void {
  for (const [idx, row] of mounted) renderWeekContents(row, idx, ctx());
}

function unmountAll(): void {
  for (const el of mounted.values()) el.remove();
  mounted.clear();
}

function scrollToWeek(weekIdx: number, smooth: boolean): void {
  const clamped = Math.max(MIN_WEEK, Math.min(MAX_WEEK, weekIdx));
  scroller.scrollTo({
    top: (clamped - MIN_WEEK) * rowHeight,
    behavior: smooth ? "smooth" : "auto",
  });
}

/* ---------------- Active-view dispatch ---------------- */

/** Re-run layout for whichever view is on screen. */
function activeLayout(): void {
  if (!weekView) return; // pre-boot (applyCollapsed runs before the views exist)
  if (inWeekView()) weekView.layout();
  else queueLayout();
}

function activeAnchorDate(): Date {
  return inWeekView() ? weekView.anchorDate() : anchorDate();
}

function goToDate(date: Date, smooth: boolean): void {
  if (inWeekView()) weekView.scrollToDate(date, smooth);
  else scrollToWeek(weekIndexOf(date, settings.weekStart), smooth);
}

/** Inclusive day-number range on screen, in either view (drives the minimap). */
function visibleDayRange(): [number, number] {
  if (inWeekView()) return weekView.visibleDayRange();
  const [firstW, lastW] = visibleWeekRange();
  const firstDay = dayNumber(weekStartDate(firstW, settings.weekStart));
  return [firstDay, dayNumber(weekStartDate(lastW, settings.weekStart)) + 6];
}

function buildDowHeader(): void {
  dowRow.textContent = "";
  const start = weekStartDate(weekIndexOf(new Date(), settings.weekStart), settings.weekStart);
  for (let i = 0; i < 7; i++) {
    const el = document.createElement("div");
    el.className = "dow";
    el.textContent = fmtDow(addDays(start, i));
    dowRow.appendChild(el);
  }
}

/* ---------------- Zoom ---------------- */

function applyRowHeight(h: number, reanchor: boolean): void {
  const keep = anchorWeek();
  rowHeight = Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, Math.round(h)));
  settings.rowHeight = rowHeight;
  saveSettings();

  document.documentElement.style.setProperty("--row-h", `${rowHeight}px`);
  sizer.style.height = `${TOTAL_WEEKS * rowHeight}px`;
  for (const [idx, row] of mounted) row.style.top = `${(idx - MIN_WEEK) * rowHeight}px`;
  rerenderMounted();
  if (reanchor) scrollToWeek(keep, false);
  layout();
}

/* ---------------- Sidebar ---------------- */

function applyCollapsed(collapsed: boolean): void {
  settings.sidebarCollapsed = collapsed;
  saveSettings();
  sidebar.classList.toggle("collapsed", collapsed);
  const btn = $("btn-sidebar");
  btn.textContent = collapsed ? "▸" : "◂";
  btn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  activeLayout();
}

/* ---------------- Year minimap ---------------- */

/**
 * The rail runs down the right edge in month view and along the bottom in week
 * view, matching whichever axis the calendar scrolls on. Every measurement is a
 * fraction of the year, so only the axis the fractions are written to changes.
 */
function miniHorizontal(): boolean {
  return inWeekView();
}

/** Place a fractional [start, start+size) band along the rail's own axis. */
function placeOnRail(el: HTMLElement, start: number, size: number): void {
  if (miniHorizontal()) {
    el.style.left = `${start * 100}%`;
    el.style.width = `${size * 100}%`;
    el.style.top = "";
    el.style.height = "";
  } else {
    el.style.top = `${start * 100}%`;
    el.style.height = `${size * 100}%`;
    el.style.left = "";
    el.style.width = "";
  }
}

function buildMinimap(year: number): void {
  miniYear = year;
  miniYearEl.textContent = String(year);
  miniMonths.textContent = "";
  const yearStart = dayNumber(new Date(year, 0, 1));
  const yearDays = dayNumber(new Date(year + 1, 0, 1)) - yearStart;
  const horiz = miniHorizontal();
  for (let m = 0; m < 12; m++) {
    const days = dayNumber(new Date(year, m + 1, 1)) - dayNumber(new Date(year, m, 1));
    const block = document.createElement("div");
    block.className = `mini-month${m % 2 ? " alt" : ""}`;
    block.style[horiz ? "width" : "height"] = `${(days / yearDays) * 100}%`;
    block.textContent = fmtMonthShort(new Date(year, m, 1));
    miniMonths.appendChild(block);
  }
}

function updateMinimap(): void {
  const year = activeAnchorDate().getFullYear();
  if (year !== miniYear) buildMinimap(year);

  const yearStart = dayNumber(new Date(year, 0, 1));
  const yearDays = dayNumber(new Date(year + 1, 0, 1)) - yearStart;
  const [firstDay, lastDay] = visibleDayRange();

  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  const from = clamp01((firstDay - yearStart) / yearDays);
  const to = clamp01((lastDay + 1 - yearStart) / yearDays);
  placeOnRail(miniViewport, from, to - from);

  const now = new Date();
  if (now.getFullYear() === year) {
    miniToday.hidden = false;
    const at = `${((dayNumber(now) - yearStart) / yearDays) * 100}%`;
    if (miniHorizontal()) {
      miniToday.style.left = at;
      miniToday.style.top = "";
    } else {
      miniToday.style.top = at;
      miniToday.style.left = "";
    }
  } else {
    miniToday.hidden = true;
  }
}

function miniJump(clientX: number, clientY: number, smooth: boolean): void {
  if (Number.isNaN(miniYear)) return;
  const rect = miniTrack.getBoundingClientRect();
  const horiz = miniHorizontal();
  const size = horiz ? rect.width : rect.height;
  if (size === 0) return;
  const frac = Math.max(0, Math.min(1, ((horiz ? clientX - rect.left : clientY - rect.top)) / size));
  const yearStart = dayNumber(new Date(miniYear, 0, 1));
  const yearDays = dayNumber(new Date(miniYear + 1, 0, 1)) - yearStart;
  const day = Math.round(yearStart + frac * yearDays);
  goToDate(dateFromDayNumber(day), smooth);
}

/* ---------------- Toast ---------------- */

function showToast(message: string): void {
  $("toast-msg").textContent = message;
  toast.hidden = false;
}

/* ---------------- Calendars ---------------- */

function buildCalendarList(): void {
  const container = $("calendar-list");
  container.textContent = "";
  const sorted = [...store.calendars].sort(
    (a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name),
  );
  for (const cal of sorted) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = store.selectedIds.has(cal.id);
    box.addEventListener("change", () => {
      if (box.checked) store.selectedIds.add(cal.id);
      else store.selectedIds.delete(cal.id);
      settings.selectedCalendarIds = [...store.selectedIds];
      saveSettings();
      store.reset();
      rerenderMounted();
      weekView.rerender();
      activeLayout();
    });
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = cal.color;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = cal.name;
    label.append(box, dot, name);
    container.appendChild(label);
  }
}

function changeWeekStart(ws: WeekStart): void {
  if (ws === settings.weekStart) return;
  // Keep the user anchored on the same date across the re-indexing.
  const keepDate = activeAnchorDate();

  settings.weekStart = ws;
  saveSettings();
  store.weekStart = ws;
  store.reset();
  buildDowHeader();
  unmountAll();
  weekView.reset();
  applyView(settings.view, keepDate);
}

/* ---------------- View switching ---------------- */

function applyView(view: ViewMode, anchor: Date): void {
  settings.view = view;
  saveSettings();

  for (const [id, mode] of [
    ["tab-month", "month"],
    ["tab-week", "week"],
  ] as const) {
    const btn = $(id);
    btn.classList.toggle("is-active", view === mode);
    btn.setAttribute("aria-selected", String(view === mode));
  }

  // The rail follows the axis the calendar scrolls on, so it has to move
  // between its two slots and be rebuilt along the other dimension.
  minimap.classList.toggle("horizontal", view === "week");
  $(view === "week" ? "mini-slot-h" : "mini-slot-v").appendChild(minimap);
  miniYear = NaN;

  // Wake / sleep and the vertical (hour-height) zoom only mean something against
  // a time grid, so they're week-view only.
  $("side-hours").hidden = view !== "week";
  vzoomRow.hidden = view !== "week";

  // The horizontal slider has two meanings: week-row height, or day-column width.
  if (view === "week") {
    scroller.hidden = true;
    zoomInput.min = String(MIN_DAY_W);
    zoomInput.max = String(MAX_DAY_W);
    zoomInput.value = String(settings.dayWidth);
    weekView.activate(anchor);
    vzoomInput.value = String(weekView.currentHourHeight());
  } else {
    weekView.hide();
    scroller.hidden = false;
    zoomInput.min = String(MIN_ROW_H);
    zoomInput.max = String(MAX_ROW_H);
    zoomInput.value = String(rowHeight);
    scrollToWeek(weekIndexOf(anchor, settings.weekStart), false);
    layout();
  }
}

function switchView(view: ViewMode): void {
  if (view === settings.view) return;
  applyView(view, activeAnchorDate());
}

function applyDayWidth(width: number): void {
  settings.dayWidth = Math.max(MIN_DAY_W, Math.min(MAX_DAY_W, Math.round(width)));
  saveSettings();
  weekView.applyDayWidth(settings.dayWidth, true);
}

function resetZoom(): void {
  const value = inWeekView() ? DEFAULT_DAY_W : DEFAULT_ROW_H;
  zoomInput.value = String(value);
  if (inWeekView()) applyDayWidth(value);
  else applyRowHeight(value, true);
}

/* ---------------- Boot ---------------- */

async function start(): Promise<void> {
  showScreen("loading");
  try {
    const entries = await listCalendars();
    store.calendars = entries
      .filter((e) => !e.hidden)
      .map(
        (e): CalendarInfo => ({
          id: e.id,
          name: e.summaryOverride || e.summary || e.id,
          color: e.backgroundColor ?? "#7986cb",
          primary: !!e.primary,
          apiSelected: !!e.selected,
          accessRole: (e.accessRole as CalendarInfo["accessRole"]) ?? "reader",
        }),
      );

    // Saved choice wins; otherwise mirror what Google Calendar's UI shows.
    const ids =
      settings.selectedCalendarIds ??
      store.calendars.filter((c) => c.apiSelected || c.primary).map((c) => c.id);
    const known = new Set(store.calendars.map((c) => c.id));
    store.selectedIds = new Set(ids.filter((id) => known.has(id)));
    store.weekStart = settings.weekStart;
    store.reset();

    buildDowHeader();
    buildCalendarList();
    $<HTMLSelectElement>("week-start").value = String(settings.weekStart);

    showScreen("calendar");
    unmountAll();
    weekView.reset();
    miniYear = NaN;
    applyView(settings.view, new Date());
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      showScreen("signin");
      return;
    }
    $("boot-error-msg").textContent = err instanceof Error ? err.message : String(err);
    showScreen("boot-error");
  }
}

async function boot(): Promise<void> {
  await loadSettings();

  // Seed geometry from saved settings before first paint.
  document.documentElement.style.setProperty("--row-h", `${rowHeight}px`);
  zoomInput.min = String(MIN_ROW_H);
  zoomInput.max = String(MAX_ROW_H);
  zoomInput.value = String(rowHeight);
  applyCollapsed(settings.sidebarCollapsed);

  weekView = initWeekView({
    store,
    weekStart: () => settings.weekStart,
    todayKey: () => todayKey,
    dayWidth: () => settings.dayWidth,
    hourHeight: () => settings.hourHeight,
    dayHours: () => ({
      wake: settings.wakeMinutes,
      sleep: settings.sleepMinutes,
      clockIn: settings.clockInMinutes,
      clockOut: settings.clockOutMinutes,
    }),
    onEventClick: handleEventClick,
    onSlotClick: handleDayClick,
    onScroll: updateMinimap,
  });

  store.onUpdate = (firstWeek, lastWeek) => {
    for (const [idx, row] of mounted) {
      if (idx >= firstWeek && idx <= lastWeek) renderWeekContents(row, idx, ctx());
    }
    weekView.rerender();
    if (inWeekView()) weekView.layout(); // the all-day band may need more lanes
  };
  store.onError = (err) => {
    if (err instanceof AuthRequiredError) {
      // Scopes grew since the original grant — route back through consent.
      unmountAll();
      showScreen("signin");
      return;
    }
    showToast(`Couldn't load events — ${err.message}`);
  };

  scroller.addEventListener("scroll", queueLayout);
  window.addEventListener("resize", activeLayout);

  $("tab-month").addEventListener("click", () => switchView("month"));
  $("tab-week").addEventListener("click", () => switchView("week"));

  // Event drag: move timed chips between days, resize bars by their end dots.
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
  window.addEventListener("pointercancel", onDragCancel);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") onDragCancel();
  });
  // Persist any debounced setting immediately if the tab is closing/hidden.
  window.addEventListener("pagehide", () => {
    if (saveTimer !== undefined) flushSettings();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && saveTimer !== undefined) flushSettings();
  });

  $("btn-today").addEventListener("click", () => goToDate(new Date(), true));

  const dateJump = $<HTMLInputElement>("date-jump");
  dateJump.addEventListener("click", () => {
    try {
      dateJump.showPicker();
    } catch {
      /* falls back to the native focus behavior */
    }
  });
  dateJump.addEventListener("change", () => {
    if (!dateJump.value) return;
    goToDate(parseDateOnly(dateJump.value), false);
  });

  // Horizontal zoom — week-row height in month view, day-column width in week view.
  zoomInput.addEventListener("input", () => {
    const value = Number(zoomInput.value);
    if (inWeekView()) applyDayWidth(value);
    else applyRowHeight(value, true);
  });
  $("zoom-reset").addEventListener("click", resetZoom);

  // Vertical zoom (week view only) — an explicit hour height that overrides the
  // wake/sleep auto-fit until its own reset restores the fit.
  vzoomInput.min = String(MIN_HOUR_H);
  vzoomInput.max = String(MAX_HOUR_H);
  vzoomInput.step = "2";
  vzoomInput.addEventListener("input", () => {
    const value = Number(vzoomInput.value);
    settings.hourHeight = value;
    saveSettings();
    weekView.applyHourHeight(value);
  });
  $("vzoom-reset").addEventListener("click", () => {
    settings.hourHeight = null;
    saveSettings();
    weekView.refitDayHours();
    vzoomInput.value = String(weekView.currentHourHeight());
  });

  // Wake / sleep and clock-in / clock-out lines across the week grid.
  const wakeInput = $<HTMLInputElement>("wake-time");
  const sleepInput = $<HTMLInputElement>("sleep-time");
  const clockInInput = $<HTMLInputElement>("clockin-time");
  const clockOutInput = $<HTMLInputElement>("clockout-time");
  wakeInput.value = toTimeValue(settings.wakeMinutes);
  sleepInput.value = toTimeValue(settings.sleepMinutes);
  clockInInput.value = toTimeValue(settings.clockInMinutes);
  clockOutInput.value = toTimeValue(settings.clockOutMinutes);
  const applyDayHours = (): void => {
    saveSettings();
    weekView.refitDayHours();
    // Auto-fit may have changed the scale; keep the vertical slider in step.
    vzoomInput.value = String(weekView.currentHourHeight());
  };
  wakeInput.addEventListener("change", () => {
    settings.wakeMinutes = fromTimeValue(wakeInput.value);
    applyDayHours();
  });
  sleepInput.addEventListener("change", () => {
    settings.sleepMinutes = fromTimeValue(sleepInput.value);
    applyDayHours();
  });
  clockInInput.addEventListener("change", () => {
    settings.clockInMinutes = fromTimeValue(clockInInput.value);
    applyDayHours();
  });
  clockOutInput.addEventListener("change", () => {
    settings.clockOutMinutes = fromTimeValue(clockOutInput.value);
    applyDayHours();
  });
  $("hours-clear").addEventListener("click", () => {
    settings.wakeMinutes = null;
    settings.sleepMinutes = null;
    settings.clockInMinutes = null;
    settings.clockOutMinutes = null;
    wakeInput.value = "";
    sleepInput.value = "";
    clockInInput.value = "";
    clockOutInput.value = "";
    applyDayHours();
  });

  // Sidebar collapse (either toggle button)
  $("btn-sidebar").addEventListener("click", () => applyCollapsed(!settings.sidebarCollapsed));
  $("btn-sidebar-expand").addEventListener("click", () => applyCollapsed(false));

  // Minimap: click to jump, drag to scrub.
  let miniDragging = false;
  miniTrack.addEventListener("mousedown", (e) => {
    miniDragging = true;
    miniJump(e.clientX, e.clientY, false);
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (miniDragging) miniJump(e.clientX, e.clientY, false);
  });
  window.addEventListener("mouseup", () => {
    miniDragging = false;
  });

  const calPanel = $<HTMLElement>("cal-panel");
  $("btn-settings").addEventListener("click", (e) => {
    e.stopPropagation();
    calPanel.hidden = true;
    panel.hidden = !panel.hidden;
  });
  $("btn-calendars").addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = true;
    calPanel.hidden = !calPanel.hidden;
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  calPanel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => {
    panel.hidden = true;
    calPanel.hidden = true;
  });

  $<HTMLSelectElement>("week-start").addEventListener("change", (e) => {
    changeWeekStart(Number((e.target as HTMLSelectElement).value) as WeekStart);
  });

  $("btn-signout").addEventListener("click", async () => {
    panel.hidden = true;
    await signOut();
    unmountAll();
    showScreen("signin");
  });

  $("btn-signin").addEventListener("click", async () => {
    const errEl = $("signin-error");
    errEl.hidden = true;
    try {
      await signIn();
      await start();
    } catch (err) {
      errEl.textContent = err instanceof Error ? err.message : String(err);
      errEl.hidden = false;
    }
  });

  $("btn-boot-retry").addEventListener("click", () => void start());
  $("btn-toast-retry").addEventListener("click", () => {
    toast.hidden = true;
    store.retryErrors();
  });
  $("btn-toast-close").addEventListener("click", () => {
    toast.hidden = true;
  });

  // Roll the "today" highlight over at midnight; nudge the week grid's
  // current-time line along on every tick.
  setInterval(() => {
    const key = dayKey(new Date());
    if (key !== todayKey) {
      todayKey = key;
      rerenderMounted();
      weekView.rerender();
      updateMinimap();
    } else {
      weekView.tick();
    }
  }, 60_000);

  sizer.style.height = `${TOTAL_WEEKS * rowHeight}px`;

  editor = initEditor({
    getWritableCalendars: () => store.calendars.filter(canWriteCalendar),
    onSaved: handleSaved,
    onAuthRequired: () => {
      unmountAll();
      showScreen("signin");
    },
  });

  initClock(settings, saveSettings);

  try {
    await ensureSignedIn();
  } catch {
    showScreen("signin");
    return;
  }
  await start();
}

void boot();
