import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ERROR_TEMPLATES } from "./errorTemplates.ts";
import { LOG_TEMPLATES } from "./logTemplates.ts";
import { NATIVE_FUNCTIONS } from "./nativeFunctions.ts";
import { matchTemplate } from "./templates.ts";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const HERE = fileURLToPath(new URL("./", import.meta.url));
const packages = readdirSync(join(ROOT, "packages")).filter((name) => statSync(join(ROOT, "packages", name)).isDirectory());
const SCRIPT_TREES = ["apps/browser/src", "apps/linux/src", ...packages.map((name) => `packages/${name}/src`)];
const SWIFT_TREES = ["apps/browser/macos", ...packages.map((name) => `packages/${name}/ios`)];
const SKIPPED_FOLDERS = new Set(["node_modules", "tests", "test", "test-native", "fixtures", "__tests__", "Pods", "build"]);
const SKIPPED_FILE = /\.(?:test|spec)\.[^.]+$|\.d\.ts$|^test-(?:loader|hooks)\.mjs$/;

function sources(tree, pattern) {
  const start = join(ROOT, tree);
  if (!existsSync(start)) return [];
  const found = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(path);
      } else if (entry.isFile() && pattern.test(entry.name) && !SKIPPED_FILE.test(entry.name)) found.push(path);
    }
  };
  walk(start);
  return found;
}

const QUOTE = new Set(['"', "'", "`"]);
const OPEN = { "(": ")", "[": "]", "{": "}" };
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]$|^$|\b(?:return|typeof|case|in|of)$/;

function skipQuoted(text, i) {
  const quote = text[i];
  for (i++; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (quote === "`" && text[i] === "$" && text[i + 1] === "{") i = skipBalanced(text, i + 1) - 1;
    else if (text[i] === quote) return i + 1;
  }
  return i;
}

function skipRegex(text, i) {
  let inClass = false;
  for (i++; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "[") inClass = true;
    else if (text[i] === "]") inClass = false;
    else if (text[i] === "/" && !inClass) return i + 1;
    else if (text[i] === "\n") return i;
  }
  return i;
}

function scan(text, start, visit) {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (QUOTE.has(c)) i = skipQuoted(text, i);
    else if (c === "/" && REGEX_BEFORE.test(text.slice(Math.max(0, i - 8), i).trimEnd())) i = skipRegex(text, i);
    else if (visit(c, i) === false) return i;
    else i++;
  }
  return i;
}

function skipBalanced(text, open) {
  let depth = 0;
  return scan(text, open, (c) => {
    if (c in OPEN) depth++;
    else if (c === ")" || c === "]" || c === "}") return --depth > 0;
  }) + 1;
}

function callArguments(text, open) {
  const args = [];
  let depth = 0;
  let from = open + 1;
  scan(text, open, (c, i) => {
    if (c in OPEN) depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth > 0) return true;
      args.push(text.slice(from, i).trim());
      return false;
    } else if (c === "," && depth === 1) {
      args.push(text.slice(from, i).trim());
      from = i + 1;
    }
  });
  return args.filter((arg, index) => arg || index < args.length - 1);
}

const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

function cooked(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g, (_, escape) => {
    if (/^u\{/.test(escape)) return String.fromCodePoint(parseInt(escape.slice(2, -1), 16));
    if (/^[ux][0-9a-fA-F]/.test(escape)) return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (/^\r?\n$/.test(escape)) return "";
    return ESCAPES[escape] ?? escape;
  });
}

function literalPieces(arg) {
  if (!arg || !QUOTE.has(arg[0]) || skipQuoted(arg, 0) !== arg.length) return null;
  if (arg[0] !== "`") return [cooked(arg.slice(1, -1))];
  const pieces = [];
  let from = 1;
  for (let i = 1; i < arg.length - 1; i++) {
    if (arg[i] === "\\") i++;
    else if (arg[i] === "$" && arg[i + 1] === "{") {
      const end = skipBalanced(arg, i + 1);
      pieces.push(cooked(arg.slice(from, i)), { expression: arg.slice(i + 2, end - 1).trim() });
      from = end;
      i = end - 1;
    }
  }
  pieces.push(cooked(arg.slice(from, -1)));
  return pieces;
}

