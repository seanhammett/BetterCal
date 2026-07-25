# nonstop — Privacy Policy

**Last updated: 23 July 2026**

nonstop is a Chrome extension that displays your Google Calendar as a
continuous scroll of weeks. It collects nothing.

There is no nonstop server. The developer operates no backend, no analytics
endpoint and no log collection, and therefore never receives your calendar data
or anything else about you. Your calendar data travels between your own browser
and Google, and nowhere else.

## What nonstop accesses

With your permission, nonstop reads and writes your Google Calendar through
Google's Calendar API, using these OAuth scopes:

| Scope | Why |
| --- | --- |
| `calendar.calendarlist` | List the calendars in your account so you can choose which to show, and read each one's colour and name. |
| `calendar.calendars` | Read calendar metadata (time zone, access role) needed to lay events out correctly and to know which calendars you may edit. |
| `calendar.events` | Read the events shown in the grid, and create, edit, move and delete events when you use the editor. |

These requests are made from your browser directly to `www.googleapis.com`, and
authorized with a token that Chrome issues for the Google account you are signed
in to. The developer has no access to that token and no access to your calendar.

## What nonstop stores

**On your device, in memory only:** the calendar events currently on screen, plus
a cache of nearby weeks so scrolling doesn't refetch. This is discarded when the
tab is closed. Events are never written to disk.

**In `chrome.storage.sync`:** your display preferences only —

- which calendars you have shown or hidden (calendar IDs)
- week start day (Sunday or Monday)
- zoom levels for each view, and which view was last open
- wake / sleep times, if you set them
- extra time zones you have added to the sidebar clock
- whether the sidebar is collapsed

`chrome.storage.sync` is Chrome's own settings sync. If you have Chrome sync
enabled these preferences sync between your Chrome profiles via Google, under
Google's privacy policy. They never reach the developer. No event titles, times,
descriptions, locations or attendees are ever stored there.

nonstop does not use cookies, `localStorage`, `sessionStorage` or IndexedDB.

## Where nonstop connects

Two hosts, both Google, both enforced by the extension's Content Security Policy
so that nothing else is even reachable from the extension's pages:

- `https://www.googleapis.com` — the Google Calendar API.
- `https://oauth2.googleapis.com` — used **only** when you click Sign out, to
  revoke the access token so the grant is removed from your Google account
  rather than just cleared locally.

nonstop makes no other network requests. Fonts are bundled inside the
extension rather than fetched from a font CDN, so even loading the page contacts
nobody.

## What nonstop does not do

- No analytics, telemetry, crash reporting or usage statistics.
- No advertising, and no advertising or tracking identifiers.
- No selling or transfer of data to anyone. There is nothing to sell.
- No location access. nonstop does not request the geolocation permission.
- No access to your browsing history, tabs or the pages you visit. nonstop
  does not request the `tabs` permission and cannot see any page but its own.
- No remotely hosted or remotely evaluated code. All code ships inside the
  package and is reviewable in the source repository.

## Children

nonstop is a general-audience utility and is not directed at children.

## Removing your data

Click **⚙ → Sign out** in nonstop. This revokes the OAuth token, so nonstop's
access to your calendar ends immediately. You can confirm or repeat this at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

Uninstalling the extension removes its stored preferences along with it. To clear
preferences that have already synced to other machines, sign in to each Chrome
profile and uninstall there too.

## Changes

Any change to this policy will be published in the extension's repository with
the "Last updated" date above revised. Material changes will also be noted in
the Chrome Web Store listing.

## Contact

Questions about this policy: **seanwhammett@gmail.com**
