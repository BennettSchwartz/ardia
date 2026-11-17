import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCOPES = ["apps/browser/src", "apps/linux/src"];
const TELEMETRY_DIR = "apps/browser/src/state/telemetry";
const TELEMETRY = /^apps\/browser\/src\/state\/telemetry\//;
const BASELINE = JSON.parse(readFileSync(new URL("./consent-baseline.json", import.meta.url), "utf8"));
const LATER_CALLEES = new Set(["setTimeout", "setInterval", "requestAnimationFrame", "queueMicrotask", "setImmediate"]);
const PROMISE_CALLBACKS = new Set(["then", "catch", "finally"]);
const LISTENER = /^(?:on[A-Z]\w*|addListener|addEventListener)$/;
const TOKEN_TAKERS = new Set(["consentNow", "consentToken"]);
const CONSOLE_LEVELS = new Set(["warn", "error"]);
const NOTER_NAME = /^(?:note|count|track)(?:[A-Z]\w*)?$/;
const INCREMENTS = new Set([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.PlusEqualsToken]);

const isTest = (rel) => /\.test\.[cm]?[jt]sx?$|(?:^|\/)(?:test-native|fixtures)\//.test(rel);

function sources(dir) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (name === "node_modules") continue;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.tsx?$/.test(name) && !isTest(rel)) out.push(rel);
  }
  return out;
}

const parse = (rel, text) => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const calleeName = (call) => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return "";
};

function laterCallback(fn) {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(fn)) return null;
  const name = calleeName(call);
  if (LATER_CALLEES.has(name)) return name;
  if (ts.isPropertyAccessExpression(call.expression) && PROMISE_CALLBACKS.has(name)) return `.${name}`;
  if (LISTENER.test(name)) return name;
  return null;
}

const enclosingFunction = (node) => {
  for (let at = node.parent; at; at = at.parent) if (ts.isFunctionLike(at)) return at;
  return null;
};

function awaitsBefore(fn, node) {
  let found = false;
  const visit = (at) => {
    if (found || at.pos >= node.pos) return;
    if (at !== fn && ts.isFunctionLike(at)) return;
    if (ts.isAwaitExpression(at) && at.end <= node.pos) found = true;
    ts.forEachChild(at, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return found;
}

const contains = (root, match) => {
  let found = false;
  const visit = (at) => {
    if (found) return;
    if (match(at)) found = true;
    else ts.forEachChild(at, visit);
  };
  visit(root);
  return found;
};

const declaredIn = (fn, name) => contains(fn, (at) => (ts.isVariableDeclaration(at) || ts.isParameter(at)) && ts.isIdentifier(at.name) && at.name.text === name);

const rootName = (target) => {
  let at = target;
  while (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at) || ts.isParenthesizedExpression(at)) at = at.expression;
  return ts.isIdentifier(at) ? at.text : null;
};

function incrementTarget(node) {
  if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) && node.operator === ts.SyntaxKind.PlusPlusToken) return node.operand;
  if (ts.isBinaryExpression(node) && INCREMENTS.has(node.operatorToken.kind)) return node.left;
  return null;
}

function suspension(node) {
  for (let fn = enclosingFunction(node), inner = node; fn; inner = fn, fn = enclosingFunction(fn)) {
    const later = laterCallback(fn);
    if (later) return { why: later, fn };
    if (awaitsBefore(fn, inner)) return { why: "await", fn };
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
    if (!fn.parent || !ts.isCallExpression(fn.parent) || !fn.parent.arguments.includes(fn)) return null;
  }
  return null;
}

const callsStillValid = (expr) => contains(expr, (at) => ts.isCallExpression(at) && calleeName(at) === "stillValid");
const exits = (statement) => ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || (ts.isBlock(statement) && statement.statements.length === 1 && exits(statement.statements[0]));

function guardedByStillValid(node, stop) {
  for (let child = node, at = node.parent; at && at !== stop; child = at, at = at.parent) {
    if (ts.isIfStatement(at) && child === at.thenStatement && callsStillValid(at.expression)) return true;
    if (ts.isConditionalExpression(at) && child === at.whenTrue && callsStillValid(at.condition)) return true;
    if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && child === at.right && callsStillValid(at.left)) return true;
    if (ts.isCallExpression(at) && calleeName(at) === "counted" && at.arguments[1] === child) return true;
    if (ts.isBlock(at) && at.statements.some((s) => s.end <= child.pos && ts.isIfStatement(s) && !s.elseStatement && exits(s.thenStatement) && callsStillValid(s.expression))) return true;
  }
  return false;
}

