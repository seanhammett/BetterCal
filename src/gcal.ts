import { AuthRequiredError, type FetchOptions, authorizedFetch, invalidateToken } from "./auth.js";
import type { GApiCalendarListEntry, GApiEvent, GApiList } from "./types.js";

const API = "https://www.googleapis.com/calendar/v3";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 412: the resource changed on the server since we read it (etag mismatch). */
export class ConflictError extends ApiError {
  constructor(message: string) {
    super(412, message);
    this.name = "ConflictError";
  }
}

interface GApiErrorBody {
  error?: {
    message?: string;
    status?: string;
    errors?: { reason?: string }[];
  };
}

async function apiFetch<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const res = await authorizedFetch(url, options);

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let reason = "";
    try {
      const body = (await res.json()) as GApiErrorBody;
      if (body.error?.message) detail = `${detail}: ${body.error.message}`;
      reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
    } catch {
      /* non-JSON error body */
    }

    // The grant predates a scope upgrade (read-only → read/write). Drop the
    // cached token and route the UI back through the interactive consent flow.
    if (
      res.status === 403 &&
      /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(`${reason} ${detail}`)
    ) {
      await invalidateToken();
      throw new AuthRequiredError(
        "This action needs updated Google Calendar permissions — please reconnect.",
      );
    }
    if (res.status === 412) throw new ConflictError(detail);
    throw new ApiError(res.status, detail);
  }

  // DELETE returns 204 with an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function fetchAllPages<T>(baseUrl: string): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const url = pageToken ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}` : baseUrl;
    const page = await apiFetch<GApiList<T>>(url);
    if (page.items) items.push(...page.items);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

/* ---------------- Read ---------------- */

export function listCalendars(): Promise<GApiCalendarListEntry[]> {
  return fetchAllPages<GApiCalendarListEntry>(
    `${API}/users/me/calendarList?maxResults=250&showHidden=false`,
  );
}

/** All events overlapping [timeMin, timeMax), recurrences expanded. */
export function listEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<GApiEvent[]> {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "2500",
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    fields:
      "nextPageToken,items(id,status,summary,htmlLink,start,end,etag,recurringEventId,description,location)",
  });
  return fetchAllPages<GApiEvent>(
    `${API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
  );
}

/* ---------------- Event writes ---------------- */

/** Fields a client may set when creating or patching an event. */
export type GApiEventInput = Pick<
  GApiEvent,
  "summary" | "description" | "location" | "start" | "end"
> & { recurrence?: string[] };

export type SendUpdates = "all" | "externalOnly" | "none";

export function createEvent(calendarId: string, resource: GApiEventInput): Promise<GApiEvent> {
  return apiFetch<GApiEvent>(`${API}/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body: resource,
  });
}

/**
 * Partial update. Pass the etag from the last read to fail (ConflictError)
 * instead of clobbering an event that changed on the server meanwhile.
 */
export function patchEvent(
  calendarId: string,
  eventId: string,
  resource: Partial<GApiEventInput>,
  etag?: string,
): Promise<GApiEvent> {
  return apiFetch<GApiEvent>(
    `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: resource,
      headers: etag ? { "If-Match": etag } : undefined,
    },
  );
}

export function deleteEvent(
  calendarId: string,
  eventId: string,
  sendUpdates: SendUpdates = "none",
): Promise<void> {
  return apiFetch<void>(
    `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
    { method: "DELETE" },
  );
}

/** Move an event to another calendar (changes its organizer/home calendar). */
export function moveEvent(
  calendarId: string,
  eventId: string,
  destinationCalendarId: string,
): Promise<GApiEvent> {
  const params = new URLSearchParams({ destination: destinationCalendarId });
  return apiFetch<GApiEvent>(
    `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}/move?${params}`,
    { method: "POST" },
  );
}

/* ---------------- Calendar writes ---------------- */

export function insertCalendar(summary: string): Promise<GApiCalendarListEntry> {
  return apiFetch<GApiCalendarListEntry>(`${API}/calendars`, {
    method: "POST",
    body: { summary },
  });
}

export function patchCalendar(
  calendarId: string,
  resource: { summary?: string; description?: string },
): Promise<void> {
  return apiFetch<void>(`${API}/calendars/${encodeURIComponent(calendarId)}`, {
    method: "PATCH",
    body: resource,
  });
}

/** Deletes a calendar you own. Irreversible; all its events are lost. */
export function deleteCalendar(calendarId: string): Promise<void> {
  return apiFetch<void>(`${API}/calendars/${encodeURIComponent(calendarId)}`, {
    method: "DELETE",
  });
}

/** Per-user list entry settings: color, visibility. */
export function patchCalendarListEntry(
  calendarId: string,
  resource: { backgroundColor?: string; foregroundColor?: string; selected?: boolean },
): Promise<GApiCalendarListEntry> {
  // colorRgbFormat is required when setting colors as hex values.
  const suffix = resource.backgroundColor || resource.foregroundColor ? "?colorRgbFormat=true" : "";
  return apiFetch<GApiCalendarListEntry>(
    `${API}/users/me/calendarList/${encodeURIComponent(calendarId)}${suffix}`,
    { method: "PATCH", body: resource },
  );
}
