import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findUnguardedWrites, loadProgram, socketRootFiles } from "./socketGuardLint.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the lint catches a write in a then callback, in a destructured action, and through a plain wrapper of an async helper", () => {
  const file = join(appDir, "src", "state", "automation", "lintProbe.ts");
  const probe = `import { useBrowser } from "../browser/store";
const store = () => useBrowser.getState();
const foo = async () => undefined;
async function later(id: string) {
  await foo();
  store().closeTabs([id]);
}
export function viaThen(id: string, mayWrite: () => boolean) {
  return foo().then(() => store().closeTabs([id]));
}
export async function viaDestructuring(id: string, mayWrite: () => boolean) {
  const { closeTabs } = store();
  await foo();
  closeTabs([id]);
}
export function viaWrapper(id: string) {
  return later(id);
}
export async function guarded(id: string, mayWrite: () => boolean) {
  await foo();
  if (!mayWrite()) return;
  store().closeTabs([id]);
}
`;
  const program = loadProgram(appDir, { [file]: probe });
  const found = findUnguardedWrites(program, [file]).filter((p) => p.includes("lintProbe"));
  assert.ok(found.some((p) => p.includes("viaThen")), found.join("\n"));
  assert.ok(found.some((p) => p.includes("viaDestructuring")), found.join("\n"));
  assert.ok(found.some((p) => p.includes("later")), found.join("\n"));
  assert.ok(!found.some((p) => p.includes("guarded")), found.join("\n"));
});

test("every socket-reachable action that writes the store after an await calls its guard first", () => {
  const program = loadProgram(appDir);
  assert.deepEqual(findUnguardedWrites(program, socketRootFiles(appDir)), []);
});
