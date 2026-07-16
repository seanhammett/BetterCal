import {
  addDays,
  dayKey,
  dayNumber,
  fmtMonthShort,
  fmtMonthYear,
  isoWeek,
  weekStartDate,
} from "./dates.js";
import type { DragMode } from "./drag.js";
import { CHIP_H, type SpanBox, type TimedBox, layoutWeek, topForRow } from "./layout.js";
import type { EventStore } from "./store.js";
import type { CalEvent, WeekStart } from "./types.js";

export interface DragPreview {
  event: CalEvent;
  startDay: number;
  endDay: number;
}

export interface RenderCtx {
  store: EventStore;
  weekStart: WeekStart;
  todayKey: string;
  rowHeight: number;
  /** Click on an event chip/bar. */
  onEventClick(event: CalEvent): void;
  /** Click on empty space in a day cell (create flow). */
  onDayClick(date: Date): void;
  /** Whether this event may be edited (and therefore dragged). */
  canEditEvent(event: CalEvent): boolean;
  /** Pointer went down on a draggable chip or on a resize handle. */
  onEventDragStart(event: CalEvent, mode: DragMode, e: PointerEvent): void;
  /** While dragging: the dragged event drawn at a temporary day span. */
  dragPreview: DragPreview | null;
}

function isDragged(e: CalEvent, ctx: RenderCtx): boolean {
  const p = ctx.dragPreview;
  return !!p && p.event.id === e.id && p.event.calendarId === e.calendarId;
}

/** Black or white text depending on the chip's background luminance. */
function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1f2328" : "#ffffff";
}

