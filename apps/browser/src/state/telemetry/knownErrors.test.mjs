import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { KNOWN_ERROR_CODES, knownErrorCode, knownErrorMessage } from "./knownErrors.ts";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const packages = readdirSync(join(ROOT, "packages")).filter((name) => statSync(join(ROOT, "packages", name)).isDirectory());
const SCRIPT_TREES = ["apps/browser/src", "apps/linux/src", ...packages.map((name) => `packages/${name}/src`)];
const CODE_TREES = ["engine", "apps/browser/windows", ...SCRIPT_TREES, ...packages.map((name) => `packages/${name}/ios`)];
const SOURCE = /\.(?:tsx?|m?js|cjs|cc|cpp|h|hpp|mm|m|swift|patch|py)$/;
const SCRIPT = /\.(?:tsx?|m?js|cjs)$/;
const SKIPPED_FOLDERS = new Set(["node_modules", "tests", "test", "test-native", "fixtures", "__tests__", "Pods", "build"]);
const DERIVED = new Set(["knownErrors.ts", "errorTemplates.ts", "logTemplates.ts", "nativeFunctions.ts"].map((name) => join(ROOT, "apps/browser/src/state/telemetry", name)));
const TEST_FILE = /\.(?:test|spec)\.[^.]+$|(?:^|_)test\.py$|_(?:unittest|browsertest)\.(?:cc|mm)$/;

function sources(tree, pattern) {
  const start = join(ROOT, tree);
  if (!existsSync(start)) return [];
  const found = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(path);
      } else if (entry.isFile() && pattern.test(entry.name) && !TEST_FILE.test(entry.name) && !DERIVED.has(path)) found.push(path);
    }
  };
  walk(start);
  return found;
}

const ERR_LITERAL = /"(ERR_[A-Z0-9_]+)"/g;
const ARDIA_ERROR = /new ArdiaError\("([^"\\]+)", "[^"\\]*"\)/g;

const codesIn = (text) => new Set([...text.matchAll(ERR_LITERAL)].map(([, code]) => code));
const scanned = CODE_TREES.flatMap((tree) => sources(tree, SOURCE));
const definedCodes = new Set();
for (const file of scanned) for (const code of codesIn(readFileSync(file, "utf8"))) definedCodes.add(code);
for (const tree of SCRIPT_TREES)
  for (const file of sources(tree, SCRIPT)) for (const [, code] of readFileSync(file, "utf8").matchAll(ARDIA_ERROR)) definedCodes.add(code);

const difference = (wanted, have) => [...wanted].filter((item) => !have.has(item)).sort();

test("the known error codes are exactly the ones Ardia's sources define", () => {
  const known = new Set(KNOWN_ERROR_CODES);
  assert.ok(definedCodes.size > 100, `only ${definedCodes.size} codes found; the scan is looking in the wrong place`);
  assert.deepEqual({ missing: difference(definedCodes, known), extra: difference(known, definedCodes) }, { missing: [], extra: [] });
});

test("an allowlist entry that no source defines is caught, because the allowlist and the generated tables aren't counted as sources", () => {
  for (const path of DERIVED) assert.equal(scanned.includes(path), false, path);
  const allowlist = join(ROOT, "apps/browser/src/state/telemetry/knownErrors.ts");
  assert.ok(codesIn(readFileSync(allowlist, "utf8")).has("ERR_ENGINE"), "the allowlist would vouch for its own entries if it were scanned");
  const withObsolete = new Set([...KNOWN_ERROR_CODES, "ERR_ONLY_IN_THE_ALLOWLIST"]);
  assert.deepEqual(difference(withObsolete, definedCodes), ["ERR_ONLY_IN_THE_ALLOWLIST"]);
});

test("only a known message or the native call template comes back, and only a known code", () => {
  assert.equal(knownErrorMessage(new Error("the reply isn't JSON")), "the reply isn't JSON");
  assert.equal(knownErrorMessage(new Error("Calling the 'closeWindow' function has failed")), "Calling the 'closeWindow' function has failed");
  assert.doesNotMatch(knownErrorMessage(new Error("the reply isn't JSON: qwertySecretToken")), /qwerty/);
  assert.equal(knownErrorMessage(new Error("Calling the 'a b' function has failed")), "");
  assert.equal(knownErrorMessage("the reply isn't JSON"), "");
  assert.equal(knownErrorMessage({ message: 42 }), "");
  assert.equal(knownErrorCode(Object.assign(new Error("x"), { code: "ERR_ENGINE" })), "ERR_ENGINE");
  assert.equal(knownErrorCode(Object.assign(new Error("x"), { code: "cancelled" })), "cancelled");
  assert.equal(knownErrorCode(Object.assign(new Error("x"), { code: "ERR_MADE_UP_BY_A_PAGE" })), null);
  assert.equal(knownErrorCode(Object.assign(new Error("x"), { code: 7 })), null);
});

test("the native call form names only a function Ardia's native modules define, and nothing after it but Expo's cause", () => {
  assert.equal(knownErrorMessage(new Error("Calling the 'closeWindow' function has failed")), "Calling the 'closeWindow' function has failed");
  assert.equal(knownErrorMessage(new Error("Calling the 'closeWindow' function has failed\n→ Caused by: Bearer qwertySecretToken")), "Calling the 'closeWindow' function has failed");
  assert.equal(knownErrorMessage(new Error("Calling the 'aliceSecretProject' function has failed")), "");
  assert.equal(knownErrorMessage(new Error("Calling the 'closeWindow' function has failed\nsecret second line")), "");
});

test("an error message is known when it fits one of the messages Ardia's own code throws, and only the fixed words come back", () => {
  assert.equal(knownErrorMessage(new Error("Tab 4242 isn't open in that window.")), "Tab {} isn't open in that window.");
  assert.equal(knownErrorMessage(new Error("Couldn't open /Users/alice/Secret Plans")), "");
});
