import type { CalEvent } from "./types.js";

/** Geometry — DOW_H must match --dow-h in styles.css. */
export const DOW_H = 28;
/** Default / min / max week-row height (the zoom range). Must seed --row-h. */
export const DEFAULT_ROW_H = 150;
export const MIN_ROW_H = 104;
export const MAX_ROW_H = 300;
/** Space reserved at the top of a week row for the date numbers. */
export const HEADER_H = 24;
/** Vertical pitch of one event row (bar or chip), including its gap. */
const PITCH = 20;
export const CHIP_H = 18;

/** How many event rows (lanes + chips) fit in a week of the given height. */
export function maxRowsFor(rowHeight: number): number {
  return Math.max(1, Math.floor((rowHeight - HEADER_H - 4) / PITCH));
}

export function topForRow(row: number): number {
  return HEADER_H + row * PITCH;
}

/** A multi-day / all-day event drawn as a bar spanning columns in one lane. */
export interface SpanBox {
  event: CalEvent;
  lane: number;
  colStart: number;
  colEnd: number;
  continuesLeft: boolean;
  continuesRight: boolean;
}

/** A timed event drawn inside a single day column. */
export interface TimedBox {
  event: CalEvent;
  col: number;
  row: number;
}

export interface WeekLayout {
  spans: SpanBox[];
  timed: TimedBox[];
  moreByCol: number[];
  moreRowByCol: number[];
}

/**
 * Assign every banner (all-day or multi-day) event in a week to a lane with a
 * greedy interval colouring, so a single event reads as one continuous bar.
 * Shared by the month rows and the week grid's all-day band.
 */
export function layoutBanners(events: CalEvent[], firstDay: number): SpanBox[] {
  const lastDay = firstDay + 6;
  const banners = events
    .filter((e) => e.banner)
    .sort(
      (a, b) =>
        a.startDay - b.startDay ||
        b.endDay - b.startDay - (a.endDay - a.startDay) ||
        a.title.localeCompare(b.title),
    );

  const laneEnds: number[] = []; // last occupied column per lane
  const spans: SpanBox[] = [];
  for (const e of banners) {
    const colStart = Math.max(0, e.startDay - firstDay);
    const colEnd = Math.min(6, e.endDay - firstDay);
    let lane = 0;
    while (lane < laneEnds.length && laneEnds[lane] >= colStart) lane++;
    laneEnds[lane] = colEnd;
    spans.push({
      event: e,
      lane,
      colStart,
      colEnd,
      continuesLeft: e.startDay < firstDay,
      continuesRight: e.endDay > lastDay,
    });
  }
  return spans;
}

/**
 * Pack one week's events. Banner events (all-day or multi-day) are assigned to
 * lanes with a greedy interval colouring so a single event reads as one
 * continuous bar; timed events stack in their day column beneath the lanes,
 * with a per-day "+N more" once the row budget (from rowHeight) is exhausted.
 */
export function layoutWeek(events: CalEvent[], firstDay: number, rowHeight: number): WeekLayout {
  const maxRows = maxRowsFor(rowHeight);
  const spans = layoutBanners(events, firstDay);

  // --- Timed events: bucket per column, filling the lane slots left free in
  // that column — a chip floats up past bars that don't cover its own day ---
  const occupied: boolean[][] = Array.from({ length: 7 }, () => []);
  for (const s of spans) {
    for (let c = s.colStart; c <= s.colEnd; c++) occupied[c][s.lane] = true;
  }

  const byCol: CalEvent[][] = [[], [], [], [], [], [], []];
  for (const e of events) {
    if (e.banner) continue;
    const col = e.startDay - firstDay;
    if (col >= 0 && col <= 6) byCol[col].push(e);
  }
  for (const list of byCol) {
    list.sort((a, b) => a.startMinutes - b.startMinutes || a.title.localeCompare(b.title));
  }

  const timed: TimedBox[] = [];
  const moreByCol = new Array(7).fill(0);
  const moreRowByCol = new Array(7).fill(0);
  for (let c = 0; c < 7; c++) {
    const free: number[] = [];
    for (let r = 0; r < maxRows; r++) {
      if (!occupied[c][r]) free.push(r);
    }
    const list = byCol[c];
    const show = list.length > free.length ? Math.max(0, free.length - 1) : list.length;
    for (let i = 0; i < show; i++) timed.push({ event: list[i], col: c, row: free[i] });
    const hidden = list.length - show;
    if (hidden > 0 && free.length >= 1) {
      moreByCol[c] = hidden;
      moreRowByCol[c] = free[show];
    }
  }

  return { spans, timed, moreByCol, moreRowByCol };
}

