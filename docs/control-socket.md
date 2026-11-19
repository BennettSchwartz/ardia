# The control socket

The `ardia` command (github.com/ardia-browser/plugins, `plugins/cli`) drives Ardia through one Unix socket,
`<data dir>/ArdiaControl.sock`: newline-delimited JSON, one request per line (`{"id", "method", "params"}`), one reply
per request (`{"id", "result"}` or `{"id", "error": {"code", "message"}}`), and events on subscribed connections
(`{"event", "time", "data"}`). The socket exists only while **Let the ardia command control Ardia** (`cliControl`) is
on; with it off every request answers `failed` "Control is off." (`state/automation/controlSocket.ts`). The contract
with the command (protocol numbers, `hello`) is in `docs/cli.md` › The contract.

This page is the map of the whole profile against the socket: every data point Ardia keeps, where it lives, and which
methods read and change it. The goal is full control: anything a person can see or change in Ardia, the command can
read and change, through the same store actions the UI calls, so every invariant, sync write, undo, saved document and
UI update still happens.

## Rules every method follows

- **Self-describing.** `methods` returns every method: `name`, `area`, `mutates`, a one-line `description`, `params` (a
  JSON Schema subset: `type`, `properties`, `required`, `enum`, `items`, `minimum`, `maximum`, `minItems`, `maxItems`,
  `additionalProperties: false`, `description`) and `result` (a short shape). The socket checks params against that
  schema before a handler runs (`socketSchema.ts`), so the catalogue can't drift from what it accepts. `ardia methods`
  prints it and `ardia call <method> [params]` calls any of them.
- **Store actions only.** Writes call the domain's own actions (`storeAction(…)` on `useBrowser`, or the domain's
  exported functions for the stores outside it). Nothing calls `setState` on another domain's store.
- **Irreversible data loss asks the user.** `profiles.delete` and `extensions.uninstall` call the same actions the UI
  does, which show Ardia's confirmation; the reply waits for the answer (`{deleted}` / `{removed}`).
- **Private stays private.** Private windows, incognito profiles and Peek's own tabs are invisible and untouchable, as
  in `windows` and `workspace` (`eligibleKind`, `isEligibleTab`).
