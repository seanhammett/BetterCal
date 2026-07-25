# nonstop — Infinite Week Calendar

A Chrome extension (Manifest V3) that shows your Google Calendar as **one continuous scroll of weeks**, in two flavours you can switch between:

- **Month** — a vertically scrolling column of weeks. No month grids, no arbitrary breaks: scroll up for the past, down for the future, endlessly. A thin floating label marks where each new month begins so you never lose your bearings.
- **Week** — the same idea turned on its side: a Google-style time grid that scrolls **horizontally** through weeks, continuously, with a clear seam between one week and the next. You can sit halfway across a boundary and see the end of one week beside the start of the next.

## Features

- **Infinite scroll of weeks** — virtualized rendering in both views, so only the visible weeks (plus a buffer) exist in the DOM no matter how far you scroll.
- **Week grid with real time-of-day** — 7 day columns × 24 hour rows, events sized by their duration, overlapping events split side by side, an all-day banner band pinned above the grid, and a current-time line on today. Click any empty slot to create an event at that day and time.
- **Lazy, cached event fetching** — events load in 6-week chunks as you scroll into new date ranges; already-fetched ranges are never refetched.
- **Continuous multi-day events** — all-day and multi-day events render as single bars spanning their days (packed into lanes), the way Google Calendar does it; timed events stack in their day column below. In Week view a bar that crosses a week break is drawn *over* the seam and keeps the same lane on both sides, so a fortnight-long event reads as one unbroken ribbon — even when the bar above it finished back in the previous week.
- **Wake / sleep lines** — set your day's start and end in the sidebar and Week view draws a faint pair of rules straight across all seven days, so the hours you actually care about stand out from the other seventeen.
- **Today anchor** — opens scrolled to the current week with today highlighted; a **Today** button jumps back anytime.
- **Jump to any date** — a date picker scrolls you straight to that week.
- **Year minimap** — an always-visible VSCode-style overview rail that follows the axis you scroll on: down the right edge in Month view, along the bottom in Week view. The highlighted window tracks your scroll position, and you can click or drag to jump anywhere in the year.
- **Collapsible tool sidebar** — a left sidebar with the **Month / Week** tabs, a **zoom** slider (week-row height in Month view, day-column width in Week view — zoomed right out, Week view fits five-plus weeks side by side), the **wake / sleep** times and the **calendar show/hide** list; collapses to reclaim width.
- **Week numbers & weekend shading** — a small ISO week number in the left gutter (in Week view, a thin bar across the top of each week), and weekends tinted distinctly from weekdays.
- **Configurable week start** — Sunday or Monday (in ⚙).
- **Event editing** — click an empty day cell to create an event, click an event to edit or delete it (title, calendar, all-day or timed, multi-day, location, description). Recurring events and read-only calendars open in Google Calendar instead; "+N more" opens that day's view.
- **Drag to reschedule** — in Month view, drag a timed event to another day (time of day is kept), or grab the detached blip at either end of an all-day bar to change its start or end. Esc cancels a drag in progress. *(Week view is click-to-edit only for now — dragging there would mean changing the time of day, not just the day.)*
- **Sidebar clock** — a large live time in IBM Plex Sans' tabular figures (so the digits don't shuffle), with the weekday and the date on their own lines beneath it, plus any extra time zones you add.
- Light & dark theme (follows the system), IBM Plex Sans bundled in `fonts/` (no webfont requests), loading skeletons, and error toasts with retry.

## Privacy

nonstop collects nothing. There is no nonstop server, so there is nowhere for your data to go even in principle.