const inDefaultParameter = (node) => {
  for (let at = node.parent; at && !ts.isFunctionLike(at); at = at.parent) if (ts.isParameter(at)) return true;
  return false;
};

function topFunctions(file) {
  const out = [];
  const isFunction = (init) => init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
  for (const statement of file.statements) {
    const exported = !!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.name) out.push({ name: statement.name.text, fn: statement, exported });
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name) && isFunction(d.initializer)) out.push({ name: d.name.text, fn: d.initializer, exported });
  }
  return out;
}

const tokenIndex = (file, fn) => fn.parameters.findIndex((p) => p.type && /\bConsentToken\b/.test(p.type.getText(file)));

function localNoters(file) {
  const moduleVars = new Set(file.statements.filter(ts.isVariableStatement).flatMap((s) => s.declarationList.declarations).filter((d) => ts.isIdentifier(d.name)).map((d) => d.name.text));
  const functions = topFunctions(file);
  const noters = new Map();
  const bumpsModule = (fn) => contains(fn, (at) => {
    const target = incrementTarget(at);
    const name = target && rootName(target);
    return !!name && moduleVars.has(name) && !declaredIn(fn, name);
  });
  for (const f of functions) if (bumpsModule(f.fn) || (f.exported && NOTER_NAME.test(f.name))) noters.set(f.name, { token: tokenIndex(file, f.fn), exported: f.exported });
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of functions) {
      if (noters.has(f.name)) continue;
      const callsNoter = contains(f.fn, (at) => ts.isCallExpression(at) && ts.isIdentifier(at.expression) && noters.has(at.expression.text) && !passesToken(at, noters.get(at.expression.text)));
      if (callsNoter) noters.set(f.name, { token: tokenIndex(file, f.fn), exported: f.exported }), (grew = true);
    }
  }
  return noters;
}

const passesToken = (call, noter) => noter.token >= 0 && call.arguments.length > noter.token && !(ts.isIdentifier(call.arguments[noter.token]) && call.arguments[noter.token].text === "undefined");

let telemetryNoters = null;
function exportedNoters() {
  if (telemetryNoters) return telemetryNoters;
  telemetryNoters = new Map();
  for (const rel of sources(TELEMETRY_DIR)) {
    const file = parse(rel, readFileSync(join(ROOT, rel), "utf8"));
    for (const [name, noter] of localNoters(file)) if (noter.exported) telemetryNoters.set(name, noter);
  }
  return telemetryNoters;
}

function importedNoters(rel, file) {
  const out = new Map();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const target = posix.join(posix.dirname(rel), spec);
    if (!TELEMETRY.test(`${target}/`) && !TELEMETRY.test(target)) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const noter = exportedNoters().get((element.propertyName ?? element.name).text);
      if (noter) out.set(element.name.text, noter);
    }
  }
  return out;
}

