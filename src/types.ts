export type WeekStart = 0 | 1; // 0 = Sunday, 1 = Monday

export interface Settings {
  weekStart: WeekStart;
  /** null until the user makes a choice; fall back to Google's "selected" flags. */
  selectedCalendarIds: string[] | null;
  /** Week-row height in px (zoom). */
  rowHeight: number;
  sidebarCollapsed: boolean;
  /** Extra IANA time zones shown under the clock. */
  timeZones: string[];
  /** Weather temperature unit; "auto" follows the browser locale. */
  tempUnit: "auto" | "c" | "f";
}

export type CalendarAccessRole = "owner" | "writer" | "reader" | "freeBusyReader";

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  primary: boolean;
  /** Whether Google Calendar's own UI shows this calendar (default selection). */
  apiSelected: boolean;
  accessRole: CalendarAccessRole;
}

/** Whether events on this calendar can be created/edited by the user. */
export function canWriteCalendar(cal: CalendarInfo): boolean {
  return cal.accessRole === "owner" || cal.accessRole === "writer";
}

/** A calendar event, stored once and laid out per week at render time. */
export interface EventChip {
  id: string;
  calendarId: string;
  title: string;
  htmlLink: string;
  color: string;
  /** Rendered as a spanning bar (all-day or multi-day). */
  banner: boolean;
  /** Inclusive local day-number range the event covers. */
  startDay: number;
  endDay: number;
  /** "9:30am" for timed events, "" for banners. */
  timeLabel: string;
  /** Minutes from local midnight; -1 for banners (sort first). */
  startMinutes: number;
  /** For optimistic-concurrency writes (If-Match). */
  etag?: string;
  /** Present on instances of a recurring series — these need special edit handling. */
  recurringEventId?: string;
  description?: string;
  location?: string;
  /** Raw API start/end, kept so the editor can prefill exact times. */
  rawStart?: GApiEventTime;
  rawEnd?: GApiEventTime;
}

/** Alias used by the layout/render modules. */
export type CalEvent = EventChip;

/* --- Raw Google Calendar API shapes (only the fields we use) --- */

export interface GApiCalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  primary?: boolean;
  backgroundColor?: string;
  selected?: boolean;
  hidden?: boolean;
  accessRole?: string;
}

export interface GApiEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GApiEvent {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: GApiEventTime;
  end?: GApiEventTime;
  /** Set on expanded instances of a recurring series. */
  recurringEventId?: string;
}

export interface GApiList<T> {
  items?: T[];
  nextPageToken?: string;
}
