import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCOPES = ["apps/browser/src", "apps/linux/src"];
const TELEMETRY = /^apps\/browser\/src\/state\/telemetry\//;
const BASELINE = JSON.parse(readFileSync(new URL("./consent-baseline.json", import.meta.url), "utf8"));
const LATER_CALLEES = new Set(["setTimeout", "setInterval", "requestAnimationFrame", "queueMicrotask", "setImmediate"]);
const PROMISE_CALLBACKS = new Set(["then", "catch", "finally"]);
const LISTENER = /^(?:on[A-Z]\w*|addListener|addEventListener)$/;

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

const insideCall = (node, name, stop) => {
  for (let at = node.parent; at && at !== stop; at = at.parent) if (ts.isCallExpression(at) && calleeName(at) === name) return true;
  return false;
};

const declaredIn = (fn, name) => {
  let found = false;
  const visit = (at) => {
    if (found) return;
    if ((ts.isVariableDeclaration(at) || ts.isParameter(at)) && ts.isIdentifier(at.name) && at.name.text === name) found = true;
    ts.forEachChild(at, visit);
  };
  visit(fn);
  return found;
};

const rootName = (target) => {
  let at = target;
  while (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at) || ts.isParenthesizedExpression(at)) at = at.expression;
  return ts.isIdentifier(at) ? at.text : null;
};

const INCREMENTS = new Set([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.PlusEqualsToken]);

function incrementTarget(node) {
  if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) && node.operator === ts.SyntaxKind.PlusPlusToken) return node.operand;
  if (ts.isBinaryExpression(node) && INCREMENTS.has(node.operatorToken.kind)) return node.left;
  return null;
}

function suspension(fn, node) {
  if (!fn) return null;
  const later = laterCallback(fn);
  if (later) return later;
  return awaitsBefore(fn, node) ? "await" : null;
}

export function findings(rel, text) {
  const file = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const lineOf = (node) => text.split("\n")[file.getLineAndCharacterOfPosition(node.getStart(file)).line].trim();
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "consentNow") {
      const why = suspension(enclosingFunction(node), node);
      if (why) out.push(`${rel} | consentNow after ${why} | ${lineOf(node)}`);
    }
    const target = TELEMETRY.test(rel) ? incrementTarget(node) : null;
    if (target) {
      const fn = enclosingFunction(node);
      const name = rootName(target);
      const why = suspension(fn, node);
      const guarded = insideCall(node, "counted", null) || (fn?.body && /\bstillValid\(/.test(fn.body.getText(file)));
      if (why && name && !declaredIn(fn, name) && !guarded) out.push(`${rel} | count after ${why} | ${lineOf(node)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

test("consentNow() is only called in the same tick as the activity, and counts after a suspension carry a token", () => {
  const found = SCOPES.flatMap((scope) => sources(scope).map((rel) => findings(rel, readFileSync(join(ROOT, rel), "utf8")))).flat();
  const allowed = new Set(Object.keys(BASELINE));
  const unexpected = found.filter((f) => !allowed.has(f));
  const stale = [...allowed].filter((f) => !found.includes(f));
  assert.deepEqual({ unexpected, stale }, { unexpected: [], stale: [] }, "take a token with consentToken() when the activity starts, or list the line in consent-baseline.json with the reason");
});

test("the tripwire catches consentNow() and counts after await, in timers, promise callbacks and listeners", () => {
  const src = [
    "async function a() { await x(); capture('e', {}, consentNow()); }",
    "function b() { setTimeout(() => capture('e', {}, consentNow()), 0); }",
    "function c() { p.then(() => capture('e', {}, consentNow())); }",
    "function d() { onThing(() => capture('e', {}, consentNow())); }",
    "function e() { capture('e', {}, consentNow()); }",
    "function f() { const t = consentToken(); p.then(() => capture('e', {}, t)); }",
  ].join("\n");
  assert.equal(findings("apps/browser/src/x.ts", src).length, 4);
  const counts = ["let n = 0;", "function g() { p.then(() => n++); }", "function h() { p.then(() => counted(t, () => n++)); }", "function i() { for (let k = 0; k < 2; k++) n += 1; }"].join("\n");
  assert.deepEqual(findings("apps/browser/src/state/telemetry/x.ts", counts).map((f) => f.split(" | ")[1]), ["count after .then"]);
});