- **Two network destinations, both Google:** `www.googleapis.com` for the Calendar API, and `oauth2.googleapis.com` for revoking your token when you sign out. The manifest's `connect-src` pins those two hosts, so nothing else is reachable from the extension's pages.
- **Two permissions:** `identity` (to get a token for the Google account Chrome is already signed in to) and `storage` (display preferences only — chosen calendars, week start, zoom, view, wake/sleep times, clock time zones, sidebar state). Your events are held in memory for the session and never written to disk.
- **No location, no `tabs` permission, no analytics, no ads, no cookies, no remote code.** The service worker finds its own tab via `chrome.runtime.getContexts`, so Chrome never has to warn that nonstop can read your browsing history — it can't.
- OAuth scopes: `calendar.events`, `calendar.calendars`, `calendar.calendarlist` (read/write, so events can be created and edited in place; see `docs/EDITING_PLAN.md`).

Full policy: [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Prerequisites

- Chrome 116+ (Manifest V3, module service workers)
- Node.js 18+ (only to build; the built extension is plain JS)
- Chrome must be **signed in to a Google profile** — `chrome.identity.getAuthToken` uses the browser's Google account. (Chromium builds without Google API keys won't work.)

## 1. Build the extension

```bash
npm install
npm run build     # or: npm run watch (rebuild on change)
```

This bundles `src/` into `dist/`. The unpacked extension is the repository root itself (`manifest.json`, `calendar.html`, `styles.css`, `dist/`).

To build the Chrome Web Store zip instead:

```bash
npm run package   # -> build/bettercal-<version>.zip
```

The repo root is *not* what ships — it also holds `src/`, `node_modules/`, `docs/` and 44 fonts of which one is used. `scripts/package.mjs` therefore assembles the zip from an explicit allowlist (ten files, ~322 kB) and refuses to build if anything shipped references a file that isn't in it, if the versions in `manifest.json` and `package.json` disagree, or if the OAuth client ID is still a placeholder. See [`docs/STORE_LISTING.md`](docs/STORE_LISTING.md) for the submission process and [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) for what to check by hand.

## 2. Load the unpacked extension (first pass)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this project folder.
4. Note the **extension ID** shown on the card (e.g. `abcdefghijklmnopabcdefghijklmnop`). You'll need it for the OAuth client.

