import type { WeekStart } from "./types.js";

export const DAY_MS = 86_400_000;

/**
 * The virtual list covers a fixed ±50-year window around the anchor —
 * far enough in both directions to feel infinite while keeping scroll
 * geometry simple (fixed row height × fixed week count).
 */
export const MIN_WEEK = -2600;
export const MAX_WEEK = 2600;
export const TOTAL_WEEKS = MAX_WEEK - MIN_WEEK + 1;

/** Events are fetched in aligned blocks of this many weeks. */
export const WEEKS_PER_CHUNK = 6;

/** Days since the Unix epoch for a local calendar date (DST-safe). */
export function dayNumber(d: Date): number {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

export function dateFromDayNumber(n: number): Date {
  const u = new Date(n * DAY_MS);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
}

// 2000-01-02 was a Sunday; 2000-01-03 a Monday. Week 0 starts on the anchor.
const ANCHOR: Record<WeekStart, number> = {
  0: dayNumber(new Date(2000, 0, 2)),
  1: dayNumber(new Date(2000, 0, 3)),
};

export function weekIndexOf(d: Date, weekStart: WeekStart): number {
  return Math.floor((dayNumber(d) - ANCHOR[weekStart]) / 7);
}

export function weekStartDate(weekIdx: number, weekStart: WeekStart): Date {
  return dateFromDayNumber(ANCHOR[weekStart] + weekIdx * 7);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function chunkOfWeek(weekIdx: number): number {
  return Math.floor(weekIdx / WEEKS_PER_CHUNK);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-07-09" for a local date. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse "YYYY-MM-DD" as a local date. */
export function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const monthYearFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const monthShortFmt = new Intl.DateTimeFormat(undefined, { month: "short" });
const dowFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function fmtMonthYear(d: Date): string {
  return monthYearFmt.format(d);
}

export function fmtMonthShort(d: Date): string {
  return monthShortFmt.format(d);
}

export function fmtDow(d: Date): string {
  return dowFmt.format(d);
}

/** ISO-8601 week number (weeks are Mon–Sun; week 1 contains the first Thursday). */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = (t.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  t.setUTCDate(t.getUTCDate() - dow + 3); // move to this week's Thursday
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDow + 3);
  return 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
}

/** Compact time: "9:30 PM" → "9:30pm", "9:00 AM" → "9am". */
export function fmtTime(d: Date): string {
  let s = timeFmt.format(d);
  if (/[AP]M/i.test(s)) s = s.replace(":00", "");
  return s.replace(/\s?([AP]M)/i, (m) => m.trim().toLowerCase());
}
