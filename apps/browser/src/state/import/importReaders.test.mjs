import assert from "node:assert/strict";
import { test } from "node:test";
import { listSources } from "../../../../../packages/import/src/readers/discovery.ts";
import { joinPath, parentPath } from "../../../../../packages/import/src/readers/host.ts";
import { importProfile, Unlocks } from "../../../../../packages/import/src/readers/importer.ts";
import { arcSidebarPath } from "../../../../../packages/import/src/readers/sidebars.ts";
import { HOME, posixHost } from "./fixtures/posixHost.mjs";
import { fakeHost } from "./fixtures/windowsHost.mjs";

const quiet = { progress() {}, cancelled: () => false };
const SECRETS = {
  logins: { items: [{ url: "https://login.example/", username: "ada", password: "pw" }], undecryptable: 1, appBound: 2 },
  cookies: { count: 7, undecryptable: 0, appBound: 3, dropped: 0, token: "a".repeat(32) },
  autofill: { addresses: 1, cards: 2, lockedCards: 1, undecryptable: 0, appBound: 0 },
  firefoxLogins: { items: [{ url: "https://fox.example/", username: "fox", password: "pw" }], undecryptable: 0, appBound: 0 },
  firefoxCookies: { count: 4, undecryptable: 0, appBound: 0, dropped: 0, skipped: 2 },
};

const pathFree = (value) =>
  JSON.parse(JSON.stringify(value, (key, v) => (key === "path" || key === "avatarPath" ? undefined : typeof v === "string" ? v.replaceAll("\\", "/") : v)));

test("A path joins with the host's own separator", () => {
  assert.equal(joinPath("\\", "C:\\Users\\a\\", "/Google/Chrome/", "Profiles/x.default"), "C:\\Users\\a\\Google\\Chrome\\Profiles\\x.default");
  assert.equal(joinPath("/", "/home/a/", "/.config/", "google-chrome", "", "."), "/home/a/.config/google-chrome");
  assert.equal(joinPath("/", "/home/a", "odd\\name"), "/home/a/odd\\name");
  assert.equal(joinPath("/", "/", "etc"), "/etc");
  assert.equal(parentPath({ separator: "/" }, "/home/a/Arc/User Data"), "/home/a/Arc");
  assert.equal(parentPath({ separator: "/" }, "/Arc"), "/");
  assert.equal(parentPath({ separator: "\\" }, "C:\\Arc\\User Data"), "C:\\Arc");
});

test("A POSIX host finds the same browsers, profiles and kinds as the Windows host", async () => {
  const windows = await listSources(fakeHost());
  const posix = await listSources(posixHost());
  assert.deepEqual(posix.map((s) => s.id).sort(), windows.map((s) => s.id).sort());
  assert.deepEqual(pathFree(posix).sort((a, b) => a.id.localeCompare(b.id)), pathFree(windows).sort((a, b) => a.id.localeCompare(b.id)));
  const chrome = posix.find((s) => s.id === "chrome").profiles.find((p) => p.id === "Default");
  assert.equal(chrome.path, `${HOME}/Google/Chrome/Default`);
  const firefox = posix.find((s) => s.id === "firefox").profiles.find((p) => p.id === "Profiles/abcd1234.default-release");
  assert.equal(firefox.path, `${HOME}/Firefox/Profiles/abcd1234.default-release`);
});

test("Every kind of every fixture profile reads the same through a POSIX host as through the Windows host", async () => {
  const sources = await listSources(posixHost());
  let compared = 0;
  for (const source of sources) {
    for (const profile of source.profiles) {
      const read = (host) => importProfile(host, new Unlocks(), source.id, profile.id, profile.available, {}, quiet);
      const [posix, windows] = await Promise.all([read(posixHost(SECRETS, "Windows")), read(fakeHost(SECRETS))]);
      assert.deepEqual(pathFree(posix), pathFree(windows), `${source.id} ${profile.id}`);
      compared += profile.available.length;
    }
  }
  assert.ok(compared >= 40, `compared ${compared} kinds`);
});

test("Arc's sidebar files are read from the folder that holds its User Data", async () => {
  const host = posixHost();
  assert.equal(arcSidebarPath(host), `${HOME}/Arc/StorableSidebar.json`);
  const result = await importProfile(host, new Unlocks(), "arc", "Default", ["spaces", "linkRules", "archive"], {}, quiet);
  assert.deepEqual(result.failed, []);
  assert.ok(result.spaces.length > 0 && result.arcRouting.rules.length > 0);
  assert.ok(host.calls.some(([kind, folder, path]) => kind === "readTextWithin" && folder === `${HOME}/Arc` && path === `${HOME}/Arc/StorableSidebar.json`));
});

test("Secret counts and messages name the host's platform and the source browser", async () => {
  const result = await importProfile(posixHost(SECRETS), new Unlocks(), "chrome", "Default", ["passwords", "cookies", "autofill", "favorites"], {}, quiet);
  assert.equal(result.credentials.length, 1);
  assert.equal(result.cookieCount, 7);
  assert.equal(result.vaultToken, "a".repeat(32));
  const messages = result.warnings.map((w) => `${w.kind}: ${w.message}`);
  assert.ok(messages.includes("passwords: 1 password couldn't be decrypted"), messages.join("\n"));
  assert.ok(messages.includes("passwords: 2 passwords use Google Chrome's app-bound encryption, which only Google Chrome can read"), messages.join("\n"));
  assert.ok(messages.some((m) => /^cookies: Skipped 3 cookies locked by Google Chrome's app-bound encryption/.test(m)), messages.join("\n"));
  assert.ok(messages.includes("autofill: 1 saved card need Google Chrome's key, which Linux couldn't unwrap"), messages.join("\n"));
  assert.ok(messages.includes("favorites: Google Chrome has no favorites to import on Linux"), messages.join("\n"));
  assert.deepEqual(result.failed, ["favorites"]);
});
