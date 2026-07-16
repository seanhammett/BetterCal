import { addDays, dayKey, parseDateOnly } from "./dates.js";
import type { CalEvent, GApiEventTime } from "./types.js";

/** How a drag changes an event: whole-event move, or one end of the span. */
export type DragMode = "move" | "start" | "end";

/** Shift an API start/end by whole days, preserving the wall-clock time. */
export function shiftEventTime(t: GApiEventTime, deltaDays: number): GApiEventTime {
  if (deltaDays === 0) return { ...t };
  if (t.date) return { date: dayKey(addDays(parseDateOnly(t.date), deltaDays)) };
  if (t.dateTime) {
    // Shift in local wall-clock components so the displayed hour survives DST.
    const d = new Date(t.dateTime);
    const s = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() + deltaDays,
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
      d.getMilliseconds(),
    );
    return { dateTime: s.toISOString() };
  }
  return { ...t };
}

/** New inclusive day span for a drag, clamped so the event never inverts. */
export function dragDays(
  ev: CalEvent,
  mode: DragMode,
  pointerDay: number,
  grabDay: number,
): { startDay: number; endDay: number } {
  if (mode === "move") {
    const delta = pointerDay - grabDay;
    return { startDay: ev.startDay + delta, endDay: ev.endDay + delta };
  }
  if (mode === "start") {
    return { startDay: Math.min(pointerDay, ev.endDay), endDay: ev.endDay };
  }
  return { startDay: ev.startDay, endDay: Math.max(pointerDay, ev.startDay) };
}

/** PATCH body moving an event to a new inclusive day span; null if unchanged. */
export function buildDragPayload(
  ev: CalEvent,
  newStartDay: number,
  newEndDay: number,
): { start: GApiEventTime; end: GApiEventTime } | null {
  if (!ev.rawStart || !ev.rawEnd) return null;
  const dStart = newStartDay - ev.startDay;
  const dEnd = newEndDay - ev.endDay;
  if (dStart === 0 && dEnd === 0) return null;
  return {
    start: shiftEventTime(ev.rawStart, dStart),
    end: shiftEventTime(ev.rawEnd, dEnd),
  };
}
