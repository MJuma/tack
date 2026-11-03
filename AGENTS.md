# AGENTS.md

Guide for agents (and people) working on Tack. Read it before changing anything; [README.md](README.md) is the user-facing companion.

## What Tack is

A Firefox new tab page (Manifest V3 WebExtension, add-on ID `tack@mjuma`) that shows the links you pin as an even grid of boxes. A box can hold up to 6 more "links inside", shown as labels (max 4) or a row of icons (max 6). Links sync through Firefox Sync; favicons are fetched per machine. Its whole reason to exist is speed: a new tab paints in ~42 ms, the same as an empty extension page.

Plain JavaScript (ES modules, JSDoc types), no framework, no bundler, no build step: `src/` *is* the extension. Dev tools are only `oxlint`, `web-ext` and `node:test`.

## Ground rules

- **Keep the hot path fast.** Firefox preloads its own new tab page but never an extension's, so every Tack tab loads from scratch. `src/newtab.html` + `src/newtab.js` must stay: inline CSS, one small classic script, a synchronous `localStorage` read of pre-rendered HTML, `innerHTML`, done. No `await`, `import`, JSON parsing, network, fonts or frameworks before first paint. Anything else loads lazily (the editor is a dynamic `import()` on ✎). After visible UI changes, run `pnpm measure` (see below).
- **Escape everything you render.** All HTML is built as strings in `src/lib/render.js` (and the editor's dialog in `src/edit.js`) and every interpolated value goes through `escapeHtml`. Storage only holds normalized `http(s)` URLs; `render.js` re-checks anyway. `web-ext lint` warns about `innerHTML` (7 warnings); those are expected.
- **Stay backwards compatible with stored data.** Users have links in `storage.sync` from older versions and exported JSON files. Reading must tolerate old and junk fields (see *Data* below); never change the add-on ID (it keys storage, AMO signing and auto-update).
- **The repo is public.** No personal data, work hostnames, internal project names or real accounts in code, tests, docs or commits. Examples use public sites or `contoso` / `example.com`. Keep commits on the repo's local git identity (`git config user.name` is already set; don't override it).
- **Pushing to `master` can publish a release** (see *Publishing*). Don't push, tag, or bump the version without the owner's go-ahead.
- **No keyboard shortcuts.** Box keys existed in 0.3.0 and were removed on purpose; Firefox keeps focus in the address bar on a new tab and pages can't take it. Don't reintroduce them.

## Layout

| Path | What it is |
| --- | --- |
| `src/manifest.json` | MV3 manifest: `chrome_url_overrides.newtab`, event-page background, `storage` + `<all_urls>` host permission (favicons and page names), optional `topSites`, `update_url` for self-hosted updates. |
| `src/newtab.html`, `src/newtab.js` | The hot path. `newtab.js` paints `localStorage['tack:html']`; `CACHE_KEY` is duplicated in `lib/cache.js` on purpose (importing would cost a module load). Also listens for `storage` events so open tabs update live. |
| `src/background.js` | Event page. Wakes on install/startup, `storage.onChanged` (sync area: an edit, or Firefox Sync), `permissions.onAdded`, a `refresh` message from the editor, and `tabs.onUpdated` filtered to `favIconUrl`. |
| `src/lib/cache.js` | `rebuild()` renders the grid into `localStorage`; `refresh()` rebuilds, fetches missing favicons, rebuilds again (serialized queue); `learnFromTab()` takes a tab's favicon for matching links. |
| `src/lib/store.js` | `storage.sync` format (links + `settings`). Pure helpers `linksFromItems` / `itemsFromLinks` / `settingsFromItems` are unit-tested. |
| `src/lib/links.js` | Pure link logic: `normalizeUrl`, `makeLink`, caps (`capOf`, `MAX_ICONS`, `MAX_LABELS`), `cleanInside`, `insideName`, `pageMatches`, `shortTitle`, Firefox shortcuts import, JSON import/export. |
| `src/lib/render.js` | Pure: links + icons → grid HTML, with `{ editing, showHosts }` options. |
| `src/lib/icons.js` | Favicons in `storage.local`: fetch, rasterize to 64px PNG `data:` URLs, tone detection (`iconTone`), failure reasons, icons learned from tabs. |
| `src/lib/page.js` | Fetches a page once for its short name and ranked icon candidates (`DOMParser`, inert). |
| `src/edit.js`, `src/edit.css` | Edit mode, loaded on demand: toolbar (Import ▾, Addresses toggle, Export, Refresh icons, Allow icons), add/remove with Undo, drag or ⌥←/→ reorder, the box dialog (address, name, Labels/Icons, links inside with drag/⌥↑↓ reorder, icon-failure note). |
| `test/tack.test.js` | `node:test` unit tests for the pure modules (imported directly in Node). |
| `scripts/measure.mjs` | Cmd+T timing harness; also the reference Marionette client for browser tests. |
| `.github/workflows/` | `ci.yml` (pull requests), `release.yml` (push to `master`). |
| `docs/` | README media: `demo.gif`, `social-preview.png`. |

