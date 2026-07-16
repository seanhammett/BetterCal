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
 * Pack one week's events. Banner events (all-day or multi-day) are assigned to
 * lanes with a greedy interval colouring so a single event reads as one
 * continuous bar; timed events stack in their day column beneath the lanes,
 * with a per-day "+N more" once the row budget (from rowHeight) is exhausted.
 */
export function layoutWeek(events: CalEvent[], firstDay: number, rowHeight: number): WeekLayout {
  const lastDay = firstDay + 6;
  const maxRows = maxRowsFor(rowHeight);

  // --- Spanning bars: greedy lane assignment (sorted by start, longest first) ---
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