> The ID is derived from the folder path, so it stays stable on your machine as long as you load from the same directory. To pin the ID permanently (or share the extension with others), see [Stable extension ID](#optional-stable-extension-id) below.

## 3. Set up the Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a project (or reuse one).
2. **Enable the Calendar API**: *APIs & Services → Library → Google Calendar API → Enable*.
3. **Configure the OAuth consent screen**: *APIs & Services → OAuth consent screen*
   - User type: **External** (fine for personal use), fill in the app name and your email.
   - Scopes: add `.../auth/calendar.events`, `.../auth/calendar.calendars`, and `.../auth/calendar.calendarlist` (optional while in testing mode, but good hygiene).
   - **Test users**: add your own Google account. While the app is in "Testing" status only test users can authorize it — that's all you need for personal use.
   - Note: the calendar scopes are classified **sensitive** by Google. That's fine while the app is in Testing with you as a test user, but *distributing* the extension to other users would require Google's app verification process.
4. **Create the OAuth client**: *APIs & Services → Credentials → Create Credentials → OAuth client ID*
   - Application type: **Chrome Extension**
   - Item ID: paste the **extension ID** from step 2.
5. Copy the generated **Client ID** (`…apps.googleusercontent.com`).

## 4. Wire up the client ID

Edit `manifest.json` and replace the placeholder:

```json
"oauth2": {
  "client_id": "YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  ...
}
```

Then go back to `chrome://extensions` and click the **reload** (↻) icon on the nonstop card.

## 5. Use it

Click the nonstop toolbar icon — it opens (or refocuses) a full-page calendar tab. On first run, click **Connect Google Calendar** and approve the consent prompt. You'll land on the current week with today highlighted.

- Scroll up/down for earlier/later weeks — it just keeps going.
- **Today** jumps back to the current week; **Jump…** opens a date picker.
- **⚙** picks calendars, sets the week start day, and signs out.

## Optional: stable extension ID

If you want the extension ID to be identical everywhere (e.g., across machines or teammates), add a `"key"` to `manifest.json`:

1. Load the extension once, then find its `key` value: on macOS it's in
   `~/Library/Application Support/Google/Chrome/Default/Extensions/<ID>/<version>/manifest.json`
   — or pack the extension (`chrome://extensions` → Pack extension) and extract the public key from the generated `.pem`.
2. Add `"key": "<that-base64-public-key>"` to `manifest.json` and reload. The ID is now derived from the key, not the folder path.

## Token handling & troubleshooting

- **Token refresh** is automatic: tokens come from `chrome.identity.getAuthToken`, and on any `401` the extension drops the cached token and silently mints a fresh one before retrying.
- **After a scope change** (e.g. updating from a read-only build): the old grant no longer covers the new scopes, so the extension shows the connect screen again (or a 403 routes you there). Click **Connect Google Calendar** and approve the new consent prompt once.
- **"OAuth2 not granted or revoked"** — you haven't approved consent yet, or you revoked it; the extension shows the connect screen, just click through again.
- **"bad client id" / "invalid OAuth2 Client ID"** — the client ID in `manifest.json` doesn't match a Chrome-Extension-type OAuth client bound to your current extension ID. Re-check step 3.4 (the Item ID must equal the ID on `chrome://extensions`), and reload the extension after editing the manifest.
- **403 "Google Calendar API has not been used in project…"** — enable the Calendar API (step 3.2).
- **Consent screen says "unverified app"** — expected while the Cloud project is in Testing; proceed via *Continue* (you must be listed as a test user). Clearing this for other people means OAuth verification — see [`docs/STORE_LISTING.md`](docs/STORE_LISTING.md) §5.
- **Works unpacked, "bad client id" once installed from the store** — the store issues a different extension ID than the local unpacked build, and the OAuth client is bound to one specific ID. You need a client for each. STORE_LISTING.md §2.
- **Changed the manifest but nothing happened** — unpacked extensions need a manual reload from `chrome://extensions`.

## Project layout

```
manifest.json        MV3 manifest (OAuth client ID + scopes live here)
calendar.html        the full-page calendar tab
styles.css           all styling (light/dark)
fonts/               IBM Plex Sans (only the variable upright file is referenced)
src/
  background.ts      service worker: toolbar icon opens/focuses the tab
  main.ts            boot, auth flow, virtualized week list, toolbar/panel
  render.ts          renders one week row (7 day cells, month pill, chips)
  store.ts           chunked event cache keyed by day
  gcal.ts            Calendar API client (pagination, error mapping)
  auth.ts            getAuthToken wrapper, 401 retry, sign-out/revoke
  weekview.ts        the horizontal week grid (hours, all-day band, seams)
  layout.ts          lane packing, overlap clustering, week-grid geometry
  widgets.ts         sidebar clock and extra time zones
  dates.ts           week-index math, formatting (DST-safe day numbering)
  types.ts           shared types
dist/                esbuild output (what the manifest points at)
scripts/
  package.mjs        assembles the store zip from an allowlist, with checks
  gen-icons.mjs      regenerates the sun icons (pure Node, no image libraries)
docs/
  PRIVACY.md         the privacy policy that has to be hosted for the listing
  STORE_LISTING.md   submission process, permission justifications, OAuth verification
  RELEASE_CHECKLIST.md  pre-upload checks and the privacy invariants behind them
  EDITING_PLAN.md    design notes for the event editor
build/               the packaged zip (gitignored)
```

### How the infinite scroll works

Every week has a fixed row height, and the scroll area is a single spacer sized for ±50 years of weeks (~5,200 rows — effectively infinite, but with trivial scroll math). On scroll, the visible week range is computed from `scrollTop`, only those rows (+3 buffer weeks) are kept in the DOM, and the event store is asked to `ensureRange(visible ± 12 weeks)`. The store fetches aligned 6-week chunks per selected calendar, buckets events by local day, and never refetches a chunk it already has.