Local only (git-ignored): `web-ext-artifacts/` (built/signed packages), `.measure/` (timing results, screenshots), `dist/` (CI), `brag-output/` (launch video sources).

## Data

**`storage.sync`** (synced by Firefox Sync; quota 100 KB / 512 items, so no icons here):

- `order`: array of link ids.
- `l.<id>`: `{ t: title, u: url, s: 'i' (show links inside as icons; omitted for labels), c: [[title, url], …] (links inside; omitted when empty) }`. Tack 0.3.0 also wrote `k` (a key); it's ignored on read and dropped on the next save.
- `settings`: `{ showHosts: boolean }` (addresses under names; default `true`).
- `saveLinks` removes deleted items first, then writes only changed ones; `linksFromItems` appends links missing from `order` and skips ids without items, so two machines editing at once rarely clobber each other.

**`storage.local`** (per machine): `i:<url>` → `{ d: data: URL | null, t: '' | 'dark' | 'light' (invert in that scheme), at: timestamp, e: why there's no icon, x: 1 if fetched via a redirect to another site, v: 'tab' if learned from a visited tab }`. Failures retry after a day; a sign-in page's icon never replaces a tab-learned one.

**`localStorage['tack:html']`**: the pre-rendered grid the new tab paints.

**Export format** (`exportLinks` / `parseImport`): `{ "tack": 2, "links": [{ "title", "url", "show"?: "icons", "links"?: [{ "title", "url" }] }] }`. Import also accepts v1 files, 0.3.0 files with `key` (ignored), and bare arrays of links or URL strings.

## Conventions

- 4-space indent, LF, final newline (`.editorconfig`); YAML 2 spaces.
- Single quotes, semicolons, always braces, `const` by default.
- JSDoc types on exported functions; casts as `/** @type {…} */ (expr)`.
- No `console.*` (oxlint `no-console` is an error): use `reportError(error)` for unexpected failures, `alert`/inline UI for user-facing ones.
- Comments only where something isn't obvious (the *why*, Firefox quirks). Match the existing tone: short, plain sentences.
- Pure logic goes in `src/lib/` without browser APIs where possible, so `node --test` can import it. Add focused tests for behavior you add or fix; don't restate the implementation.
- Lint config: `oxlintrc.json` extends `oxlintrc.base.json` (shared with the owner's other repos; strict, all rules `deny`).

## Working locally

**Setup:** Node 22 (`.node-version`), pnpm (version pinned by `packageManager`). `pnpm install`. If your machine installs through a private npm mirror, `.pnpmfile.cjs` strips mirror tarball URLs from `pnpm-lock.yaml` so CI resolves against public npm; keep it.

**Commands:**

```bash
pnpm test            # node:test unit tests (fast, no browser)
pnpm lint            # oxlint, then web-ext lint --self-hosted (expect 0 errors; 7 innerHTML + 1 Android warnings)
pnpm dev             # web-ext run: Firefox with a throwaway profile and Tack installed temporarily; reloads on save
pnpm build           # unsigned zip in web-ext-artifacts/ (sanity check of what ships)
pnpm measure [runs]  # Cmd+T timing vs Firefox's page and an empty extension; add --headed to watch (~3 min for 30 runs)
```

Run `pnpm test` and `pnpm lint` before every commit; CI runs the same plus a version-match check.

**Manual testing:** `pnpm dev` opens a fresh profile with no links. Click ✎ to add boxes, or Import → JSON file. Temporary installs get site access automatically; real installs ask, and the editor shows *Allow icons* if it was declined. Don't load `src/` over the owner's installed copy (same add-on ID, same storage). Use `pnpm dev`'s separate profile.

**Browser tests (real Firefox, headless):** behavior that touches extension APIs (editor, background, icons, sync updates between tabs) is verified by driving Firefox over Marionette. Copy the minimal client and `launch()` from `scripts/measure.mjs`. Things that matter:

- Launch with `--marionette --headless --profile <tmp>` and env `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`. Without it, chrome-context scripts fail with "System access is required".
- Install with `Addon:Install { path: <repo>/src, temporary: true }`; open tabs from chrome context with `window.BrowserCommands.openTab()`.
- In content scripts, reach the page's extension APIs through `window.wrappedJSObject` (e.g. `wrappedJSObject.browser.storage.sync.set(...)`).
- `permissions.request()` needs real user input: use `WebDriver:ElementClick`, not `element.click()`. To pre-grant an optional permission, call `ExtensionPermissions.add('tack@mjuma', { permissions: ['topSites'], origins: [] }, WebExtensionPolicy.getByID('tack@mjuma').extension)` in chrome context.
- To test what a click would open without leaving the page: `navigation.addEventListener('navigate', e => { record(e.destination.url); e.preventDefault(); })`.
- Dark/light mode: pref `layout.css.prefers-color-scheme.content-override` (0 dark, 1 light).
- Extensions can't reach some Mozilla sites (`addons.mozilla.org`, `support.mozilla.org`, …), so icon fetches fail there. For icon tests, serve fixtures locally (`python3 -m http.server`), e.g. a page that sets its icon from a script, or one that redirects with a script.
- Background work (icon fetching after a save) is asynchronous: poll storage or the DOM with a timeout rather than sleeping.
- Check the browser console for extension errors at the end: `Services.console.getMessageArray()` filtered to `moz-extension`.

**Performance check:** `pnpm measure` writes `.measure/results.json` and screenshots. Tack's *Content painted* median should match the *Empty extension page* row (≈42 ms on an Apple M3; the README table has the last published numbers). If Tack is slower, something got onto the hot path or the cached HTML grew a lot (it's ~81 KB for 24 boxes with icons).