/* ---------------- Week grid (the horizontal time-grid view) ---------------- */

/** Height of one hour row in the week grid. */
export const HOUR_H = 44;
/** Default / min / max day-column width (the week view's zoom range). */
export const DEFAULT_DAY_W = 160;
export const MIN_DAY_W = 88;
export const MAX_DAY_W = 340;
/** Gap between adjacent weeks — the seam that separates one week from the next. */
export const WEEK_GAP = 12;
/** Width of the pinned hour-label gutter down the left edge. */
export const HOUR_GUTTER_W = 54;
/** Height of the day-name/date header pinned above the grid. */
export const DAY_HEAD_H = 44;
/** Height of one all-day lane in the banner band, and how many can show. */
export const ALLDAY_LANE_H = 20;
export const ALLDAY_MAX_LANES = 3;
/** Shortest block the grid will draw, so a 10-minute event stays readable. */
const MIN_BLOCK_MIN = 25;

export function weekPitch(dayWidth: number): number {
  return dayWidth * 7 + WEEK_GAP;
}

/** Height of the all-day band for a given lane count (always shows one lane). */
export function allDayBandH(lanes: number): number {
  return Math.max(1, Math.min(ALLDAY_MAX_LANES, lanes)) * ALLDAY_LANE_H + 6;
}

/** A timed event placed in the grid: vertical from its times, horizontal by overlap. */
export interface GridBox {
  event: CalEvent;
  /** Fraction of the day column: [left, left + width). */
  left: number;
  width: number;
  top: number;
  height: number;
}

/**
 * Place one day's timed events in the grid. Events that overlap in time are
 * split across the day column side by side: a cluster is the transitive
 * closure of overlapping events, and within it each event takes the first
 * sub-column whose previous occupant has already ended.
 */
export function layoutDayGrid(events: CalEvent[], day: number): GridBox[] {
  const list = events
    .filter((e) => !e.banner && e.startDay === day)
    .sort((a, b) => a.startMinutes - b.startMinutes || b.endMinutes - a.endMinutes);
  if (list.length === 0) return [];

  const boxes: GridBox[] = [];
  const span = (e: CalEvent) => Math.max(e.endMinutes, e.startMinutes + MIN_BLOCK_MIN);

  // Walk the day once, cutting a new cluster wherever nothing is still running.
  let cluster: CalEvent[] = [];
  let clusterEnd = -1;

  const flush = (): void => {
    if (cluster.length === 0) return;
    const colEnds: number[] = []; // minute each sub-column frees up
    const assigned = cluster.map((e) => {
      let c = 0;
      while (c < colEnds.length && colEnds[c] > e.startMinutes) c++;
      colEnds[c] = span(e);
      return c;
    });
    const cols = colEnds.length;
    cluster.forEach((e, i) => {
      const end = span(e);
      boxes.push({
        event: e,
        left: assigned[i] / cols,
        width: 1 / cols,
        top: (e.startMinutes / 60) * HOUR_H,
        height: Math.max(((end - e.startMinutes) / 60) * HOUR_H, 12),
      });
    });
    cluster = [];
    clusterEnd = -1;
  };

  for (const e of list) {
    if (cluster.length > 0 && e.startMinutes >= clusterEnd) flush();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, span(e));
  }
  flush();
  return boxes;
}
