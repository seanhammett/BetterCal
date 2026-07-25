# Release checklist

Run through this before every Chrome Web Store upload. The submission process
itself is in [STORE_LISTING.md](STORE_LISTING.md); the privacy policy that has
to be hosted is [PRIVACY.md](PRIVACY.md).

```bash
npm run package        # typecheck, build, verify, zip
```

`scripts/package.mjs` already enforces the mechanical half of this list and
refuses to produce a zip if any of it fails.

## Automatic — the packager checks these

- [x] Only the ten shipping files are in the zip. `src/`, `docs/`,
      `node_modules/`, `.git`, `.DS_Store` and the 43 unused font cuts cannot
      get in: the file list is an allowlist, not an ignore list.
- [x] Nothing shipped references a file that isn't shipped — every `src`/`href`
      in `calendar.html`, every `url()` in `styles.css` and every path in the
      manifest must resolve inside the package. This is the failure mode where
      the unpacked build works and the store build 404s.
- [x] No placeholder OAuth client ID.
- [x] `manifest.json` and `package.json` versions agree.
- [x] Description ≤ 132 chars (the store truncates).
- [x] No `key` field in the manifest.
- [x] No `eval` / `new Function` in the bundles — the store rejects remotely
      evaluated code.
- [x] No leftover sourcemap comments.

## Manual — check by hand

- [ ] **Version bumped** in `manifest.json` *and* `package.json`.
- [ ] **OAuth client ID matches the store item's extension ID**, not the local
      unpacked one. See STORE_LISTING.md §2 — this is the single most likely
      thing to ship broken, because it works perfectly right up until someone
      installs from the store.
- [ ] **Privacy policy is live** at the URL entered in the dashboard, and its
      "Last updated" date reflects any change in this release.
- [ ] **Screenshots** regenerated if the UI changed materially.
- [ ] Clean-profile smoke test: install, connect, confirm the consent screen
      names the right scopes, scroll both views, create and edit an event, sign
      out, and confirm the grant is gone from
      [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Privacy posture — what must stay true

The listing claims nonstop collects no data. These are the invariants behind
that claim; breaking any one of them means the store disclosures have to change.

- **Two network destinations, both Google:** `www.googleapis.com` (Calendar API)
  and `oauth2.googleapis.com` (token revocation on sign out). The manifest's
  `connect-src` pins this, so a stray `fetch` fails loudly at runtime rather
  than quietly shipping.
- **No geolocation.** The sidebar weather widget was removed for 1.0 precisely
  because it read `navigator.geolocation` and sent coordinates to
  `api.open-meteo.com`. Restoring it means declaring location collection on the
  listing — it is not a free feature any more. It is recoverable from git
  history if that trade is ever worth making.
- **No `tabs` permission.** The service worker finds its own tab with
  `chrome.runtime.getContexts`, which only ever sees this extension's pages.
  `chrome.tabs.query({ url })` would work too, but needs `tabs`, and Chrome
  would then warn at install that nonstop can "read your browsing history".
- **No fonts, scripts or images fetched from a CDN.** Everything is packaged.
- **No analytics, telemetry or logging of any kind.**
- **Events are never persisted** — `chrome.storage.sync` holds display
  preferences only, and there is no `localStorage`, `sessionStorage`,
  IndexedDB or cookie use anywhere in the extension.

## Fonts — resolved

`fonts/` still holds the whole Google Fonts download of IBM Plex Sans (44 files,
~10 MB) because the extra cuts are useful while the type scale is being tuned —
`IBMPlexSans_Condensed-*` is the obvious answer if the fully zoomed-out week grid
ever needs narrower day-head labels.

They no longer reach the package. `scripts/package.mjs` ships exactly one file:

```
fonts/IBMPlexSans-VariableFont_wdth,wght.ttf     520 kB
```

which covers every weight (100–700) and the width axis the UI asks for. Total
zip: **322 kB**. Deleting the working copies is therefore optional, and would
only save space in the repo.

To re-check the reference set by hand:
`grep -ro "fonts/[^\")]*" styles.css calendar.html src/`

## Italics — note

No `@font-face` rule covers italic, and nothing in the UI uses it. If italic
type is ever introduced, add `IBMPlexSans-Italic-VariableFont_wdth,wght.ttf`
with `font-style: italic` (and to the packager's allowlist) rather than letting
the browser synthesise a slant.
