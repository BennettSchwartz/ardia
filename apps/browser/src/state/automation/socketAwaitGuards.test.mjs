import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = resolve(here, "..");
const GUARD_NAMES = ["stillOn", "mayWrite", "mayDelete", "allowed", "serving", "stillServing"];
const WRITE = /(?:\bstore\(\)|\buseBrowser\.getState\(\)|\bnow\(\)|\bget\(\)|(?<![.\w])s)\.(?!getState\b)[a-z][A-Za-z]*\(|\buseBrowser\.setState\(|(?<![.\w])set\(/g;

function socketEntryFiles() {
  const automation = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).map((f) => join(here, f));
  return [...automation, join(stateDir, "commands", "commands.ts")];
}

function importsOf(file) {
  const text = readFileSync(file, "utf8");
  const out = [];
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)) {
    const target = resolve(dirname(file), m[2]);
    const path = [`${target}.ts`, `${target}.tsx`, join(target, "index.ts")].find(existsSync);
    if (!path || path.startsWith(here + "/")) continue;
    for (const raw of m[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name && !raw.trim().startsWith("type ")) out.push({ name, path });
    }
  }
  return out;
}

function bodyOf(text, start) {
  const open = text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return "";
}

function asyncFunction(path, name) {
  const text = readFileSync(path, "utf8");
  const decl = new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(([^)]*)\\)`).exec(text) ?? new RegExp(`export\\s+const\\s+${name}\\s*=\\s*async\\s*\\(([^)]*)\\)\\s*=>`).exec(text);
  if (!decl) return null;
  return { params: decl[1], body: bodyOf(text, decl.index) };
}

export function unguardedAwaits() {
  const seen = new Set();
  const problems = [];
  for (const file of socketEntryFiles()) {
    for (const { name, path } of importsOf(file)) {
      const key = `${path}#${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fn = asyncFunction(path, name);
      if (!fn) continue;
      const awaits = [...fn.body.matchAll(/\bawait\b/g)].map((m) => m.index);
      if (!awaits.length) continue;
      const guard = GUARD_NAMES.find((g) => new RegExp(`\\b${g}\\b`).test(fn.params));
      for (const write of fn.body.matchAll(WRITE)) {
        const lastAwait = awaits.filter((a) => a < write.index).at(-1);
        if (lastAwait === undefined) continue;
        const between = fn.body.slice(lastAwait, write.index);
        if (guard && new RegExp(`\\b${guard}\\(`).test(between)) continue;
        problems.push(`${path.slice(stateDir.length + 1)}: ${name} writes the store (${write[0]}) after an await without calling its guard`);
        break;
      }
    }
  }
  return problems;
}

test("every socket-reachable action that awaits before writing the store calls its guard after the await", () => {
  assert.deepEqual(unguardedAwaits(), []);
});
