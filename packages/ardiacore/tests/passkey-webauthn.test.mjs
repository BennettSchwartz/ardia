import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const swiftc = process.env.SWIFTC || "swiftc";

test("passkey encoding, key import and relying-party rules", { skip: process.platform !== "darwin" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ardia-passkey-webauthn-"));
  try {
    const binary = join(dir, "passkey-webauthn");
    const main = join(dir, "main.swift");
    copyFileSync(path("./passkey-webauthn.test.swift"), main);
    const build = spawnSync(
      swiftc,
      ["-O", "-o", binary, path("../ios/PasskeyWebAuthn.swift"), path("../ios/PasskeyRelyingParty.swift"), main],
      { encoding: "utf8" },
    );
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [path("../ios/public_suffix_list.dat")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /all checks passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