- **Ids, not indexes.** Tabs, windows, groups, splits, bookmarks, downloads and profiles are named by the app's ids
  (`tabId`, `windowId`, `profileId`, …); `profile` may be omitted where the default profile (or the window's) is meant.
- **Errors** come from `automationMethods.ts`: `bad_request` (params don't match the schema, or a value is wrong),
  `unknown_method`, `no_window` (no such window, tab, profile, group, split, bookmark or download the command may use),
  `refused` (Ardia won't do that, with the reason), `failed` (it tried and it didn't happen). A new code needs a new
  protocol number; none was needed for this work.
- **Big lists page.** History and bookmark searches take `limit` (default 100, at most 1000) and `offset`, and answer
  `{ items, total, nextOffset }`.
- **Telemetry.** Each call counts once in its method family (`cli_socket_calls_<family>`) and once in
  `cli_socket_call_failures` when it answers an error: counts only, never which method's params
  (`state/telemetry/cliCounts.ts`).
- **Protocol.** Adding methods doesn't change the protocol: an older command never calls them, a newer command finds
  them in `methods` and gets `unknown_method` from an older Ardia. The protocol stays 4.

## Inventory

`useBrowser` is the workspace store (`state/browser/store.ts`), saved in `session.json`. ✅ means the socket reads and
changes it today, 🔍 read only, 🗺️ designed below, ⛔ deliberately not exposed.

| Area | What it holds | Where it persists | Socket |
| --- | --- | --- | --- |
| Windows | kind, profile shown, frame, maximized, full screen, tab layout, auto-hide, sidebar, focus order | `session.json` (`windows`, `windowOrder`), `launch-layout.json` | ✅ `windows`, `windows.*`, frame, zoom and full screen on macOS (`windows.geometry`, `windows.setFrame`, `windows.setMaximized`, `windows.setFullScreen`) |
| Tabs | url, title, custom title and icon, pin, muted, zoom, page state, opener, created, last active | `session.json` (`tabs`), Chrome's tab restore | ✅ `apply` ops, `tabs.*` |
| Groups and folders | name, icon, colour, collapsed, pinned, nesting, members | `session.json` (`groups`), sync (`groupLooks`) | ✅ `apply` `group.*`, `workspace` |
| Pinned (Top Apps tiles, pinned rows, tile folders) | pin kind, pinned URL, tile folders, Top Apps sharing | `session.json` (`pinChoices`, `pinSync`, `parkedPins`), sync | ✅ `apply` `tab.pin`/`tab.unpin`, `tabs.setPinnedUrl`, `tabs.returnToPinnedUrl`; 🗺️ tile folders |
| Spaces (profiles) | name, colour, icon, theme, shared data, Top Apps sharing, open-tab sync, order, default | `session.json` (`profiles`, `profileOrder`, `settings.defaultProfileId`), Chrome profile dirs | ✅ `profiles.*` |
| Splits | panes, orientation, sizes, stacks | `session.json` (`splits`) | ✅ `splits.*` |
| Peek | the page peeked from each tab | memory | ✅ `peek.*` |
| Little Ardia | small windows and their profile | `session.json` (`windows` of kind `small`) | ✅ `littleArdia.*` |
| Recently closed | closed tabs, windows, groups, deleted groups, cleaned-up tabs | `session.json` | ✅ `closed.*` |
| Bookmarks | folders, links, bar order, favicons | Chrome's Bookmarks file per profile (`bookmarks-cache.json` mirror) | ✅ `bookmarks.*` |
| History | url, title, visits, last visit, visit times | Chrome's History database per profile | ✅ `history.*` |
| Downloads | file, path, state, progress, profile, dangerous | Chrome's History database, `downloads.json` | ✅ `downloads.*` |
| Download settings | folder, ask where to save | Chrome prefs | ✅ `downloads.settings`, `downloads.setSettings` |
| Settings | the 109 keys of `SETTING_SPECS` (every switch and choice in Settings) | `session.json` (`settings`, `settingsMeta`), sync for the synced ones, `config.json` (read only) | ✅ `settings.*`; 🔍 `extensionSearchEngines` |
| Search engines | default, custom engines, extension engines | `settings` | ✅ `search.*` |
| Site settings and permissions | per-origin content settings (camera, location, notifications, popups, JavaScript, sound, …), zoom per host, preload | Chrome prefs per profile | ✅ `sites.*` |
| Extensions | installed, enabled, pinned, toolbar order, options | Chrome's extension prefs, `sync-extensions.json` | ✅ `extensions.list`, `extensions.install` (the user confirms), `extensions.configure`, `extensions.setEnabled`, `extensions.setPinned`, `extensions.reload`, `extensions.uninstall` |
| Plugins | installed, enabled, consent, tools | `plugins.json`, `Plugins/` | ✅ `plugins`, `plugins.*` (`state/plugins/socketMethods.ts`) |
| Media sessions | now playing per tab, PiP, shares | memory (`state/media/media.ts`) | ✅ `media.list`, `media.control` |
| Sync | folder, devices, synced types and profiles, remote tabs | `sync.json`, sealed `sync-*.nns` | ✅ `sync.status`, `sync.now`, `sync.setType`, `sync.setProfile`, `sync.setOpenTabs`, `sync.devices`, `sync.sendTab`; ⛔ turning sync on or off, the recovery phrase |
| Saved passwords | origin, username, password | Chrome's Login Data (keychain-sealed) | 🔍 `passwords.list` (no passwords); ⛔ reveal, see Secrets |
| Autofill | addresses, cards | Chrome's Web Data | 🔍 `autofill.list` (no card numbers); ⛔ card numbers |
| Cookies and site data | cookies, storage per origin | Chrome's Cookies and storage | ✅ `sites.clearData`; ⛔ cookie values |
| Favicons | icon per page | Chrome's Favicons database, app cache | 🗺️ `favicons.get` |
| Shared folders | groups backed by a folder, their identities | `shared-folders.json`, `.ardia-folder.json` | 🗺️ `sharedFolders.*` |
| Live folders | GitHub, calendar and document sources | `live.json` | 🗺️ `live.*` |
| Sidebar layout | width, side, pinned collapsed, auto-hide | `settings` (`sidebarWidth`, `sidebarSide`, `autoHideTabs`), profiles (`pinnedCollapsed`) | ✅ through `settings.set`, `profiles.update`, `windows.setLayout` |
| Presets and themes | setup codes, profile looks, theme files | `settings`, `themes/*.json`, profiles (`theme`) | ✅ `profiles.setLook`; 🗺️ `presets.apply` |
| Omnibox | providers, bangs state, approvals | `settings.omniboxProviders`, `bangs-state.json`, `automation-approvals.json` | ✅ providers through `settings.set`; 🗺️ bangs |
| Session and restore | the whole workspace | `session.json` | ✅ through the areas above; ⛔ the raw document |
| Reader | text size, font | `settings` (`readerTextSize`, `readerFont`) | ✅ `settings.set` |
| Air traffic (link routing rules) | rules per source app | `air-traffic.json` | 🗺️ `airTraffic.*` |
| Hooks, config, approvals | hook rules, config.json, approvals | `hooks.json`, `config.json`, `automation-approvals.json` | files the user edits; ⛔ approvals |
| Telemetry, reports, onboarding, release notes | the app's own bookkeeping | their documents | ⛔ not profile data |

## Methods

`mutates` is what `methods` reports. Every method also takes nothing it doesn't list (`additionalProperties: false`).

### Already there (protocol 4)

| Method | Mutates | What it does |
| --- | --- | --- |
| `hello` | no | Protocol handshake: `{ app, version, protocol, minClientProtocol }` |
| `caller` | no | Notes the caller the command named in `hello` |
| `methods` | no | This catalogue |
| `commands` | no | The command catalogue `run` takes |
| `windows` | no | Windows and their tabs, with each tab's DevTools target |
| `workspace` | no | The sidebar tree of a window or profile: pinned, groups, tabs, with usage on request |
| `apply` | yes | A batch of ops on tabs, groups and pins (`docs/automation.md`): `open`, `tab.*`, `group.*` |
| `run` | yes | Runs a menu command in a window or on a tab |
| `offscreen` | yes | Moves a tab the command opened off-screen |
| `subscribe`, `answer` | no | Events and decide hooks |
| `plugins`, `plugins.official`, `plugins.enable`, `plugins.disable`, `plugins.remove`, `plugins.call` | mixed | Plugins |

### Added here

| Area | Read | Write |
| --- | --- | --- |
| tabs | `tabs.list {window?, profile?}`, `tabs.get {tab}` | `tabs.navigate {tab, url}`, `tabs.reload`, `tabs.back`, `tabs.forward`, `tabs.duplicate`, `tabs.setPinnedUrl {tab, url?}`, `tabs.returnToPinnedUrl` |
| windows | `windows.get {window}`, `windows.geometry {window}` | `windows.create {profile?, url?, layout?}`, `windows.close`, `windows.focus`, `windows.setLayout {window, layout?, tabsShown?}`, `windows.switchProfile`, `windows.merge`, `windows.setFrame {window, frame}`, `windows.setMaximized {window, on}`, `windows.setFullScreen {window, on}` |
| closed | `closed.list {window?}` | `closed.restore {id, window?}`, `closed.clear {window?}` |
| profiles | `profiles.list` | `profiles.create`, `profiles.update`, `profiles.setLook`, `profiles.reorder`, `profiles.setDefault`, `profiles.delete {profile}` (Ardia asks the user first) |
| splits | `splits.list {window?}` | `splits.create {tabs, orientation?}`, `splits.separate`, `splits.removeTab`, `splits.resize {split, sizes}`, `splits.flip`, `splits.setOrientation` |
| peek | `peek.list` | `peek.open {tab, url}`, `peek.close {tab}`, `peek.toTab {window}` |
| littleArdia | (in `windows`) | `littleArdia.open {url?, profile?}`, `littleArdia.close`, `littleArdia.toMain` |
| bookmarks | `bookmarks.tree {profile?, folder?, depth?}`, `bookmarks.search {profile?, query, limit?, offset?}`, `bookmarks.get {id}` | `bookmarks.add`, `bookmarks.addFolder`, `bookmarks.update`, `bookmarks.move {ids, parent, index?}`, `bookmarks.remove {ids}` |
| history | `history.search {profile?, query?, since?, until?, limit?, offset?}` | `history.remove {profile?, urls}`, `history.clear {profile?, since?}` |
| downloads | `downloads.list {profile?, state?}`, `downloads.settings {profile?}` | `downloads.pause`, `downloads.resume`, `downloads.cancel`, `downloads.keep`, `downloads.open`, `downloads.reveal`, `downloads.remove`, `downloads.clear`, `downloads.setSettings` |
| settings | `settings.get {keys?}`, `settings.schema` | `settings.set {values}`, `settings.reset {keys}` |
| search | `search.engines` | `search.setDefault {id}`, `search.add`, `search.update`, `search.remove` |
| sites | `sites.origins {profile?}`, `sites.get {origin, profile?}`, `sites.zoomLevels {profile?}` | `sites.set {origin, type, value}`, `sites.reset {origin}`, `sites.setZoom {host, zoom}`, `sites.clearData {origin}` |
| extensions | `extensions.list {profile?}` | `extensions.install {profile?, webStore? \| folder?}` (the user confirms), `extensions.configure {id, siteAccess?, incognito?, userScripts?}`, `extensions.setEnabled {id, enabled}`, `extensions.setPinned`, `extensions.reload`, `extensions.uninstall` (Ardia asks the user first) |
| media | `media.list` | `media.control {tab, action, seconds?}` |
| sync | `sync.status`, `sync.devices {profile?}` | `sync.now`, `sync.setType {type, on}`, `sync.setProfile {profile, on}`, `sync.setOpenTabs {profile, on}`, `sync.sendTab {tab, device}` |
| passwords, autofill | `passwords.list {profile?}`, `autofill.list {profile?}` | `passwords.remove {origin, username}` |

`settings.set` takes the same keys and values `config.json` does (`state/settings/configAllowlist.ts`, checked by
`checkedSettings`), applied with `updateSettings`, so a value the Settings UI can choose is a value the command can set.
The keys `config.json` can't set stay off `settings.set` and have their own methods where it makes sense:
`defaultProfileId` is `profiles.setDefault`, `customSearchEngines` is `search.*`. `cliControl` stays refused (the
command can't switch control itself on or off), and so does `allowJavaScriptFromAppleEvents` (it would let any
AppleScript run script in every page).

Five keys `config.json` can't take are set here with the checks their Settings rows apply
(`state/automation/socketSettingRules.ts`), and `settings.schema` reports them writable:

| Key | What the socket checks, as Settings does |
| --- | --- |
| `pageEngine` | `chromium` or `webkit`; `webkit` only where WebKit ships (macOS). The same write the pop-up in Settings › Advanced makes |
| `websiteEngines` | `{site: engine}`, each site typed as the Add Rule sheet takes it (`netflix.com` or a full address) and stored as its scheme, host and port; a value that isn't a website address is `bad_request`. The whole map is replaced, as each sheet edit replaces one rule |
| `protectedVideoInWebKit` | A boolean, the Streaming sites row; macOS only |
| `newTabUrl` | Empty (Ardia's New Tab), or an `http(s)` address, `about:blank` or an Ardia page: the address Settings marks invalid is refused here, not saved. Stored trimmed |
| `customSearchUrl` | The legacy one-URL engine that `search.engines` lists as `custom`: empty clears it (and if it was the default, the default goes back to Ardia's, as removing an engine does); otherwise an `http(s)` URL with `%s`, and only while no other engine uses the keyword `custom` |

`extensionSearchEngines` stays read only: it mirrors the engines installed extensions provide, Settings has no
control for it, and a written value would be overwritten from the extensions on the next refresh. Change it through
the extension (`extensions.setEnabled`, `extensions.uninstall`).

### Events

`subscribe` sends tab, window, split, peek, pin, profile and settings events (`eventNames.ts`). Writes here change the
store, so those events fire for them as for a click. `bookmarks.changed`, `download.changed` and `profile.changed`
are store watches and `history.removed` listens to the engine's history (`libraryEvents.ts`, started from
`storeEvents.ts` only while a connection or plugin asks for one of them); their fields are in `docs/automation.md` ›
Events. No protocol change: an older command never names them.

### Sync

The sync methods call `state/sync/engine.ts` as Settings does, and each refuses while sync is off, unavailable or
locked. `sync.setProfile` needs the profile's sync link (it appears on the first sync after the profile opens; the
Settings toggle is disabled until then), and `sync.setOpenTabs` needs the profile on and Open Tabs syncing, as the
Sync All Open Tabs toggle does. `sync.sendTab` takes an `http(s)` tab and a device from `sync.devices`, the list the
tab menu's Send to Device shows. Turning sync on or off and the recovery phrase stay in Settings: they choose a
folder and show or ask for the phrase, which is the user's to see.

### Extensions

`extensions.install` follows the two ways Settings › Profiles › Extensions adds one, and nothing more: `webStore`
(a link or id, checked as Add from a Link checks it) opens the extension's Chrome Web Store page in a window of
that profile, where the user adds it, and answers `{waiting: true, id}` (or `{installed: true}` when it's already
there); `folder` (an absolute path, as Load Unpacked Extension… picks) shows Ardia's install sheet in a window of
that profile and answers when the user decides: `{installed, extensions}`, with the ids it added. Nothing installs
without the user's click. `extensions.configure` sets what an extension's page in Settings offers: site access
(only for an extension that asks for sites), Allow in Incognito, and Allow User Scripts (only when the extension
uses them); a policy-installed one is `refused`.

### Window geometry

`windows.geometry`, `windows.setFrame`, `windows.setMaximized` and `windows.setFullScreen` call four public
functions of the `ArdiaAppWindows` module in `packages/shell` (`WindowGeometry.swift`, typed in
`packages/shell/src/windows.ts`, wrapped in `platform/windows.ts`): `windowGeometry(id)`, `setWindowFrame(id, frame)`,
`setWindowZoomed(id, on)` and `setWindowFullScreen(id, on)`, each answering the window's geometry afterwards:
`{frame, zoomed, fullScreen, miniaturized, visible, display}`. They are the extension point for anything in the app or
a plugin (through these socket methods) that moves windows; nothing about them is socket-only. Frames are AppKit's: screen points from the
bottom-left of the main display, the same as `frame` in `windows`. A frame is kept on the display it overlaps most and at
least the window's smallest size; zoom is macOS's (the green button with Option, or double-clicking the title bar);
full screen takes a main window into its own Space and the reply waits until the store has seen it (4 s), and none
of the three acts while a page is full screen in the window. The store's `frame` and `fullScreen` follow through the
window events they already listen to. `PLATFORM_FEATURES.windowGeometry` is on for macOS only: Linux needs the same
four calls in `engine/ardiacore-linux` (an engine change, so a new engine), and Windows in `WindowManager` of
`apps/browser/windows` (its maximize already exists as `toggleMaximizeWindow`); until then the methods are `refused`
there.

## Secrets

**Chosen:** the socket lists saved logins (origin and username) and autofill entries (addresses, and cards by name,
network, last four and expiry), and removes a saved login, behind the same consent as every other method. It never
returns a password, a full card number or a cookie value.

**Why:** "every single data point" covers knowing what is saved and cleaning it up, and those reads carry nothing an
attacker could log in with. Revealing a password in Ardia's own UI asks macOS for the user's password or Touch ID
(`unlockPasswordsFor`); a socket method that did the same would put that system prompt on screen with no context of
which program asked, and anything that can reach the socket (every process of the user) could ask. Cookie values are
the user's live sessions on every site. Both are a different consent than "control Ardia".

**Next, if the owner wants it:** `passwords.reveal {origin, username}` behind its own switch in Settings › Advanced
(off by default) and the macOS re-auth on every call, with Ardia's own sheet naming the program first.

## Next

Designed, not built in this round, each in its own file under `state/automation/socket<Area>.ts`:

- **Window geometry on Linux and Windows:** the four `ArdiaAppWindows` calls above, then `windowGeometry: true` in
  their `PLATFORM_FEATURES`.
- **Tile folders:** `pins.folders {profile?}`, `pins.createFolder {tabs, name}`, `pins.renameFolder`, `pins.removeFolder`
  through `state/pins/tileFolders.ts`.
- **Favicons:** `favicons.get {url, profile?}` → the cached PNG as base64, through `resolveFavicon`.
- **Shared folders:** `sharedFolders.list`, `sharedFolders.share {group}`, `sharedFolders.stop {group}` through
  `state/sharedFolders/actions.ts`.
- **Live folders:** `live.list`, `live.refresh {folder}`, `live.hide {folder, item}` through `state/live`.
- **Presets:** `presets.apply {code}` through `applySetupCode`.
- **Air traffic:** `airTraffic.rules`, `airTraffic.setRule {app, route}` through `state/airTraffic/rules.ts`.