function ternaryBranches(arg) {
  let depth = 0;
  let question = -1;
  let colon = -1;
  scan(arg, 0, (c, i) => {
    if (c in OPEN) depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "?" && question < 0 && arg[i + 1] !== "." && arg[i + 1] !== "?" && arg[i - 1] !== "?") question = i;
    else if (depth === 0 && c === ":" && question >= 0 && colon < 0) colon = i;
  });
  return question > 0 && colon > question ? [arg.slice(question + 1, colon).trim(), arg.slice(colon + 1).trim()] : null;
}

function pieceLists(arg) {
  const pieces = literalPieces(arg);
  if (pieces) return [pieces];
  const branches = ternaryBranches(arg);
  return branches ? branches.flatMap(pieceLists) : [];
}

function fileConstants(text) {
  const constants = new Map();
  for (const [, name, value] of text.matchAll(/\bconst ([A-Za-z_$][\w$]*)\s*=\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|-?\d[\d_]*(?:\.\d+)?)(?:\s+as const)?\s*[;,\n]/g))
    constants.set(name, /^[-\d]/.test(value) ? String(Number(value.replace(/_/g, ""))) : cooked(value.slice(1, -1)));
  return constants;
}

function literalValues(arg, constants) {
  if (constants.has(arg)) return [constants.get(arg)];
  const lists = pieceLists(arg);
  if (!lists.length || lists.some((pieces) => pieces.length !== 1)) return null;
  return lists.map(([value]) => value);
}

const PLACEHOLDER = "{}";

function render(pieces, resolve) {
  const text = pieces.map((piece) => (typeof piece === "string" ? piece : (resolve(piece.expression) ?? PLACEHOLDER))).join("");
  return text.replace(/(?:\{\}){2,}/g, PLACEHOLDER);
}

const worthSending = (template) => /[A-Za-z]{2}/.test(template.split(PLACEHOLDER).join(""));

const LOG_CALLS = { "console.warn": 0, "console.error": 0, warnFor: 1, errorFor: 1 };
const ERROR_CALLS = {
  "new Error": 0, "new TypeError": 0, "new SyntaxError": 0, "new RangeError": 0, "new EngineError": 0, "new NoCommandWindowError": 0,
  "new PastDeadline": 0, "new BadArgs": 0,
  "new ArdiaError": 1, "new OpError": 1, "new LiveError": 1, "new ImportFailure": 1, "new ImportError": 1,
  documentError: 1, callError: 1, calendarError: 1, quitError: 1, credentialError: 1, failure: 1, super: 0,
};
const NO_MESSAGE_ERRORS = new Set(["HeldLoginsResetError", "SettleDidNotConverge", "RemoveFailed"]);
const LOG_WRAPPERS = [
  { file: "apps/browser/src/lib/fallback.ts", call: "orWarn", parameters: [null, "action"] },
  { file: "apps/browser/src/state/app/legacyFiles.ts", call: "migrateLegacyFile", parameters: ["name", "area"] },
  { file: "apps/browser/src/state/history/history.ts", call: "failed", parameters: ["what"], local: true },
  { file: "apps/browser/src/state/extensions/actions.ts", call: "changed", parameters: ["what"], local: true },
  { file: "apps/browser/src/state/extensions/actions.ts", call: "changeThenRefresh", parameters: [null, "what"], local: true },
  { file: "apps/browser/src/state/session/persist.ts", call: "read", parameters: ["name"], local: true },
  { file: "apps/browser/src/state/session/persist.ts", call: "write", parameters: ["name"], local: true },
];
const ERROR_WRAPPERS = [{ file: "apps/linux/src/hostCapabilities.ts", call: "unavailableError", parameters: ["feature"] }];