export function findings(rel, text) {
  const file = parse(rel, text);
  const telemetry = TELEMETRY.test(rel);
  const noters = new Map([...importedNoters(rel, file), ...(telemetry ? localNoters(file) : [])]);
  const out = [];
  const lineOf = (node) => text.split("\n")[file.getLineAndCharacterOfPosition(node.getStart(file)).line].trim();
  const flag = (node, what, guardable = false) => {
    const suspended = suspension(node);
    if (suspended && !(guardable && guardedByStillValid(node, suspended.fn))) out.push(`${rel} | ${what} after ${suspended.why} | ${lineOf(node)}`);
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (TOKEN_TAKERS.has(name)) {
        if (inDefaultParameter(node)) out.push(`${rel} | ${name} as default parameter | ${lineOf(node)}`);
        else flag(node, name);
      }
      const noter = noters.get(name);
      if (noter && !passesToken(node, noter)) flag(node, `${name} without a token`, true);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "console" && CONSOLE_LEVELS.has(node.expression.name.text)) {
      flag(node, `console.${node.expression.name.text}`);
    }
    const target = telemetry ? incrementTarget(node) : null;
    const name = target && rootName(target);
    if (name) {
      const suspended = suspension(node);
      if (suspended && !declaredIn(enclosingFunction(node), name) && !guardedByStillValid(node, suspended.fn)) out.push(`${rel} | count after ${suspended.why} | ${lineOf(node)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

test("consent is taken when the activity starts: no token, noter, log or count after a suspension without a token", () => {
  const found = SCOPES.flatMap((scope) => sources(scope).map((rel) => findings(rel, readFileSync(join(ROOT, rel), "utf8")))).flat();
  const allowed = new Set(Object.keys(BASELINE));
  const unexpected = found.filter((f) => !allowed.has(f));
  const stale = [...allowed].filter((f) => !found.includes(f));
  assert.deepEqual({ unexpected, stale }, { unexpected: [], stale: [] }, "take a token with consentToken() when the activity starts and pass it on (warnFor/errorFor for logs), or list the line in consent-baseline.json with the reason");
});

const kinds = (rel, src) => findings(rel, src).map((f) => f.split(" | ")[1]);

test("the tripwire catches consentNow() and counts after await, in timers, promise callbacks and listeners", () => {
  const src = [
    "async function a() { await x(); capture('e', {}, consentNow()); }",
    "function b() { setTimeout(() => capture('e', {}, consentNow()), 0); }",
    "function c() { p.then(() => capture('e', {}, consentNow())); }",
    "function d() { onThing(() => capture('e', {}, consentNow())); }",
    "function e() { capture('e', {}, consentNow()); }",
    "function f() { const t = consentToken(); p.then(() => capture('e', {}, t)); }",
    "function g() { p.then((list) => list.forEach(() => capture('e', {}, consentNow()))); }",
  ].join("\n");
  assert.equal(findings("apps/browser/src/x.ts", src).length, 5);
  const counts = [
    "let n = 0;",
    "function g() { p.then(() => n++); }",
    "function h() { p.then(() => counted(t, () => n++)); }",
    "function i() { for (let k = 0; k < 2; k++) n += 1; }",
    "function j() { p.then(() => { if (stillValid(t)) n++; }); }",
    "function k() { p.then(() => { if (!stillValid(t)) return; n++; }); }",
    "function l() { p.then(() => { stillValid(t); n++; }); }",
    "function m() { p.then(() => counted(t, () => {}, () => n++)); }",
  ].join("\n");
  assert.deepEqual(kinds("apps/browser/src/state/telemetry/x.ts", counts), ["count after .then", "count after .then", "count after .then"]);
});

test("the tripwire catches Codex's blind-spot probes", () => {
  const rel = "apps/browser/src/state/telemetry/x.ts";
  assert.deepEqual(kinds(rel, "function send(t = consentNow()) { capture('e', {}, t); }\nsetTimeout(() => send(), 0);"), ["consentNow as default parameter"]);
  assert.deepEqual(kinds(rel, "function send({ t = consentToken() } = {}) { capture('e', {}, t); }"), ["consentToken as default parameter"]);
  assert.deepEqual(kinds(rel, "onThing(() => { const t = consentToken(); capture('e', {}, t); });"), ["consentToken after onThing"]);
  assert.deepEqual(kinds(rel, "let n = 0; function bump() { n++; } setTimeout(() => bump(), 0);"), ["bump without a token after setTimeout"]);
  assert.deepEqual(kinds(rel, "let n = 0; function bump() { n++; } function outer() { bump(); } p.then(() => outer());"), ["outer without a token after .then"]);
  assert.deepEqual(kinds(rel, "let n = 0; function bump(t: ConsentToken | null) { counted(t, () => n++); } p.then(() => bump(t));"), []);
  assert.deepEqual(kinds(rel, "let n = 0; function bump(t: ConsentToken | null) { counted(t, () => n++); } p.then(() => bump());"), ["bump without a token after .then"]);
});

test("the tripwire catches console warnings and telemetry noters after a suspension", () => {
  const ext = "apps/browser/src/state/extensions/x.ts";
  const logs = [
    "async function a() { await x(); console.warn('[x] failed'); }",
    "function b() { p.catch((error) => console.error('[x] failed', error)); }",
    "function c() { onThing(() => console.warn('[x] failed')); }",
    "function d() { console.warn('[x] failed'); }",
    "function e() { const t = consentToken(); p.catch((error) => warnFor(t, '[x] failed', error)); }",
  ].join("\n");
  assert.deepEqual(kinds(ext, logs), ["console.warn after await", "console.error after .catch", "console.warn after onThing"]);
  const noter = "import { noteExtensionActionStateFailure, noteLiveSave } from '../telemetry/workCounts';\n";
  assert.deepEqual(kinds(ext, `${noter}function a() { p.catch(() => (noteExtensionActionStateFailure(), null)); }`), ["noteExtensionActionStateFailure without a token after .catch"]);
  assert.deepEqual(kinds(ext, `${noter}function a() { const t = consentToken(); p.catch(() => (noteExtensionActionStateFailure(t), null)); }`), []);
  assert.deepEqual(kinds(ext, `${noter}function a() { noteExtensionActionStateFailure(consentToken()); }`), []);
});
