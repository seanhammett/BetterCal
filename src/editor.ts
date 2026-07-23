import { AuthRequiredError } from "./auth.js";
import { addDays, dayKey, dayNumber, parseDateOnly } from "./dates.js";
import { ConflictError, type GApiEventInput, createEvent, deleteEvent, patchEvent } from "./gcal.js";
import type { CalEvent, CalendarInfo } from "./types.js";

export interface EditorDeps {
  /** Calendars the user may create/edit events on. */
  getWritableCalendars(): CalendarInfo[];
  /** Called after a successful write with the inclusive day range touched. */
  onSaved(minDay: number, maxDay: number): void;
  /** The grant went stale mid-write — route back through consent. */
  onAuthRequired(): void;
}

export interface Editor {
  /** `startMinutes` (from a week-grid slot click) overrides the default hour. */
  openCreate(date: Date, defaultCalendarId: string, startMinutes?: number): void;
  openEdit(event: CalEvent): void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const pad = (n: number) => String(n).padStart(2, "0");

/** "HH:MM" for a time input. */
function timeValue(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function combine(dateStr: string, timeStr: string): Date {
  const d = parseDateOnly(dateStr);
  const [h, m] = timeStr.split(":").map(Number);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h || 0, m || 0);
}

export function initEditor(deps: EditorDeps): Editor {
  const backdrop = $("editor-backdrop");
  const titleIn = $<HTMLInputElement>("ev-title");
  const calSelect = $<HTMLSelectElement>("ev-calendar");
  const alldayIn = $<HTMLInputElement>("ev-allday");
  const startDate = $<HTMLInputElement>("ev-start-date");
  const startTime = $<HTMLInputElement>("ev-start-time");
  const endDate = $<HTMLInputElement>("ev-end-date");
  const endTime = $<HTMLInputElement>("ev-end-time");
  const locationIn = $<HTMLInputElement>("ev-location");
  const descIn = $<HTMLTextAreaElement>("ev-desc");
  const errorEl = $("ev-error");
  const saveBtn = $<HTMLButtonElement>("ev-save");
  const deleteBtn = $<HTMLButtonElement>("ev-delete");
  const gcalLink = $<HTMLAnchorElement>("ev-gcal-link");
  const heading = $("ev-heading");

  let editing: CalEvent | null = null;
  let busy = false;

  function setError(msg: string): void {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function applyAllday(): void {
    startTime.hidden = alldayIn.checked;
    endTime.hidden = alldayIn.checked;
  }

  function fillCalendars(selectedId: string): void {
    calSelect.textContent = "";
    for (const cal of deps.getWritableCalendars()) {
      const opt = document.createElement("option");
      opt.value = cal.id;
      opt.textContent = cal.name;
      calSelect.appendChild(opt);
    }
    calSelect.value = selectedId;
  }

  function show(): void {
    setError("");
    applyAllday();
    resetDeleteButton();
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
    backdrop.hidden = false;
    titleIn.focus();
  }

  function close(): void {
    if (busy) return;
    backdrop.hidden = true;
    editing = null;
  }

  /* ---------- open ---------- */

  function openCreate(date: Date, defaultCalendarId: string, startMinutes?: number): void {
    editing = null;
    heading.textContent = "New event";
    fillCalendars(defaultCalendarId);
    calSelect.disabled = false;
    titleIn.value = "";
    locationIn.value = "";
    descIn.value = "";
    alldayIn.checked = false;
    // A one-hour event: at the clicked grid slot, else at the next full hour
    // (9:00 for other days).
    const now = new Date();
    const sameDay = dayKey(date) === dayKey(now);
    const startMin =
      startMinutes ?? (sameDay ? Math.min(now.getHours() + 1, 23) : 9) * 60;
    const endMin = Math.min(startMin + 60, 23 * 60 + 59);
    startDate.value = dayKey(date);
    endDate.value = dayKey(date);
    startTime.value = `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}`;
    endTime.value = `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`;
    deleteBtn.hidden = true;
    gcalLink.hidden = true;
    show();
  }

  function openEdit(ev: CalEvent): void {
    editing = ev;
    heading.textContent = "Edit event";
    fillCalendars(ev.calendarId);
    // Moving events between calendars is a separate API call — later phase.
    calSelect.disabled = true;
    titleIn.value = ev.title === "(no title)" ? "" : ev.title;
    locationIn.value = ev.location ?? "";
    descIn.value = ev.description ?? "";

    const allday = !!ev.rawStart?.date;
    alldayIn.checked = allday;
    if (allday) {
      startDate.value = ev.rawStart!.date!;
      // API end date is exclusive; the form shows the inclusive last day.
      endDate.value = dayKey(addDays(parseDateOnly(ev.rawEnd!.date!), -1));
      startTime.value = "09:00";
      endTime.value = "10:00";
    } else {
      const s = new Date(ev.rawStart!.dateTime!);
      const e = new Date(ev.rawEnd!.dateTime!);
      startDate.value = dayKey(s);
      startTime.value = timeValue(s);
      endDate.value = dayKey(e);
      endTime.value = timeValue(e);
    }

    deleteBtn.hidden = false;
    gcalLink.hidden = !ev.htmlLink;
    gcalLink.href = ev.htmlLink;
    show();
  }

  /* ---------- save / delete ---------- */

  function buildPayload(): GApiEventInput | string {
    if (!startDate.value || !endDate.value) return "Start and end dates are required.";
    const payload: GApiEventInput = {
      summary: titleIn.value.trim() || undefined,
      location: locationIn.value.trim() || undefined,
      description: descIn.value.trim() || undefined,
    };
    if (alldayIn.checked) {
      const s = parseDateOnly(startDate.value);
      const e = parseDateOnly(endDate.value);
      if (e < s) return "The end date is before the start date.";
      payload.start = { date: startDate.value };
      payload.end = { date: dayKey(addDays(e, 1)) }; // exclusive
    } else {
      if (!startTime.value || !endTime.value) return "Start and end times are required.";
      const s = combine(startDate.value, startTime.value);
      const e = combine(endDate.value, endTime.value);
      if (e <= s) return "The event must end after it starts.";
      payload.start = { dateTime: s.toISOString() };
      payload.end = { dateTime: e.toISOString() };
    }
    return payload;
  }

  function touchedRange(payload: GApiEventInput): [number, number] {
    let min = payload.start?.date
      ? dayNumber(parseDateOnly(payload.start.date))
      : dayNumber(new Date(payload.start!.dateTime!));
    let max = payload.end?.date
      ? dayNumber(parseDateOnly(payload.end.date)) - 1
      : dayNumber(new Date(new Date(payload.end!.dateTime!).getTime() - 1));
    if (editing) {
      min = Math.min(min, editing.startDay);
      max = Math.max(max, editing.endDay);
    }
    return [min, Math.max(min, max)];
  }

  async function save(): Promise<void> {
    if (busy) return;
    const payload = buildPayload();
    if (typeof payload === "string") {
      setError(payload);
      return;
    }
    busy = true;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      if (editing) {
        await patchEvent(editing.calendarId, editing.id, payload, editing.etag);
      } else {
        await createEvent(calSelect.value, payload);
      }
      const [min, max] = touchedRange(payload);
      busy = false;
      close();
      deps.onSaved(min, max);
    } catch (err) {
      busy = false;
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      if (err instanceof AuthRequiredError) {
        close();
        deps.onAuthRequired();
      } else if (err instanceof ConflictError) {
        setError("This event changed elsewhere in the meantime — close and reopen it to edit the latest version.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  function resetDeleteButton(): void {
    deleteBtn.textContent = "Delete";
    deleteBtn.classList.remove("confirm");
  }

  async function del(): Promise<void> {
    if (busy || !editing) return;
    // Two-stage confirm: first click arms, second click deletes.
    if (!deleteBtn.classList.contains("confirm")) {
      deleteBtn.textContent = "Really delete?";
      deleteBtn.classList.add("confirm");
      return;
    }
    busy = true;
    deleteBtn.disabled = true;
    try {
      await deleteEvent(editing.calendarId, editing.id);
      const { startDay, endDay } = editing;
      busy = false;
      deleteBtn.disabled = false;
      close();
      deps.onSaved(startDay, endDay);
    } catch (err) {
      busy = false;
      deleteBtn.disabled = false;
      resetDeleteButton();
      if (err instanceof AuthRequiredError) {
        close();
        deps.onAuthRequired();
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /* ---------- wiring ---------- */

  alldayIn.addEventListener("change", applyAllday);
  startDate.addEventListener("change", () => {
    // Keep the end on/after the start as the user moves the start date.
    if (endDate.value < startDate.value) endDate.value = startDate.value;
  });
  saveBtn.addEventListener("click", () => void save());
  deleteBtn.addEventListener("click", () => void del());
  $("ev-cancel").addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !backdrop.hidden) close();
    if (e.key === "Enter" && !backdrop.hidden && e.target === titleIn) void save();
  });

  return { openCreate, openEdit };
}