const callPattern = (callee) => new RegExp(`(?<![\\w$.])${callee.replace(/[.$]/g, "\\$&").replace(" ", "\\s+")}\\s*\\(`, "g");

const files = SCRIPT_TREES.flatMap((tree) => sources(tree, /\.(?:tsx?|m?js|cjs)$/)).map((path) => {
  const text = readFileSync(path, "utf8");
  return { path: relative(ROOT, path), text, constants: fileConstants(text) };
});

function callSites(file, callee) {
  return [...file.text.matchAll(callPattern(callee))]
    .filter((match) => !/\bfunction\s*$/.test(file.text.slice(Math.max(0, match.index - 12), match.index)))
    .map((match) => callArguments(file.text, match.index + match[0].length - 1));
}

function messagePieces(calls) {
  const found = new Map();
  for (const file of files) {
    const pieces = Object.entries(calls).flatMap(([callee, index]) => callSites(file, callee).flatMap((args) => pieceLists(args[index] ?? "")));
    found.set(file.path, pieces);
  }
  return found;
}

function composed(wrapper, piecesByFile) {
  const file = files.find((candidate) => candidate.path === wrapper.file);
  assert.ok(file, `${wrapper.file} is gone; update the wrapper list in messageTemplates.test.mjs`);
  const own = piecesByFile.get(wrapper.file).filter((pieces) => pieces.some((piece) => wrapper.parameters.includes(piece.expression)));
  assert.ok(own.length, `${wrapper.call} in ${wrapper.file} no longer puts ${wrapper.parameters.filter(Boolean)} in a message`);
  const templates = [];
  for (const caller of wrapper.local ? [file] : files)
    for (const args of callSites(caller, wrapper.call)) {
      let bindings = [new Map()];
      wrapper.parameters.forEach((name, index) => {
        const values = name && literalValues(args[index] ?? "", caller.constants);
        if (values) bindings = bindings.flatMap((bound) => values.map((value) => new Map(bound).set(name, value)));
      });
      for (const bound of bindings) for (const pieces of own) templates.push(render(pieces, (expression) => bound.get(expression) ?? file.constants.get(expression)));
    }
  return templates;
}

function templatesFor(piecesByFile, wrappers) {
  const texts = new Set();
  for (const file of files) for (const pieces of piecesByFile.get(file.path)) texts.add(render(pieces, (expression) => file.constants.get(expression)));
  for (const wrapper of wrappers) for (const text of composed(wrapper, piecesByFile)) texts.add(text);
  return [...texts].filter(worthSending).sort().map((text) => [templateId(text), text]);
}

