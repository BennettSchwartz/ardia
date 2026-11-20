import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const UNSTABLE_HOOKS = ["useManagerPlugins"];

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

export function effectsOnUnstableValues(text) {
  const found = [];
  for (const hook of UNSTABLE_HOOKS) {
    for (const [, name] of text.matchAll(new RegExp(`const (\\w+) = ${hook}\\(\\)`, "g"))) {
      for (const [deps] of text.matchAll(/useEffect\([\s\S]*?\[([^\]]*)\]\s*\)/g)) {
        const list = deps.slice(deps.lastIndexOf("[") + 1);
        if (new RegExp(`\\b${name}\\b`).test(list)) found.push(`${hook}() as ${name}`);
      }
    }
  }
  return found;
}

test("the detector flags an effect that depends on a value rebuilt every render", () => {
  const looping = `const plugins = useManagerPlugins();\n  useEffect(() => setGroups(passkeyProviderSet(useBrowser.getState(), plugins)), [plugins, profiles]);`;
  assert.deepEqual(effectsOnUnstableValues(looping), ["useManagerPlugins() as plugins"]);
  const memoised = `const plugins = useManagerPlugins();\n  const key = useBrowser((s) => JSON.stringify(passkeyProviderSet(s, plugins)));\n  return useMemo(() => JSON.parse(key), [key]);`;
  assert.deepEqual(effectsOnUnstableValues(memoised), []);
});

test("no effect depends on useManagerPlugins(), which returns a new array on every render and would loop", () => {
  const offenders = sources(SRC).flatMap((file) => effectsOnUnstableValues(readFileSync(file, "utf8")).map((what) => `${file.slice(SRC.length)}: ${what}`));
  assert.deepEqual(offenders, []);
});