function openDayInGoogleCalendar(d: Date): void {
  const url = `https://calendar.google.com/calendar/u/0/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  window.open(url, "_blank");
}

/** Position an absolutely-placed element across [col, col+cols) at a row. */
function place(el: HTMLElement, col: number, cols: number, row: number): void {
  el.style.left = `calc(${col} / 7 * 100% + 3px)`;
  el.style.width = `calc(${cols} / 7 * 100% - 6px)`;
  el.style.top = `${topForRow(row)}px`;
  el.style.height = `${CHIP_H}px`;
}

/** Small dot on a bar's top corner that drags the start/end day. */
function buildHandle(e: CalEvent, mode: "start" | "end", ctx: RenderCtx): HTMLElement {
  const h = document.createElement("span");
  h.className = `hdl hdl-${mode === "start" ? "l" : "r"}`;
  h.title = mode === "start" ? "Drag to change start day" : "Drag to change end day";
  h.addEventListener("pointerdown", (pe) => {
    pe.stopPropagation();
    ctx.onEventDragStart(e, mode, pe);
  });
  return h;
}

function buildSpan(box: SpanBox, ctx: RenderCtx): HTMLElement {
  const e = box.event;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "chip banner";
  if (box.continuesLeft) el.classList.add("cont-l");
  if (box.continuesRight) el.classList.add("cont-r");
  if (isDragged(e, ctx)) el.classList.add("dragging");
  el.style.background = e.color;
  el.style.color = contrastText(e.color);
  el.title = e.title;

  const title = document.createElement("span");
  title.className = "ctitle";
  title.textContent = e.title;
  el.appendChild(title);

  if (ctx.canEditEvent(e)) {
    if (!box.continuesLeft) {
      el.classList.add("cut-l"); // mask punches the blip out of the bar
      el.appendChild(buildHandle(e, "start", ctx));
    }
    if (!box.continuesRight) {
      el.classList.add("cut-r");
      el.appendChild(buildHandle(e, "end", ctx));
    }
  }

  place(el, box.colStart, box.colEnd - box.colStart + 1, box.lane);
  el.addEventListener("click", () => ctx.onEventClick(e));
  return el;
}

function buildTimed(box: TimedBox, ctx: RenderCtx): HTMLElement {
  const e = box.event;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "chip timed";
  if (isDragged(e, ctx)) el.classList.add("dragging");
  el.title = e.timeLabel ? `${e.timeLabel} ${e.title}` : e.title;
  if (ctx.canEditEvent(e)) {
    el.addEventListener("pointerdown", (pe) => ctx.onEventDragStart(e, "move", pe));
  }

  const dot = document.createElement("span");
  dot.className = "cdot";
  dot.style.background = e.color;
  el.appendChild(dot);
  if (e.timeLabel) {
    const time = document.createElement("span");
    time.className = "ctime";
    time.textContent = e.timeLabel;
    el.appendChild(time);
  }
  const title = document.createElement("span");
  title.className = "ctitle";
  title.textContent = e.title;
  el.appendChild(title);

  place(el, box.col, 1, box.row);
  el.addEventListener("click", () => ctx.onEventClick(e));
  return el;
}

function buildMore(col: number, row: number, count: number, date: Date): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "more";
  el.textContent = `+${count} more`;
  el.title = "Open this day in Google Calendar";
  place(el, col, 1, row);
  el.addEventListener("click", () => openDayInGoogleCalendar(date));
  return el;
}

function buildSkeleton(col: number, cols: number, row: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "skel";
  place(el, col, cols, row);
  return el;
}

/** (Re)fill a positioned .week row with its background cells and event layer. */
export function renderWeekContents(row: HTMLElement, weekIdx: number, ctx: RenderCtx): void {
  const { store, weekStart, todayKey, rowHeight } = ctx;
  row.textContent = "";

  const start = weekStartDate(weekIdx, weekStart);
  const firstDay = dayNumber(start);
  const state = store.chunkStateForWeek(weekIdx);

  // Week number in the left gutter (ISO week of this row's Thursday).
  const wknum = document.createElement("div");
  wknum.className = "wknum";
  wknum.textContent = String(isoWeek(addDays(start, weekStart === 0 ? 4 : 3)));
  row.appendChild(wknum);

  // --- Background: 7 day cells (borders, shading, today, date numbers) ---
  const bg = document.createElement("div");
  bg.className = "week-bg";
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const cell = document.createElement("div");
    cell.className = `day ${date.getMonth() % 2 ? "m-odd" : "m-even"}${weekend ? " weekend" : ""}`;
    if (dayKey(date) === todayKey) cell.classList.add("today");
    cell.addEventListener("click", () => ctx.onDayClick(date));

    const head = document.createElement("div");
    head.className = "dhead";
    const num = document.createElement("span");
    num.className = "dnum";
    num.textContent = String(date.getDate());
    head.appendChild(num);
    if (date.getDate() === 1) {
      const mon = document.createElement("span");
      mon.className = "dmon";
      mon.textContent = fmtMonthShort(date);
      head.appendChild(mon);
    }
    cell.appendChild(head);
    bg.appendChild(cell);

    // A thin floating label marks where a new month begins, so the continuous
    // flow of weeks is never segmented at month boundaries.
    if (date.getDate() === 1) {
      const pill = document.createElement("div");
      pill.className = "month-pill";
      pill.style.left = `calc(var(--wk-gutter) + ${i} / 7 * (100% - var(--wk-gutter)))`;
      pill.textContent = fmtMonthYear(date);
      row.appendChild(pill);
    }
  }
  row.appendChild(bg);

  // --- Event layer: spanning bars + timed chips, positioned over the grid ---
  const ev = document.createElement("div");
  ev.className = "week-ev";
  if (state === "loaded" || state === "error") {
    // While dragging, draw the dragged event at its preview span instead of
    // its stored one (it may enter or leave this week mid-drag).
    let events = store.eventsForWeek(weekIdx);
    const p = ctx.dragPreview;
    if (p) {
      events = events.filter((e) => !(e.id === p.event.id && e.calendarId === p.event.calendarId));
      if (p.startDay <= firstDay + 6 && p.endDay >= firstDay) {
        events.push({ ...p.event, startDay: p.startDay, endDay: p.endDay });
      }
    }
    const lay = layoutWeek(events, firstDay, rowHeight);
    for (const s of lay.spans) ev.appendChild(buildSpan(s, ctx));
    for (const t of lay.timed) ev.appendChild(buildTimed(t, ctx));
    for (let c = 0; c < 7; c++) {
      if (lay.moreByCol[c] > 0) {
        ev.appendChild(buildMore(c, lay.moreRowByCol[c], lay.moreByCol[c], addDays(start, c)));
      }
    }
  } else {
    ev.appendChild(buildSkeleton(0, 3, 0));
    ev.appendChild(buildSkeleton(4, 2, 1));
    ev.appendChild(buildSkeleton(1, 2, 2));
  }
  row.appendChild(ev);
}
