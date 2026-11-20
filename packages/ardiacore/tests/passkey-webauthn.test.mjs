import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const swiftc = process.env.SWIFTC || "swiftc";

const passkeySources = ["PasskeyWebAuthn.swift", "PasskeyRelyingParty.swift", "PasskeyStore.swift", "PasskeyAuthenticator.swift", "PasskeyCoordinator.swift", "PasskeyImport.swift"].map((f) => path(`../ios/${f}`));

function runSwiftChecks(name) {
  const dir = mkdtempSync(join(tmpdir(), `ardia-${name}-`));
  try {
    const binary = join(dir, name);
    const main = join(dir, "main.swift");
    copyFileSync(path(`./${name}.test.swift`), main);
    const bridge = join(dir, "bridge.h");
    writeFileSync(bridge, `#import "${path("../ios/ArdiaPasskeys.h")}"\n`);
    const build = spawnSync(swiftc, ["-O", "-import-objc-header", bridge, "-o", binary, ...passkeySources, main], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [path("../ios/public_suffix_list.dat")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /all checks passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const darwinOnly = { skip: process.platform !== "darwin" };
test("passkey encoding, key import and relying-party rules", darwinOnly, () => runSwiftChecks("passkey-webauthn"));
test("passkey store and authenticator: plans, assertions, registration, scoping", darwinOnly, () => runSwiftChecks("passkey-authenticator"));
test("passkey coordinator: origin and document binding, prompts, abort, withdrawal", darwinOnly, () => runSwiftChecks("passkey-coordinator"));
test("passkey import keeps only valid passkeys from a Credential Exchange export", darwinOnly, () => runSwiftChecks("passkey-import"));
