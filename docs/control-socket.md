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
  schema before any handler runs, the core and plugin methods included (`socketSchema.ts`, `socketCatalog.ts`), so the
  catalogue can't drift from what it accepts. Only own properties count (a `constructor` or `__proto__` key is an
  unknown param, never a match from `Object.prototype`), and numbers must be finite (`1e999` parses to Infinity and is
  refused). A handler only sees the params its schema lists: reading, `in`-testing, `Object.hasOwn`-checking or describing any
  other key fails the call with `failed`, at the top level and inside nested closed objects (`subscribe`'s `idle`);
  values the schema leaves open (`apply`'s `ops`, `settings.set`'s `values`, `plugins.call`'s `input`) are the
  handler's to check. A test registers every handler the app registers (the core, area and plugin ones) and calls every
  method through it, so none reads an unlisted key and none is left without a handler. `ardia methods` prints it and `ardia call <method> [params]` calls any
  of them.
- **Control off means no more writes.** Consent is checked when a request arrives and again before every write that
  follows an `await` in a handler (a lookup, a confirmation, a settings read): handlers get a `SocketCall` and call
  `stillServing()` first, as `apply` does between ops. Turning control off mid-call answers `failed` "Control was
  turned off before Ardia made the change, so nothing changed." The check also runs inside the shared actions the
  socket calls, through a `may…` callback they take: after `profiles.delete`'s and `extensions.uninstall`'s
  confirmations; in `windows.close` before the "Don't ask again" and quit-warning preference writes, before the close
  starts, and again when the close animation commits; in Little Ardia's close after its quit prompt; in `tabs.reload`,
  `tabs.back` and `tabs.forward` after a shared page is handed over, and in cross-engine back after its unsaved-work
  check; in `downloads.open` before it reveals an opened archive; in `history.clear` before the cache write (the engine
  clear already ran, and the cache reconciles from the engine's own events); in `offscreen` after its ownership read;
  and in `plugins.remove` after the plugin is saved as off and before its files go. A write that already happened is
  reported as done, never as "nothing changed". Left as they are: `apply` checks between ops, not between one op's sleep
  and wake steps, which are synchronous store calls; `run` checks once, as a menu command's own async work (a prompt it
  shows) belongs to the UI it runs; and an `answer` to a decide hook is checked when it arrives, and Ardia acts on it at
  once.
- **The UI's path, not a shortcut.** Where the UI does more than one store call, the socket does the same:
  `windows.close` goes through the window close guard (it asks first when the user set **Ask before closing a window
  with multiple tabs**, answers `refused` if they cancel, and keeps the last window to reopen). It shares the UI's
  one-close-per-window guard (a second close of a window that is already asking or closing answers `refused`), and
  decides whether a window is the last one at the moment its close commits, so two closes at once keep exactly one
  window to reopen. When Ardia would have to ask and nobody could see the question (the window isn't visible, or Ardia
  runs as a background instance), it answers `refused` instead of waiting on a dialog nobody can answer
  (`confirm({onlyIfShown})`, `DialogsModule.swift`); it never falls back to an app-modal alert. Linux and Windows
  ignore `onlyIfShown` for now and ask as before. `littleArdia.close` and `windows.close` on a Little Ardia reply
  only once the window is closed, so a Cancel on its quit prompt answers `refused`, `profiles.update
  {syncTabs: false}` retires the open-tab records as the Settings switch does (`setOpenTabsSynced`), `settings.set
  {tabLayout}` and `settings.reset {keys: ["tabLayout"]}` move open windows as Settings does (`chooseTabLayout`), even
  when the stored value already matches (windows that override it move back), and `settings.reset {keys: ["shortcuts"]}`
  drops every custom shortcut (where `settings.set {shortcuts}` adds to them, as `config.json` does).
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
- **Big lists page, and the bound comes first.** `history.search`, `bookmarks.search` and `downloads.list` take `limit`
  (default 100, at most 1000) and `offset`, and answer `{ items, total, nextOffset }`; only the page is built. A page
  also stops once it reaches 512 KiB, with `nextOffset` where it stopped, and a string field over 32,768 characters is
  cut there and named in the row's `clipped` list, so any page fits on one line.
  `bookmarks.tree` stops at 5,000 items or about 1 MiB, leaves the folders it didn't open as a child count and says
  `truncated: true`; ask for a `folder` or a lower `depth` to see more.
- **History reads the newest 20,000 pages, cold or warm.** `history.search` works on one window: the newest 20,000
  pages by last visit, read from the engine, or from the app's history cache when that has loaded, with the same
  answer either way. Without a query or time range it reads only `offset + limit + 1` pages; with one it reads the
  window and filters it. `truncated: true` means history goes past the window (pages older than the newest 20,000
  aren't searched or paged to: an `offset` past it returns no items). `total` is exact only when Ardia read all of
  history: `null` when it read just enough for this page and one more, or when the window was cut off. `nextOffset`
  is `null` at the end of the results or of the window. The engine's query takes a page cap but still loads every
  visit before applying it (`ac_history.cc`); pushing the cap into the query is an `engine/` change, due with the next
  engine build.
- **The 1 MiB line.** Every line Ardia writes on the socket is at most 1 MiB (1,048,576 bytes), measured as sent: the
  escaped JSON, its envelope and the newline. That is the limit every shipped command reads (`MAX_LINE` in the
  command's `control.py` and `control.rs`; a longer line drops the connection) (`socketWire.ts`):
  - a read whose reply wouldn't fit answers `failed` "The reply would be over 1 MiB, the most a line can carry; ask for
    less (a smaller limit, a later offset, a folder, a window or a lower depth)";
  - a write (`mutates: true`) whose result wouldn't fit answers `{ok: true, oversized: true, …}` with its scalar fields
    and each list as `{count}`, and a hint to read it back, so the size never hides whether the write happened;
  - an event keeps 64 bytes free for the `dropped` marker; one that wouldn't fit goes out with its scalar fields, each
    list as `{count}` and `truncated: true`;
  - a decide request that wouldn't fit isn't sent: Ardia goes on as if nobody answered (its default);
  - an error message is cut to 4 KiB.
- **The native queue** (`ControlOutput.swift`, `ControlConnection.swift`) holds three kinds of line per connection:
  - replies, and decide messages (requests and cancels, any line starting `{"decide":`): never dropped;
  - events: evicted oldest first when a reader falls behind (past 4 MiB or 1,000 waiting events, or to make room for a
    reply or decide message). The next event written starts with `"dropped": <n>`. If adding the marker would push
    that event over 1 MiB, it goes out unmarked and the count moves to the next event.
  - Everything waiting shares 34 MiB (32 pending requests of 1 MiB each, and room), less 64 bytes kept for the marker,
    which no reply uses.
  - The queue checks the line limit again: an event over 1 MiB is dropped and counted, and a reply over it is replaced
    with a `failed` error for the same id.
  - A connection is closed only when its own unread replies and decide messages fill the 34 MiB, it sends more than 32
    requests without reading, a request line passes 1 MiB or stalls for 30 s, or control is turned off. It is never
    closed in the middle of a line: Ardia drops what was queued after that line (the replies are reported unwritten),
    stops reading, finishes the line within 5 s and then closes. A write error or a reader that hung up closes at once.
  - `cli_socket_lines_shrunk` counts replies, events and decide requests that went out shortened.
  - Linux has its own queue in `engine/ardiacore-linux` and doesn't have these rules yet; that's an engine change.
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
| Windows | kind, profile shown, frame, maximized, full screen, tab layout, auto-hide, sidebar, focus order | `session.json` (`windows`, `windowOrder`), `launch-layout.json` | ✅ `windows`, `windows.*`; 🗺️ frame, maximize, full screen |
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
| Settings | the 109 keys of `SETTING_SPECS` (every switch and choice in Settings) | `session.json` (`settings`, `settingsMeta`), sync for the synced ones, `config.json` (read only) | ✅ `settings.*` |
| Search engines | default, custom engines, extension engines | `settings` | ✅ `search.*` |
| Site settings and permissions | per-origin content settings (camera, location, notifications, popups, JavaScript, sound, …), zoom per host, preload | Chrome prefs per profile | ✅ `sites.*` |
| Extensions | installed, enabled, pinned, toolbar order, options | Chrome's extension prefs, `sync-extensions.json` | ✅ `extensions.list`, `extensions.setEnabled`, `extensions.setPinned`, `extensions.reload`, `extensions.uninstall` |
| Plugins | installed, enabled, consent, tools | `plugins.json`, `Plugins/` | ✅ `plugins`, `plugins.*` (`state/plugins/socketMethods.ts`) |
| Media sessions | now playing per tab, PiP, shares | memory (`state/media/media.ts`) | ✅ `media.list`, `media.control` |
| Sync | folder, devices, synced types and profiles, remote tabs | `sync.json`, sealed `sync-*.nns` | 🔍 `sync.status` |
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
| Prompts on screen | permission, save password, save address or card prompts per tab | memory (`state/tabs/pageState.ts`) | ✅ `permissions.*`, `passwords.prompts`/`respond`, `autofill.prompts`/`respond` |
| Native menus | open `<select>` popups, context menus, Ardia's menus, the menu bar | AppKit (`OpenSurfaces.swift`) | ✅ `menus.*`; 🗺️ the color popup, payment and WebAuthn sheets; ⛔ macOS's own sheets |
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
| `subscribe` | yes | Events and decide hooks this connection serves: `{events, fullUrls?, idle?, hooks?}` |
| `answer` | yes | Answers a decide hook: `{decide, answer?}`; Ardia acts on the answer |
| `plugins`, `plugins.official`, `plugins.enable`, `plugins.disable`, `plugins.remove`, `plugins.call` | mixed | Plugins |

### Added here

| Area | Read | Write |
| --- | --- | --- |
| tabs | `tabs.list {window?, profile?}`, `tabs.get {tab}` | `tabs.navigate {tab, url}`, `tabs.reload`, `tabs.back`, `tabs.forward`, `tabs.duplicate`, `tabs.setPinnedUrl {tab, url?}`, `tabs.returnToPinnedUrl` |
| windows | `windows.get {window}` | `windows.create {profile?, url?, layout?}`, `windows.close`, `windows.focus`, `windows.setLayout {window, layout?, tabsShown?}`, `windows.switchProfile`, `windows.merge` |
| closed | `closed.list {window?}` | `closed.restore {id, window?}`, `closed.clear {window?}` → `{cleared}`; both act on the window's profile, the last focused main window when `window` is left out, and answer `no_window` when there's none |
| profiles | `profiles.list` | `profiles.create`, `profiles.update`, `profiles.setLook`, `profiles.reorder`, `profiles.setDefault`, `profiles.delete {profile}` (Ardia asks the user first) |
| splits | `splits.list {window?}` | `splits.create {tabs, orientation?}`, `splits.separate`, `splits.removeTab`, `splits.resize {split, sizes}`, `splits.flip`, `splits.setOrientation` |
| peek | `peek.list` | `peek.open {tab, url}`, `peek.close {tab}`, `peek.toTab {window}` |
| littleArdia | (in `windows`) | `littleArdia.open {url?, profile?}`, `littleArdia.close`, `littleArdia.toMain` |
| bookmarks | `bookmarks.tree {profile?, folder?, depth?}`, `bookmarks.search {profile?, query, limit?, offset?}`, `bookmarks.get {id}` | `bookmarks.add`, `bookmarks.addFolder`, `bookmarks.update`, `bookmarks.move {ids, parent, index?}`, `bookmarks.remove {ids}` |
| history | `history.search {profile?, query?, since?, until?, limit?, offset?}` | `history.remove {profile?, urls}`, `history.clear {profile?, since?}` |
| downloads | `downloads.list {profile?, state?, limit?, offset?}` (live progress for running downloads), `downloads.settings {profile?}` | `downloads.pause`, `downloads.resume`, `downloads.cancel`, `downloads.keep`, `downloads.open`, `downloads.reveal`, `downloads.remove`, `downloads.clear`, `downloads.setSettings` |
| settings | `settings.get {keys?}`, `settings.schema` | `settings.set {values}`, `settings.reset {keys}` |
| search | `search.engines` (`default` is the engine searches use, an extension's when one controls it, with `controlledBy`) | `search.setDefault {id}` (`refused` while an extension controls it, as Settings disables the picker; so is `settings.set {searchEngine}`), `search.add`, `search.update`, `search.remove` |
| sites | `sites.origins {profile?}`, `sites.get {origin, profile?}`, `sites.zoomLevels {profile?}` | `sites.set {origin, type, value}`, `sites.reset {origin}`, `sites.setZoom {host, zoom}`, `sites.clearData {site}` |
| extensions | `extensions.list {profile?}` | `extensions.setEnabled {id, enabled}`, `extensions.setPinned`, `extensions.reload`, `extensions.uninstall` (Ardia asks the user first) |
| media | `media.list` | `media.control {tab, action, seconds?}` |
| sync | `sync.status` | none yet |
| passwords, autofill | `passwords.list {profile?}`, `autofill.list {profile?}` | `passwords.remove {origin, username}` |

`settings.set` takes the same keys and values `config.json` does (`state/settings/configAllowlist.ts`, checked by
`checkedSettings`), applied with `updateSettings`, so a value the Settings UI can choose is a value the command can set.
The keys `config.json` can't set stay off `settings.set` and have their own methods where it makes sense:
`defaultProfileId` is `profiles.setDefault`, `customSearchEngines` is `search.*`. `cliControl` stays refused (the
command can't switch control itself on or off), and so does `allowJavaScriptFromAppleEvents` (it would let any
AppleScript run script in every page). `pageEngine`, `websiteEngines`, `protectedVideoInWebKit`, `newTabUrl`,
`customSearchUrl` and `extensionSearchEngines` are refused in this first round, as `run` refuses `changesEngine`; they are
listed under Next.

### Events

`subscribe` already sends tab, window, split, peek, pin, profile and settings events (`eventNames.ts`). Writes here
change the store, so those events fire for them as for a click. Next adds `bookmarks.changed`, `history.removed`,
`download.changed` and `profile.changed` (each one store watch in `storeEvents.ts`, no protocol change).

### Clearing site data is per site

`sites.clearData {site}` deletes cookies and stored data for a whole site: the registrable domain of the host given and
every subdomain, over http and https (`mail.example.com` clears all of `example.com`). That is what the engine's
`ac_site_data_clear` does (`ac_site_settings.cc`, `RegistrableDomainOf`) and what the page menu's Clear Site Data does.
The method took an `origin` before and silently cleared more than that origin; it now takes `site` and refuses
`origin`, so an older caller gets `bad_request` instead of a wider delete. Clearing a single origin needs an engine change
(an origin filter in place of the site filter), which can't ship in this app-only change; if it's wanted, it comes as
`sites.clearOriginData {origin}` with the next engine.

## Plugin sessions

Plugins must never reach these store methods: a plugin acts through the mediated browse verbs, each of which asks the
user or stays inside what the plugin was granted. Today the socket can't tell a plugin from the owner's `ardia`
command: both connect to the same socket as the same user, and a plugin flag a client sends is only its own claim.

**Design (not built):** when Ardia starts a plugin activity, it mints a random per-activity credential and hands it to
the plugin's CLI child on an inherited file descriptor (never an environment variable, a file, or
`ArdiaControl.json`, which every process of the user can read). The child sends it in `hello` as `session`; the socket
looks it up, marks the connection `plugin`, and drops the credential when the activity ends or the connection closes.
A connection without one is the owner's. A plugin connection may call `hello`, `methods` and the mediated browse verbs
as they land, and nothing else: no `apply`, `run`, `subscribe`, `answer`, `plugins.*`, and none of the store methods
above. The dispatcher already has its single check point for this: `controlSocket.ts` asks `connectionAccess` for each
request and `accessProblem` (`socketCatalog.ts`) refuses everything outside `PLUGIN_SESSION_METHODS` for a plugin
connection, before params are even checked. Until the credential exists every connection is `owner`.

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

## Native UI: prompts and menus

Some of what a person answers in Ardia isn't a page and isn't in a store: a permission prompt already on screen, a
`<select>` popup, a context menu, the menu bar. DevTools can't answer them (issue #2812, rows 3, 14,
16 and 17), so the socket does, through the same decision path the native UI uses. Every method here is in `methods`
with its schema, refuses plugin sessions at the dispatcher check point, stops writing when control is turned off, and
counts in `cli_socket_calls_permissions`, `cli_socket_calls_menus` or `cli_socket_calls_secrets`.

| Method | Mutates | What it does, and the path it takes |
| --- | --- | --- |
| `permissions.prompts` | no | The prompt each tab shows (`{id, window, tab, origin, permissions, queued}`); `queued` counts the prompts waiting behind it |
| `permissions.respond {id, decision}` | yes | `allow` and `block` as the Allow and Don't Allow buttons (remembered), `dismiss` as the close button, `allowOnce` for this visit only. `allowOnce` is refused unless the prompt names its kinds and every one is camera, microphone, camera pan-tilt-zoom or location, since the engine turns a one-time grant of anything else into a lasting one. The reply waits for the app's native layer to accept the answer (`permissions.answer`, which checks the request is still pending, as tracked from the engine's request and dismiss callbacks) and is `failed` when it isn't; only then does the next queued prompt show. Notifications and location still ask macOS, and Chrome records the decision as a click would |
| `passwords.prompts` | no | Save and update password prompts: `id` (Ardia's own, new for every prompt a tab shows), origin, state, username, at most 20 of the usernames an update offers (each cut to 256 characters) and `usernameCount`; never the password or its length |
| `passwords.respond {tab, id, decision, username?}` | yes | `save`, `never`, `update`, `notNow`, `dismiss`, only the buttons that prompt shows. `no_window` when the tab now shows another prompt than `id`. The native layer then checks the engine's prompt still has the state, origin and username that were listed, and that the answer is one of that state's buttons, before it answers; otherwise `failed` |
| `autofill.prompts` | no | Save address, update address and save card prompts: the engine's `id`, origin, `kind`, `fields` (for an update: which of name, address, email, phone, other change) and a `description` Ardia writes from those. Never the engine's text (an update's summary holds the name and street), the address lines or the card |
| `autofill.respond {tab, id, decision}` | yes | `accept`, `decline`, `dismiss`. `no_window` when the tab now shows another prompt or its page is gone; `failed` when the engine's prompt id no longer matches or it stays open after the answer |
| `menus.open` | no | Open menus with their owner (`window`, and `tab` for a page's menu) and items (`path`, `ref`, `title`, `enabled`, `checked`, `separator`, `submenu`): `kind` is `select` (a page's `<select>` popup), `page` (a page's context menu), `app` (an Ardia menu), `menuBar`. A menu whose window isn't one the ardia command may use (private, unknown, closed) isn't listed, nor a page menu without a known tab in that window |
| `menus.choose {menu, path, ref?}` | yes | A page's `<select>` popup or context menu: the item's own action, as a click (trusted `input` and `change` for a `<select>`). The menu bar while it tracks: needs `ref` and goes through exactly the `menus.runBar` rules, then the menu closes. Ardia's own menus (`app`) and anything else are refused: their callbacks (an engine switch, copying the sync recovery code) aren't commands `run` allows |
| `menus.dismiss {menu}` | yes | Closes a menu without choosing |
| `menus.bar` | no | The menu bar as shown now: every item's path, title, enabled, checked, shortcut, and its `command` and `arg` when `run` takes it, or its AppKit `action` |
| `menus.runBar {path, ref, window?}` | yes | An Ardia command goes through `run`, so the automation policy (`automationCommands.ts`: no Quit, no engine switch, no Allow JavaScript from Apple Events, the settings `config.json` can't set) still applies; an editing or window item (Undo, Copy, Paste, Select All, Minimize, Zoom) goes through the allowlist in `MenuBarAction` and is sent to the responder chain of the named eligible window, only when it is the key window, never to whatever happens to be first responder. Everything else (Quit, Hide, Close Window, Check for Updates, system input, Check Document Now, Show Substitutions…) is refused. `ref` is the item's command or selector plus its title path; the native side checks it at `path` before acting, so a menu rebuilt since `menus.bar` can't run another item |

**Events:** `permission.prompted` (`{id, windowId, tabId, origin, permissions, queued}`), `password.prompted`
(`{id, windowId, tabId, origin, state, username, usernames, usernameCount}`, the same capped list; named only, not in `"*"`), `menu.opened` (`{id, kind, windowId, tabId, items}`, `items` being a count), `menu.closed`. None of
them reach plugins.

**What `run` already covered.** `run` and the `commands` catalogue cover every Ardia command in the menu bar; what was
missing was reading the menu as data (enabled and checked state, which `menuState.ts` computes and `MainMenu` applies)
and the menu items that aren't Ardia commands (Edit and Window). `menus.bar` and `menus.runBar` add only those.

**How it works.** `OpenSurfaces.swift` (in `packages/shell`) runs in the app process, where Chromium shows these menus,
and watches `NSMenuDidBeginTracking`/`NSMenuDidEndTracking`. A `<select>` popup is the `NSMenu` of Chromium's
`WebMenuRunner` (`content/app_shim_remote_cocoa/web_menu_runner_mac.mm`), a page's context menu Chromium's
`MenuControllerCocoa`. Choosing calls the item's own action and the menu ends tracking as after a click. Every menu
carries its owner: a `<select>` popup the tab and window whose view holds the popup's anchor, a visible context menu
the tab holding the key window's first responder and that window, the menu bar and Ardia's menus the key window. The
socket shows a menu only when that window is one the ardia command may use and, for a page's menu, the tab is in it.

**Background mode.** A hidden instance (`ARDIA_BACKGROUND=1`) doesn't show a page's context menu: the engine hands it to
the app (`-tab:runContextMenu:`), which used to hold it open in a nested run loop. That loop is gone. While the socket
serves, the app captures the menu as data (`ArdiaPageMenuCaptured`: the tab, its window, the engine's document count and
URL, the items) and returns at once, so the engine closes its menu as before. `menus.choose` on a captured menu runs
the item's command for that tab: `+[ArdiaWebView runCapturedMenuCommand:tab:documents:url:]` refuses when the tab
closed, its document count or URL changed, and otherwise sends the editing items (Undo, Redo, Cut, Copy, Paste, Paste
and Match Style, Delete, Select All, Chromium's `IDC_CONTENT_CONTEXT_*` 50150–50157) to the page's
`RenderWidgetHostViewCocoa`, which hands them to the focused frame, the frame the right click focused. A captured menu
lasts 60 s, is replaced by the next one, is used once, and is dropped when control turns off or the menus module goes
away. Other items are refused until the engine can run them (below). Without a serving socket the menu is logged as
before. A `<select>` popup is a real AppKit menu in either mode.

**Needs engine code (joins #2808's build or a later key).** These change `engine/ardiacore/src/ardia/core`, so they
move the engine key; until then the app-side checks above stand in.
- *Captured context-menu commands.* `ACContextMenu::ShowThroughHost` keeps, per tab, the menu's `ContextMenuParams`, the
  `GlobalRenderFrameHostId` it was built for and that frame's document token, for 60 s. A new
  `-[ArdiaCoreTab runContextMenuCommand:(int)command menu:(NSString *)token flags:(int)flags]` rebuilds an
  `ACContextMenu` for that frame with those params and calls `ExecuteCommand` when `IsCommandIdEnabled`, returning NO
  when the frame is gone, its document changed, the token was replaced or the time ran out. The app then drops its
  editing-item mapping and runs every item (Open Link in New Tab, Copy Link, Save Image As…) for its own frame.
- *Password prompts.* `PasswordPrompt()` in `ac_password_prompt.mm` adds an `id` that changes whenever
  `PasswordsModelDelegate` enters a pending state, and `-resolvePasswordPrompt:id:username:password:` returns BOOL:
  NO when the id differs or the action isn't one of the current state's (`save`/`never` for pending, `update`/`nope`
  for pending update). The app then lists the engine's id instead of its own.
- *Autofill prompts.* `ResolveAutofillPrompt` returns whether a prompt with that id was answered, so the app needn't
  read `autofillPrompt` again afterwards.
- *Permissions.* `+[ArdiaCoreEngine resolvePermission:]` returns BOOL (the prompt was found and was current), and
  `ACPermissionPrompt::Apply` takes an explicit `acceptOnce`: it refuses (dismisses nothing, returns NO) unless every
  request supports temporary grants, instead of falling back to a lasting `Accept`. `AskHost` lists a kind it doesn't
  name as `other` rather than leaving it out, so a prompt's kinds are never silently shorter than its requests.

**The color picker is Blink's, not AppKit's.** The issue's row 14 expected `NSColorPanel`, but in this Chromium a web
page never reaches it on desktop: `WebContentsDelegate::OpenColorChooser` is compiled only for Android and iOS
(`content/public/browser/web_contents_delegate.h`), and nothing on the browser side calls `ColorPanelHost`, so
`color_panel_bridge.mm` is unused. Clicking `<input type=color>` opens Blink's own HTML picker
(`ColorChooserPopupUIController`, `color_picker.js`) in a page popup window, measured in a hidden instance as a new
230×248 window owned by Ardia. That popup isn't a DevTools target and its layout is Blink's private HTML, so the app
can't choose in it reliably by synthesizing clicks. **Designed, needs engine code (joins #2808 or a later key):** a
hook where `RenderWidgetHostImpl` shows the page popup for a color input (`g_ardia_page_popup_shown`) that hands the
app the popup's widget, plus `ac_color_popup_set_value(widget, rgb)` calling the popup's own
`pagePopupController.setValue` path, as a person's choice in it does; the socket then gets `menus.open` entries of kind
`color` and `menus.chooseColor {menu, color}`. Whether DevTools key events reach the open popup (a person can type a
hex value into it) wasn't measured here; row 14's run found no keyboard path for color.

### Payment, passkey and password sheets

| Sheet | Who shows it | Socket |
| --- | --- | --- |
| Save or update password, save address or card | Ardia (`Prompts.tsx`, from `ac_password_prompt.mm` and `ac_autofill_prompt.mm`) | ✅ listed and answered above |
| Payment sheet (`PaymentRequest.show()`) | Chromium's views dialog (`PaymentRequestDialogView`, from `ChromePaymentRequestDelegate::ShowDialog`), not Ardia | 🗺️ needs engine code |
| Chrome's WebAuthn sheet (choose a passkey, phone, security key) | Chromium's views dialog (`AuthenticatorRequestDialogView`) | 🗺️ needs engine code |
| iCloud Keychain passkey sheet, Touch ID, the macOS password prompt | macOS (`ASAuthorizationController`, `LAContext`) | ⛔ macOS owns it; the socket can't list or answer it |
| Print preview | Chrome's `chrome://print` dialog (`PrintPreviewDialogController`) | CLI: attach to the `chrome://print` target once #2808 opens `chrome://` targets |

**Payment sheet, designed.** Ardia doesn't own it today: `ChromePaymentRequestDelegate::ShowDialog` builds Chromium's
views dialog over the page. To answer it the engine needs a hook beside `g_ardia_create_permission_prompt`
(`g_ardia_payment_dialog`) that hands the sheet's state to the app: merchant origin, total and its label, the payment
apps on offer (by name, never their instruments). The app then shows Ardia's own sheet, and the socket gets
`payments.sheets` and `payments.respond {id, decision: pay|cancel, app?}`. Paying with an installed payment app only
starts that app (its window asks for anything secret); the socket never sees card data. This is engine work and joins
#2808's build (or a later engine key); it is not in this change. Until then `PaymentRequest.show()` behaves as Chromium
does, and the test page's `https://127.0.0.1/pay` method has no app, so it rejects with `NotSupportedError` before any
sheet.

**Passkeys, designed.** Chrome's own WebAuthn sheet is views UI and needs the same kind of engine hook
(`g_ardia_authenticator_dialog`) before Ardia can list its steps (choose a passkey, use a phone, a security key) and the
socket can pick one. Creating or using a passkey then goes to macOS: the iCloud Keychain sheet and Touch ID belong to
macOS, can't be answered by any app, and shouldn't be: they are the proof that the owner is present. So the socket stops
at listing Ardia's own step, and the owner touches the sensor. A virtual authenticator (`WebAuthn.addVirtualAuthenticator`
over DevTools) remains the way to test, never the owner's real keys.

## Next

Designed, not built in this round, each in its own file under `state/automation/socket<Area>.ts`:

- **Window geometry:** `windows.setFrame {window, frame}`, `windows.setMaximized`, `windows.setFullScreen`. The store's
  `frame`, `maximized` and `fullScreen` follow the native window (`windows/windowSync.ts`), so these need a native
  call that moves the window (`ArdiaWindows`), which doesn't exist yet; `run` covers full screen through its command.

- **Tile folders:** `pins.folders {profile?}`, `pins.createFolder {tabs, name}`, `pins.renameFolder`, `pins.removeFolder`
  through `state/pins/tileFolders.ts`.
- **Favicons:** `favicons.get {url, profile?}` → the cached PNG as base64, through `resolveFavicon`.
- **Shared folders:** `sharedFolders.list`, `sharedFolders.share {group}`, `sharedFolders.stop {group}` through
  `state/sharedFolders/actions.ts`.
- **Live folders:** `live.list`, `live.refresh {folder}`, `live.hide {folder, item}` through `state/live`.
- **Presets:** `presets.apply {code}` through `applySetupCode`.
- **Air traffic:** `airTraffic.rules`, `airTraffic.setRule {app, route}` through `state/airTraffic/rules.ts`.
- **Sync:** `sync.now`, `sync.setType {type, on}`, `sync.setProfile {profile, on}`, `sync.sendTab {tab, device}`
  through `state/sync/engine.ts`.
- **Extensions:** `extensions.install {webStoreId}` (opens the install prompt the user confirms), `extensions.configure`.
- **Settings refused today:** `pageEngine` and `websiteEngines` once a socket write can move open pages between engines as
  the Settings pane does; `newTabUrl` and `customSearchUrl` with the URL checks `apply` uses.
- **Events:** `bookmarks.changed`, `history.removed`, `download.changed`, `profile.changed`.
- **Native UI, engine side** (with #2808's build or a later key): the payment and WebAuthn hooks above; the context
  menu's checked state in `DescribeMenu` (`ac_context_menu.mm` reports enabled and visible only); and the tab that opened
  a `<select>` popup passed with it, in place of the focus lookup; the color popup hook above.
