# Plan: Creating & editing events and calendars

Today nonstop is **read-only**. This plan turns it into a read/write client. The
work splits cleanly into a foundation change (OAuth + a write-capable API layer)
and then feature phases layered on top. Recurring-event editing is deliberately
pushed late — it's the single biggest source of complexity.

## 0. Foundation — scopes & write transport ✅ *(done 2026-07-15)*

> Implemented: manifest scopes swapped to `calendar.events` + `calendar.calendars`
> + `calendar.calendarlist`; `authorizedFetch` accepts method/body/headers;
> `gcal.ts` gained `createEvent`/`patchEvent`(If-Match)/`deleteEvent`/`moveEvent`
> and the calendar CRUD calls, with 412→`ConflictError` and 403-insufficient-scope
> →`AuthRequiredError` (drops the cached token and routes to the connect screen,
> including mid-scroll via `store.onError`); `CalendarInfo.accessRole` +
> `canWriteCalendar()`; `CalEvent` carries `etag`/`recurringEventId`.

**OAuth scopes (breaking, user-visible).** Read-only scopes can't write. Change
`manifest.json`:

| Capability | Scope |
|---|---|
| Create/update/delete events | `…/auth/calendar.events` (replaces `calendar.events.readonly`) |
| Create/delete/rename calendars | `…/auth/calendar.calendars` |
| Recolor / show-hide calendars | `…/auth/calendar.calendarlist` (replaces `.readonly`) |

Consequences to handle in code and docs:
- `chrome.identity.getAuthToken` caches tokens **per scope set**. After a scope
  change the old grant is insufficient → first write returns **403 insufficient
  permissions**. Detect that, `removeCachedToken`, and run the interactive
  consent flow again. Add a one-time "reconnect to enable editing" prompt.
- The Google Cloud **OAuth consent screen** must list the new scopes. The
  calendar scopes are **sensitive** — fine for personal use / listed test users,
  but *distributing* to other users triggers Google verification (and the
  restricted-scope CASA security assessment). Call this out in the README.

**Write-capable fetch.** `auth.ts::authorizedFetch` is GET-only. Extend it to
take `{ method, body, headers }`, set `Content-Type: application/json`, keep the
existing 401→refresh-once retry, and add **412 (precondition failed)** handling
for `If-Match` etag conflicts.

**API methods in `gcal.ts`:**
- `createEvent(calId, resource)` → `POST /calendars/{calId}/events`
- `patchEvent(calId, eventId, resource, etag?)` → `PATCH …/events/{eventId}` with optional `If-Match`
- `deleteEvent(calId, eventId, sendUpdates)` → `DELETE …/events/{eventId}`
- `moveEvent(calId, eventId, destCalId)` → `POST …/events/{eventId}/move` (change calendar)
- `insertCalendar({summary})`, `deleteCalendar(id)`, `patchCalendar(id, {summary})`
- `patchCalendarListEntry(id, {backgroundColor, selected})` (color / visibility)

## 1. Single-event create / edit / delete ✅ *(done 2026-07-15)*

> Implemented: modal editor (`src/editor.ts` + markup in `calendar.html`) with
> title / calendar picker (writable only, create mode) / all-day toggle /
> start–end date+time / location / description; click an empty day cell to
> create, click an event to edit; two-stage delete confirm; save/delete then
> `store.invalidateWeeks()` + refetch of the touched chunks (chosen over
> optimistic-insert-with-rollback — the modal absorbs the latency and the
> refetch picks up server normalization for free). `ConflictError` (412)
> surfaces as an in-modal message; `AuthRequiredError` routes to consent.
> Recurring instances and read-only calendars open in Google Calendar instead.
> Deferred within this phase: moving an event between calendars (select is
> disabled in edit mode), `sendUpdates` exposure for events with guests.

The 80% feature. Non-recurring, one calendar, timed or all-day.

**Store changes (`store.ts`).** Keep the week-keyed cache but make writes
first-class:
- Extend `CalEvent` with `etag` and `recurringEventId`/`originalStart` (unused
  until phase 3) so edits can build a correct payload / send `If-Match`.
- **Optimistic update + reconcile:** on save, immediately insert/replace/remove
  the `CalEvent` in the affected week buckets and re-render; fire the API call;
  on success **refetch the touched chunk(s)** to pick up server normalization
  (all-day exclusive-end, DST, etc.); on failure roll back and toast. Refetching
  the chunk is simpler and more correct than trying to mirror Google's
  normalization locally.
- Gate writes on **`accessRole`** (add it to `CalendarInfo` from
  `calendarList`): only `owner`/`writer` calendars allow create/edit; readers
  are view-only. Non-writable calendars are hidden from the create picker.

**Editor UI (new `editor.ts` + modal in `calendar.html`).** A small vanilla
modal (backdrop, Esc-to-close, focus trap):
- Fields: title, calendar picker (writable only), all-day toggle, start/end
  date+time, description, location.
- Timezone: timed events need one — default to the calendar's `timeZone`
  (fetched once) or the browser zone; all-day events are date-only.
- `sendUpdates` (notify guests) defaults to `none` for personal use; expose only
  when the event has attendees.

**Entry points:**
- **Create:** click empty space in a day cell → editor prefilled with that date
  (all-day); or click-drag across day cells to prefill a multi-day range.
  Optionally a small "＋" on cell hover.
- **Edit:** clicking a chip currently opens Google Calendar. Change it to open
  the in-app editor, keeping an "Open in Google Calendar ↗" link inside. Delete
  lives in the editor.

## 2. Calendar management

In the sidebar **Calendars** section (already the home for show/hide):
- "＋ New calendar" (name + color) → `insertCalendar` then refresh calendar list.
- Per-calendar row menu: rename, recolor (`patchCalendarListEntry` background),
  delete (owned calendars only — you cannot delete calendars you don't own; hide
  the action otherwise). Recolor updates chips live via the existing color map.

## 3. Recurrence & direct manipulation (defer)

- **Recurring edits** need the "this event / this and following / all events"
  choice. Requires storing `recurringEventId` + `originalStartTime`, and mapping
  the choice to the right API call (instance PATCH, series split, or master
  PATCH). This is the main complexity sink — ship phases 1–2 first.
- **Drag-to-move / drag-edge-to-resize** bars ✅ *(day granularity, done
  2026-07-15)*: timed chips drag whole (`src/drag.ts` builds the shifted
  payload, wall-clock-preserving across DST); banner bars' editable ends are
  cut into a detached vertical blip (a thin slice masked out of the bar
  itself) that drags the start/end day, clamped so the span never inverts. Commit is optimistic (`store.applyDayShift` re-buckets
  locally, `patchEvent` with If-Match confirms; failure refetches). Live
  preview via `RenderCtx.dragPreview`. Time-of-day dragging (within a day) is
  out of scope for a month view.

## Testing

- Pure logic — API payload builders, date↔RFC3339 conversion, all-day
  exclusive-end handling, recurrence-choice mapping — unit-tested with the
  existing `esbuild → node --input-type=module` assertion harness.
- Manual round-trips (create/edit/delete/recolor) against a throwaway calendar
  before each phase lands.

## Open decisions (recommendations)

1. **Scope breadth:** granular (`calendar.events` + `calendar.calendars` +
   `calendar.calendarlist`) over the single broad `calendar` scope — least
   privilege, and clearer on the consent screen. *(Recommended.)*
2. **Edit surface:** in-app editor modal (this is the point of the feature),
   with the Google Calendar deep-link kept as a secondary action.
3. **Recurrence:** ship as a later phase; until then, route edits of recurring
   instances to Google Calendar via the existing link so we never silently do
   the wrong thing.
