import {
  WEEKS_PER_CHUNK,
  chunkOfWeek,
  dateFromDayNumber,
  dayNumber,
  fmtTime,
  parseDateOnly,
  weekIndexOf,
  weekStartDate,
} from "./dates.js";
import { listEvents } from "./gcal.js";
import type { CalEvent, CalendarInfo, GApiEvent, GApiEventTime, WeekStart } from "./types.js";

export type ChunkState = "loading" | "loaded" | "error";

/**
 * Caches events keyed by week index, fetched lazily in aligned multi-week
 * chunks so scrolling never refetches a range it has already seen. A multi-day
 * event is stored in every week it touches (clamped to its chunk) so each week
 * can lay it out as a continuous spanning bar.
 */
export class EventStore {
  private weeks = new Map<number, CalEvent[]>();
  private chunks = new Map<number, ChunkState>();
  /** Bumped on reset so in-flight responses for a stale config are discarded. */
  private generation = 0;

  calendars: CalendarInfo[] = [];
  selectedIds = new Set<string>();
  weekStart: WeekStart = 0;

  /** Called after a chunk loads, with the affected week range. */
  onUpdate: (firstWeek: number, lastWeek: number) => void = () => {};
  onError: (err: Error) => void = () => {};

  /** Drop all cached data (after calendar selection or week-start changes). */
  reset(): void {
    this.weeks.clear();
    this.chunks.clear();
    this.generation++;
  }

  chunkStateForWeek(weekIdx: number): ChunkState | undefined {
    return this.chunks.get(chunkOfWeek(weekIdx));
  }

  eventsForWeek(weekIdx: number): CalEvent[] {
    return this.weeks.get(weekIdx) ?? [];
  }

  /** Kick off fetches for any unfetched chunks covering [firstWeek, lastWeek]. */
  ensureRange(firstWeek: number, lastWeek: number): void {
    const first = chunkOfWeek(firstWeek);
    const last = chunkOfWeek(lastWeek);
    for (let c = first; c <= last; c++) {
      if (!this.chunks.has(c)) void this.fetchChunk(c);
    }
  }

  /**
   * Drop the chunks covering [firstWeek, lastWeek] so the next ensureRange
   * refetches them — used after a write to pick up the server's normalized
   * version instead of mirroring it locally.
   */
  invalidateWeeks(firstWeek: number, lastWeek: number): void {
    const firstC = chunkOfWeek(firstWeek);
    const lastC = chunkOfWeek(lastWeek);
    for (let c = firstC; c <= lastC; c++) {
      this.chunks.delete(c);
      for (let w = c * WEEKS_PER_CHUNK; w < (c + 1) * WEEKS_PER_CHUNK; w++) {
        this.weeks.delete(w);
      }
    }
  }

  /**
   * Optimistically move an event to a new inclusive day span (drag commit):
   * re-buckets it across weeks and updates its raw times in place. The caller
   * patches the server afterwards and refetches only on failure.
   */
  applyDayShift(
    ev: CalEvent,
    startDay: number,
    endDay: number,
    rawStart: GApiEventTime,
    rawEnd: GApiEventTime,
  ): void {
    const oldFirst = weekIndexOf(dateFromDayNumber(ev.startDay), this.weekStart);
    const oldLast = weekIndexOf(dateFromDayNumber(ev.endDay), this.weekStart);
    for (let w = oldFirst; w <= oldLast; w++) {
      const list = this.weeks.get(w);
      if (!list) continue;
      const i = list.findIndex((e) => e.id === ev.id && e.calendarId === ev.calendarId);
      if (i >= 0) list.splice(i, 1);
    }

    ev.startDay = startDay;
    ev.endDay = endDay;
    ev.rawStart = rawStart;
    ev.rawEnd = rawEnd;
    // A multi-day timed event dragged down to a single day becomes a plain chip.
    ev.banner = !rawStart.dateTime || endDay > startDay;
    if (!ev.banner && rawStart.dateTime) {
      const st = new Date(rawStart.dateTime);
      ev.startMinutes = st.getHours() * 60 + st.getMinutes();
      ev.timeLabel = fmtTime(st);
    } else {
      ev.startMinutes = -1;
      ev.timeLabel = "";
    }

    const newFirst = weekIndexOf(dateFromDayNumber(startDay), this.weekStart);
    const newLast = weekIndexOf(dateFromDayNumber(endDay), this.weekStart);
    for (let w = newFirst; w <= newLast; w++) {
      // Only weeks whose chunk is loaded — unloaded ranges fetch fresh anyway.
      if (this.chunks.get(chunkOfWeek(w)) !== "loaded") continue;
      let list = this.weeks.get(w);
      if (!list) {
        list = [];
        this.weeks.set(w, list);
      }
      if (!list.some((e) => e.id === ev.id && e.calendarId === ev.calendarId)) list.push(ev);
    }
  }

