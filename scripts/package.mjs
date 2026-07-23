// Builds the Chrome Web Store upload zip.
//
// The unpacked extension is the repo root, but the repo root is not what ships:
// it also holds src/, node_modules/, docs/ and 44 fonts of which one is used.
// So the package is an explicit allowlist rather than an ignore list — nothing
// reaches the store zip unless it is named here.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "build");

/** Everything that ships, and nothing else. */
const INCLUDE = [
  "manifest.json",
  "calendar.html",
  "styles.css",
  "dist/main.js",
  "dist/background.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  // The one variable font covers every weight and width the UI asks for; the
  // static cuts and italics in fonts/ are kept for development only.
  "fonts/IBMPlexSans-VariableFont_wdth,wght.ttf",
];

const problems = [];
const fail = (msg) => problems.push(msg);

/* ---------- 1. every listed file exists ---------- */

for (const rel of INCLUDE) {
  if (!existsSync(join(ROOT, rel))) fail(`missing from the working tree: ${rel}`);
}
if (problems.length > 0) {
  console.error("Cannot package:\n  " + problems.join("\n  "));
  console.error("\nDid you run `npm run build` first?");
  process.exit(1);
}

const shipped = new Set(INCLUDE);

/* ---------- 2. nothing shipped references anything unshipped ---------- */

// A local reference that resolves outside the allowlist means a broken install:
// it works unpacked (the file is on disk) and 404s from the store zip.
const localRefs = (rel, patterns) => {
  const text = readFileSync(join(ROOT, rel), "utf8");
  const found = new Set();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const ref = m[1].split(/[?#]/)[0];
      if (/^(https?:|data:|chrome-extension:|mailto:|#)/.test(ref)) continue;
      found.add(ref.replace(/^\.?\//, ""));
    }
  }
  for (const ref of found) {
    if (!shipped.has(ref)) fail(`${rel} references "${ref}", which is not in the package`);
  }
};

localRefs("calendar.html", [/(?:src|href)="([^"]+)"/g]);
localRefs("styles.css", [/url\(\s*["']?([^"')]+)["']?\s*\)/g]);

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const manifestRefs = [
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  manifest.background?.service_worker,
].filter(Boolean);
for (const ref of manifestRefs) {
  if (!shipped.has(ref)) fail(`manifest.json references "${ref}", which is not in the package`);
}

/* ---------- 3. release sanity checks on the manifest ---------- */

if (/YOUR_OAUTH_CLIENT_ID/.test(manifest.oauth2?.client_id ?? "")) {
  fail("manifest.json still has the placeholder OAuth client ID");
}
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
  fail(`manifest version "${manifest.version}" is not a plain dotted-integer version`);
}
if (manifest.version !== JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version) {
  fail("manifest.json and package.json versions disagree");
}
if (manifest.description.length > 132) {
  fail(`description is ${manifest.description.length} chars; the store truncates at 132`);
}
if (manifest.key) {
  // A key pins the extension ID, which is useful for local development but is
  // the store's business once published — it issues the item's identity.
  fail('manifest.json has a "key" field — remove it before uploading to the store');
}

/* ---------- 4. no code the store would treat as remotely hosted ---------- */

for (const rel of ["dist/main.js", "dist/background.js"]) {
  const js = readFileSync(join(ROOT, rel), "utf8");
  if (/\bnew Function\s*\(|[^.\w]eval\s*\(/.test(js)) {
    fail(`${rel} contains eval/new Function — the store rejects remotely evaluated code`);
  }
  if (/sourceMappingURL/.test(js)) fail(`${rel} still has a sourcemap comment`);
}

if (problems.length > 0) {
  console.error("Cannot package:\n  " + problems.join("\n  "));
  process.exit(1);
}

/* ---------- 5. write the zip ---------- */

const zipPath = join(OUT_DIR, `bettercal-${manifest.version}.zip`);
mkdirSync(OUT_DIR, { recursive: true });
rmSync(zipPath, { force: true });

// -X drops the macOS extended attributes and resource forks that otherwise
// ride along as __MACOSX/ entries in the uploaded zip.
execFileSync("zip", ["-q", "-X", zipPath, ...INCLUDE], { cwd: ROOT });

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(`\n${zipPath.replace(`${ROOT}/`, "")}  —  ${kb(statSync(zipPath).size)}\n`);
for (const rel of INCLUDE) {
  console.log(`  ${kb(statSync(join(ROOT, rel)).size).padStart(9)}  ${rel}`);
}
console.log(`\n${INCLUDE.length} files. Permissions: ${manifest.permissions.join(", ")}`);
console.log(`Host access: ${manifest.host_permissions.join(", ")}`);
console.log("\nNext: docs/STORE_LISTING.md\n");
