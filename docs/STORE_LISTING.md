# Publishing BetterCal — unlisted on the Chrome Web Store

Everything needed to submit, in the order it has to happen. The two things that
will bite if taken out of order are the **extension ID** (§2) and the **OAuth
verification** (§5) — start §5 early, it is the long pole.

> **"Unlisted" is not "private".** An unlisted item is hidden from Chrome Web
> Store search and category browsing, but anyone holding the link can install
> it, and it goes through the same Google review as a public listing. Both the
> store review and Google's OAuth verification treat it as a public app. If you
> want it genuinely restricted to named people, use **Private** visibility
> instead (Google Workspace domain, or a trusted-tester list).

---

## 1. Build the package

```bash
npm run package
```

Writes `build/bettercal-<version>.zip` — the file you upload. It contains ten
files and nothing else: the manifest, `calendar.html`, `styles.css`, the two
bundled scripts, four icons and the single variable font. `src/`, `docs/`,
`node_modules/`, `.git`, `.DS_Store` and the 43 unused font cuts are excluded by
construction, because `scripts/package.mjs` works from an allowlist rather than
an ignore list.

The script refuses to build if the manifest still holds a placeholder client ID,
if the manifest and `package.json` versions disagree, if anything shipped
references a file that is not in the package, or if the bundles contain `eval`.

## 2. Get the extension ID before wiring OAuth

The store assigns a permanent item ID on **first upload**, and
`chrome.identity.getAuthToken` only works if the OAuth client is registered
against that exact ID. The client ID currently in `manifest.json` is bound to
the *local unpacked* ID and will fail with "bad client id" once installed from
the store. So:

1. Upload the zip as a **draft**. Do not publish.
2. Copy the item ID from the dashboard URL
   (`.../developer/dashboard/<ITEM_ID>`).
3. Google Cloud Console → **APIs & Services → Credentials → Create credentials →
   OAuth client ID → Chrome Extension**, Item ID = the ID from step 2.
4. Put the new client ID into `manifest.json`, `npm run package` again, upload
   the new zip over the draft.

Keep the old client ID somewhere: it is still the one that works for the
unpacked build you develop against. The two IDs differ, so you need an OAuth
client for each, and you swap `client_id` in the manifest when you switch
between developing and packaging.

## 3. Listing assets

| Field | Value / status |
| --- | --- |
| Name | BetterCal — Infinite Week Calendar (34 chars, limit 75) |
| Short description | Taken from `manifest.json` — 108 chars, limit 132 |
| Category | Productivity → Workflow & Planning |
| Language | English (UK) |
| Store icon | `icons/icon128.png` — **already 128×128, ready** |
| Screenshots | **Still to make.** 1–5 needed, each 1280×800 or 640×400 PNG |
| Small promo tile | Optional, 440×280. Skip unless you want it featured. |
| Privacy policy URL | **Must be hosted.** See §4. |

For screenshots, one of the month view and one of the week view is the minimum
worth shipping; the week grid zoomed out to five weeks is the most distinctive
thing the extension does and makes a good first tile.

## 4. Host the privacy policy

`docs/PRIVACY.md` is written and ready, but the store needs a **public URL**, not
a file. Cheapest options:

- GitHub Pages on the repo (`Settings → Pages`), then link
  `https://<user>.github.io/bettercal/PRIVACY.html`.
- A public Gist, and link its raw or rendered URL.

Google's OAuth verification (§5) is fussier than the store here: it wants the
privacy policy on the **same domain as the app homepage**, and that domain
verified as yours in Search Console. If you have no domain, a GitHub Pages site
serving both the homepage and the policy is normally accepted.

## 5. OAuth verification — start this first, it is the slow part

The three calendar scopes are classified **sensitive** by Google. What that means
depends on your Google Cloud OAuth consent screen's publishing status:

**Staying in "Testing"** — fine if the audience is a handful of known people:

- Every user must be added individually under **Test users**, cap 100.
- Everyone sees a "Google hasn't verified this app" interstitial and must click
  through *Advanced → Go to BetterCal*.
- Grants issued in testing mode expire after seven days, so users get re-prompted
  roughly weekly.

**Moving to "In production"** — required for anyone with the link to install and
use it without those caveats. Submitting for verification needs:

- A verified app homepage on a domain you own.
- The privacy policy hosted on that same domain.
- A demo video (usually unlisted YouTube) showing the OAuth consent flow and
  each scope actually being used in the extension.
- A written justification per scope — the table in `docs/PRIVACY.md` is the
  argument, in the form Google asks for.

Sensitive scopes need review but **not** the third-party security assessment
(CASA) that restricted scopes require, so this is a review-and-wait exercise
rather than a paid audit. Budget several weeks and expect at least one round of
questions.

## 6. The Privacy practices tab — answers to paste

**Single purpose:**

> BetterCal displays the user's own Google Calendar as one continuous,
> infinitely scrolling run of weeks, in a month view and a horizontal week grid,
> and lets the user create and edit events in place. That is its only function.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `identity` | Obtains an OAuth token for the Google account the user is already signed in to in Chrome, so the extension can read and write that user's own Google Calendar. It is the only way the extension authenticates, and no token ever leaves the browser. |
| `storage` | Persists the user's display preferences — chosen calendars, week start day, zoom level, current view, wake/sleep times, extra clock time zones, sidebar state — so the calendar reopens the way they left it. No calendar content is stored. |
| `https://www.googleapis.com/*` | The Google Calendar API endpoint. Every event, and the list of the user's calendars, is fetched from and written to this host. |
| `https://oauth2.googleapis.com/*` | Used solely by the Sign out button, to revoke the OAuth token so signing out disconnects the extension from the Google account rather than only clearing the local cache. |

**Remote code:** *No, I am not using remote code.* Every script and the font
ship inside the package; the manifest's `content_security_policy` pins
`script-src 'self'` and `connect-src` to the two Google hosts above.

**Data usage — tick nothing.** BetterCal collects none of the listed categories.
The reasoning, if a reviewer asks: the extension *handles* calendar data but does
not *collect* it — the data moves between the user's own browser and Google's
API under the user's own OAuth grant, and there is no developer-operated server,
analytics or logging of any kind to receive it. Preferences stored in
`chrome.storage.sync` go to the user's own Chrome profile, not to the developer.

**Certifications — all three are true, tick all three:**

- ✅ I do not sell or transfer user data to third parties, outside of the approved use cases
- ✅ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes

## 7. Submit

1. Distribution → **Visibility: Unlisted**.
2. Distribution → regions: all, unless you have a reason not to.
3. Check the manifest has **no `key` field** — the store issues the item's
   identity, and `npm run package` fails the build if one is present.
4. Submit for review. First review of an OAuth-using extension typically takes a
   few days and can take longer.

## 8. After it is live

- Test a clean install from the store link on a Chrome profile that has never
  had the unpacked build, and confirm the consent screen names the right app and
  the right three scopes.
- Every future upload needs `version` bumped in **both** `manifest.json` and
  `package.json` — `npm run package` fails if they disagree.
- Adding a scope later invalidates existing grants: users get the connect screen
  again and must re-consent. Adding a *sensitive* scope means re-verification.