## Publishing (GitHub)

Repo: `MJuma/tack` (public). Releases are GitHub Releases with a Mozilla-signed `.xpi`. The add-on is *unlisted* on addons.mozilla.org, meaning it is signed there but not listed. Installed copies update themselves.

**To release a new version** (with the owner's approval):

1. Bump `version` in **both** `src/manifest.json` and `package.json` (plain `x.y.z`; no pre-release suffixes). CI fails if they differ.
2. Commit and push to `master`. A push without a version change doesn't release.
3. `release.yml` then: checks the tag `v<version>` doesn't exist → `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm lint` → `web-ext sign --channel unlisted` with repo secrets `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` → writes `dist/updates.json` (`{ addons: { "tack@mjuma": { updates: [{ version, update_link, update_hash: "sha256:…" }] } } }`) → `gh release create v<version> tack.xpi updates.json --generate-notes`. Takes about 2 minutes.
4. Verify:
   ```bash
   gh run watch -R MJuma/tack "$(gh run list -R MJuma/tack --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
   curl -sL https://github.com/MJuma/tack/releases/latest/download/updates.json   # new version, hash
   ```
   The manifest's `update_url` points at `releases/latest/download/updates.json`, so Firefox picks the release up within about a day (or immediately via `about:addons` → ⚙ → *Check for Updates*).

**Things to know:**

- `gh` needs an account with write access to `MJuma/tack`. If the active `gh` account is a different one, prefix commands with `GH_TOKEN="$(gh auth token --user MJuma)"`.
- Mozilla signs each version number **once**. Never run `pnpm sign` (local signing, keys from the macOS Keychain entries `amo-jwt-issuer` / `amo-jwt-secret`) for a version you intend to release; CI's signing would then fail with a duplicate version. If a release run fails after signing, bump the version again.
- If signing fails with an authentication error, re-set the secrets from the Keychain without printing them:
  ```bash
  security find-generic-password -s amo-jwt-issuer -w | tr -d '[:space:]' | gh secret set AMO_JWT_ISSUER -R MJuma/tack
  security find-generic-password -s amo-jwt-secret -w | tr -d '[:space:]' | gh secret set AMO_JWT_SECRET -R MJuma/tack
  ```
  The issuer looks like `user:12345:67`, the secret is 64 hex characters. AMO shows the full secret only once; a value with dots in it is the masked copy.
- Release notes are generated from commits, so write commit subjects that read well in a changelog.
- `web-ext lint` must run with `--self-hosted`: without it, `update_url` is an error (it assumes an AMO listing).
- The repo's social preview image (`docs/social-preview.png`) can only be set by hand in GitHub → Settings → General → Social preview.

## README media

`docs/demo.gif` and `docs/social-preview.png` were rendered from a launch video made with the brag-slim skill. It drives Tack's real `newtab.html`/`edit.css` styles and `renderGrid()` output in headless Firefox, frame by frame, with public sample sites. Its sources (`stage.html`, `stage.js`, `music.py`, and the video `brag.mp4`) live in the git-ignored `brag-output/` on the machine that made it. If the UI changes visibly, regenerate them the same way (or ask the owner) so the README stays accurate. Keep the media free of personal data and of the repo URL.
