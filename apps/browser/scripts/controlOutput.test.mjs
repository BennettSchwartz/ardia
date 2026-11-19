import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/shell/ios/ControlOutput.swift");
const swiftc = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;

const MAIN = `
import Foundation
var out = ControlOutput()
let big = Data(repeating: UInt8(ascii: "x"), count: 1024 * 1024)
var event = Data("{\\"event\\":\\"history.removed\\",\\"data\\":\\"".utf8)
event.append(big)
event.append(Data("\\"}\\n".utf8))
var kept = 0
for _ in 0..<12 { if out.addEvent(event) { kept += 1 } }
let reply = out.addReply(Data("{\\"id\\":1,\\"result\\":true}\\n".utf8), ticket: 1)
let huge = Data(repeating: UInt8(ascii: "y"), count: 5 * 1024 * 1024)
let tooBig = out.addEvent(huge)
print("accepted=\\(kept) reply=\\(reply) huge=\\(tooBig) bytes=\\(out.bytes) dropped=\\(out.dropped) limit=\\(ControlOutput.maxBytes)")
`;

test("a slow reader's event backlog drops the oldest events with a dropped count instead of closing the connection", { skip: !swiftc && "needs swiftc" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "control-output-"));
  try {
    writeFileSync(join(dir, "main.swift"), MAIN);
    execFileSync("xcrun", ["swiftc", "-O", source, join(dir, "main.swift"), "-o", join(dir, "run")], { stdio: "pipe" });
    const line = execFileSync(join(dir, "run"), { encoding: "utf8" }).trim();
    const got = Object.fromEntries(line.split(" ").map((kv) => kv.split("=")));
    assert.equal(got.accepted, "12", "every event is accepted: none closes the connection");
    assert.equal(got.reply, "true", "a reply still fits after the backlog");
    assert.equal(got.huge, "true", "an event bigger than the whole budget is dropped, not fatal");
    assert.ok(Number(got.bytes) <= Number(got.limit));
    assert.ok(Number(got.dropped) >= 9, `older events were dropped and counted (${got.dropped})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