function templateId(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

const nativeFunctions = () => {
  const names = new Set();
  for (const tree of SWIFT_TREES)
    for (const path of sources(tree, /\.swift$/)) for (const [, name] of readFileSync(path, "utf8").matchAll(/\b(?:Async)?Function\(\s*"([A-Za-z_$][\w$]{0,60})"/g)) names.add(name);
  return [...names].sort();
};

const pieces = { log: messagePieces(LOG_CALLS), error: messagePieces(ERROR_CALLS) };
const generated = { log: templatesFor(pieces.log, LOG_WRAPPERS), error: templatesFor(pieces.error, ERROR_WRAPPERS), native: nativeFunctions() };

const templateFile = (name, list) =>
  `import type { MessageTemplate } from "./templates";\n\nexport const ${name}: readonly MessageTemplate[] = [\n${list.map((pair) => `  ${JSON.stringify(pair)},`).join("\n")}\n];\n`;

function packed(names) {
  const lines = [];
  for (const name of names.map((value) => JSON.stringify(value))) {
    if (lines.length && lines.at(-1).length + name.length + 2 <= 128) lines[lines.length - 1] += ` ${name},`;
    else lines.push(`  ${name},`);
  }
  return lines.join("\n");
}

if (process.argv.includes("--write")) {
  writeFileSync(join(HERE, "logTemplates.ts"), templateFile("LOG_TEMPLATES", generated.log));
  writeFileSync(join(HERE, "errorTemplates.ts"), templateFile("ERROR_TEMPLATES", generated.error));
  writeFileSync(join(HERE, "nativeFunctions.ts"), `export const NATIVE_FUNCTIONS: readonly string[] = [\n${packed(generated.native)}\n];\n`);
}

const WRITE = "node --no-warnings --import ./src/test-loader.mjs src/state/telemetry/messageTemplates.test.mjs --write";
const difference = (wanted, have) => [...wanted].filter((item) => !have.has(item)).sort();
const inStep = (list, wanted, what) => {
  const have = list.map((item) => JSON.stringify(item));
  const want = wanted.map((item) => JSON.stringify(item));
  assert.deepEqual(
    { missing: difference(want, new Set(have)), extra: difference(have, new Set(want)) },
    { missing: [], extra: [] },
    `${what} are out of step with the sources; run \`${WRITE}\` in apps/browser`,
  );
};

test("the log templates are exactly the console.warn and console.error lines in Ardia's sources", () => {
  assert.ok(generated.log.length > 80, `only ${generated.log.length} log templates found; the scan is looking in the wrong place`);
  inStep(LOG_TEMPLATES, generated.log, "the log templates");
});

test("the error templates are exactly the messages Ardia's own code throws", () => {
  assert.ok(generated.error.length > 150, `only ${generated.error.length} error templates found; the scan is looking in the wrong place`);
  inStep(ERROR_TEMPLATES, generated.error, "the error templates");
});

test("the native function names are exactly the ones Ardia's native modules define", () => {
  assert.ok(generated.native.length > 200, `only ${generated.native.length} native functions found`);
  inStep(NATIVE_FUNCTIONS, generated.native, "the native function names");
});

test("every Error subclass and code-and-message factory is listed with where its message goes", () => {
  const listed = new Set(Object.keys(ERROR_CALLS).map((callee) => callee.replace(/^new /, "")));
  const unlisted = [];
  for (const file of files) {
    for (const [, name] of file.text.matchAll(/\bclass (\w+) extends \w*Error\b/g)) if (!listed.has(name) && !NO_MESSAGE_ERRORS.has(name)) unlisted.push(`${name} (${file.path})`);
    for (const [, name] of file.text.matchAll(/\bconst (\w+) = \(code: string, message: string\)/g)) if (!listed.has(name)) unlisted.push(`${name} (${file.path})`);
  }
  assert.deepEqual(unlisted, []);
});

test("each template id is its text's hash, unique, and no template's own words hold the placeholder", () => {
  for (const list of [LOG_TEMPLATES, ERROR_TEMPLATES]) {
    assert.equal(new Set(list.map(([id]) => id)).size, list.length);
    for (const [id, text] of list) assert.equal(id, templateId(text), text);
  }
  for (const file of files)
    for (const list of [...pieces.log.get(file.path), ...pieces.error.get(file.path)])
      for (const piece of list) if (typeof piece === "string") assert.ok(!piece.includes(PLACEHOLDER), `${file.path}: ${piece}`);
});

test("a rendered line fits the template with the most fixed words, anchored at both ends", () => {
  const templates = [["a", "[sync] {}"], ["b", "[sync] cycle failed"], ["c", "{} failed: {}"], ["d", "Tab {} isn't open {}."]];
  assert.equal(matchTemplate("[sync] cycle failed", templates)?.[0], "b");
  assert.equal(matchTemplate("[sync] something else", templates)?.[0], "a");
  assert.equal(matchTemplate("x [sync] cycle failed", templates), null);
  assert.equal(matchTemplate("Tab 4 isn't open here.", templates)?.[0], "d");
  assert.equal(matchTemplate("Tab 4 isn't open here", templates), null);
  assert.equal(matchTemplate("upload failed: secret", templates)?.[0], "c");
  assert.equal(matchTemplate(" failed: ", templates)?.[0], "c");
  assert.equal(matchTemplate("Tab .", templates), null);
});