  retryErrors(): void {
    for (const [c, state] of this.chunks) {
      if (state === "error") {
        this.chunks.delete(c);
        void this.fetchChunk(c);
      }
    }
  }

  hasErrors(): boolean {
    for (const state of this.chunks.values()) if (state === "error") return true;
    return false;
  }

  private async fetchChunk(chunkIdx: number): Promise<void> {
    const gen = this.generation;
    this.chunks.set(chunkIdx, "loading");

    const firstWeek = chunkIdx * WEEKS_PER_CHUNK;
    const lastWeek = firstWeek + WEEKS_PER_CHUNK - 1;
    const timeMin = weekStartDate(firstWeek, this.weekStart);
    const timeMax = weekStartDate(lastWeek + 1, this.weekStart);

    try {
      const ids = [...this.selectedIds];
      const results = await Promise.all(ids.map((id) => listEvents(id, timeMin, timeMax)));
      if (gen !== this.generation) return; // config changed while in flight

      const touched = new Set<number>();
      results.forEach((events, i) => {
        for (const ev of events) this.ingest(ev, ids[i], firstWeek, lastWeek, touched);
      });

      this.chunks.set(chunkIdx, "loaded");
      this.onUpdate(firstWeek, lastWeek);
    } catch (err) {
      if (gen !== this.generation) return;
      this.chunks.set(chunkIdx, "error");
      this.onUpdate(firstWeek, lastWeek);
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Store an event in each week it covers, clamped to the chunk's week range so
   * an event spanning a chunk boundary (returned by both chunks' queries) is
   * written once per week by whichever chunk owns that week.
   */
  private ingest(
    ev: GApiEvent,
    calendarId: string,
    chunkFirstWeek: number,
    chunkLastWeek: number,
    touched: Set<number>,
  ): void {
    if (ev.status === "cancelled" || !ev.start || !ev.end) return;

    let startDay: number;
    let endDay: number;
    let startTime: Date | null = null;

    if (ev.start.date && ev.end.date) {
      startDay = dayNumber(parseDateOnly(ev.start.date));
      endDay = dayNumber(parseDateOnly(ev.end.date)) - 1; // end date is exclusive
    } else if (ev.start.dateTime && ev.end.dateTime) {
      startTime = new Date(ev.start.dateTime);
      startDay = dayNumber(startTime);
      // Subtract 1ms so an event ending exactly at midnight doesn't spill over.
      endDay = dayNumber(new Date(new Date(ev.end.dateTime).getTime() - 1));
    } else {
      return;
    }
    if (endDay < startDay) endDay = startDay;

    const banner = !startTime || endDay > startDay;
    const evt: CalEvent = {
      id: ev.id,
      calendarId,
      title: ev.summary || "(no title)",
      htmlLink: ev.htmlLink ?? "",
      color: this.calendars.find((c) => c.id === calendarId)?.color ?? "#7986cb",
      banner,
      startDay,
      endDay,
      timeLabel: !banner && startTime ? fmtTime(startTime) : "",
      startMinutes: banner ? -1 : startTime!.getHours() * 60 + startTime!.getMinutes(),
      etag: ev.etag,
      recurringEventId: ev.recurringEventId,
      description: ev.description,
      location: ev.location,
      rawStart: ev.start,
      rawEnd: ev.end,
    };

    const firstW = Math.max(chunkFirstWeek, weekIndexOf(dateFromDayNumber(startDay), this.weekStart));
    const lastW = Math.min(chunkLastWeek, weekIndexOf(dateFromDayNumber(endDay), this.weekStart));
    for (let w = firstW; w <= lastW; w++) {
      let list = this.weeks.get(w);
      if (!list) {
        list = [];
        this.weeks.set(w, list);
      }
      // Guard against a retried chunk re-delivering the same event.
      if (!list.some((e) => e.id === evt.id && e.calendarId === evt.calendarId)) {
        list.push(evt);
        touched.add(w);
      }
    }
  }
}
