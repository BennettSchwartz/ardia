import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const native = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/ardiacore/ios");
const clang = process.platform === "darwin" && spawnSync("xcrun", ["--find", "clang++"]).status === 0;
const skip = !clang && "needs clang++";

const MAIN = `
#import <Foundation/Foundation.h>
#import "ArdiaExtensionStaging.h"
int main(int argc, char **argv) {
  @autoreleasepool {
    NSString *verb = @(argv[1]);
    NSString *root = @(argv[2]);
    NSDictionary *out;
    if ([verb isEqualToString:@"stage"]) {
      out = ardia_extensions::StageUnpacked(@(argv[3]), root);
    } else {
      NSString *error = nil;
      NSString *installed = ardia_extensions::PromoteStaged(@(argv[3]), @(argv[4]), root, &error);
      out = installed ? @{@"installed" : installed} : @{@"error" : error ?: @""};
    }
    NSMutableDictionary *shown = [NSMutableDictionary dictionary];
    for (NSString *key in out) if ([out[key] isKindOfClass:NSString.class]) shown[key] = out[key];
    printf("%s\\n", [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:shown options:0 error:nil] encoding:NSUTF8StringEncoding].UTF8String);
  }
  return 0;
}
`;

let work;
let run;

before(() => {
  if (skip) return;
  work = realpathSync(mkdtempSync(join(tmpdir(), "extension-staging-")));
  writeFileSync(join(work, "main.mm"), MAIN);
  run = join(work, "stage");
  const sources = ["ArdiaExtensionStaging.mm", "ArdiaExtensionPackage.mm"].map((f) => join(native, f));
  execFileSync("xcrun", ["clang++", "-std=c++17", "-fobjc-arc", `-I${native}`, ...sources, join(work, "main.mm"), "-framework", "Foundation", "-o", run], { stdio: "pipe" });
});

after(() => {
  if (!work) return;
  spawnSync("chmod", ["-R", "u+rwx", work]);
  rmSync(work, { recursive: true, force: true });
});

const staging = (...args) => JSON.parse(execFileSync(run, args, { encoding: "utf8" }).trim());

function extension(name, files) {
  const folder = join(work, "src", name, "ext");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({ manifest_version: 3, name, version: "1.0" }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), body);
  }
  return folder;
}

test("the sheet describes Ardia's copy, and confirming installs that copy even after the source changes", { skip }, () => {
  const root = join(work, "data-a");
  const folder = extension("edited", { "background.js": "one();" });
  const staged = staging("stage", root, folder);
  assert.ok(staged.digest && staged.staged, JSON.stringify(staged));
  assert.equal(staged.path, folder);
  writeFileSync(join(folder, "background.js"), "two();");
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "edited", version: "9.9" }));
  const promoted = staging("promote", root, staged.staged, staged.digest);
  assert.ok(promoted.installed, JSON.stringify(promoted));
  assert.equal(readFileSync(join(promoted.installed, "background.js"), "utf8"), "one();");
  assert.match(readFileSync(join(promoted.installed, "manifest.json"), "utf8"), /"1\.0"/);

  writeFileSync(join(folder, "background.js"), "three();");
  const again = staging("stage", root, folder);
  const replaced = staging("promote", root, again.staged, again.digest);
  assert.equal(replaced.installed, promoted.installed, "a reinstall of the same folder keeps the same place, so the same id");
  assert.equal(readFileSync(join(replaced.installed, "background.js"), "utf8"), "three();");
});

test("a copy changed after the sheet showed it isn't installed", { skip }, () => {
  const root = join(work, "data-b");
  const staged = staging("stage", root, extension("tampered", { "a.js": "a" }));
  writeFileSync(join(staged.staged, "a.js"), "b");
  assert.match(staging("promote", root, staged.staged, staged.digest).error, /changed/);
});

test("an unreadable subfolder is refused, not hashed as empty", { skip }, () => {
  const folder = extension("locked", { "inner/a.js": "a" });
  chmodSync(join(folder, "inner"), 0o000);
  try {
    assert.match(staging("stage", join(work, "data-c"), folder).error ?? "", /inner couldn't be read/);
  } finally {
    chmodSync(join(folder, "inner"), 0o755);
  }
});

test("any file over 4 MB is refused, not only the manifest and icons", { skip }, () => {
  const folder = extension("big", { "content.js": Buffer.alloc(5 * 1024 * 1024, 120) });
  assert.match(staging("stage", join(work, "data-d"), folder).error ?? "", /content\.js is bigger than 4 MB/);
});

test("locales and icons come from the copied files only: a link out of the folder is refused before anything is read", { skip }, () => {
  const outside = join(work, "outside.json");
  writeFileSync(outside, JSON.stringify({ name: { message: "Leaked" } }));
  const folder = extension("linked", {});
  mkdirSync(join(folder, "_locales", "en"), { recursive: true });
  symlinkSync(outside, join(folder, "_locales", "en", "messages.json"));
  const staged = staging("stage", join(work, "data-e"), folder);
  assert.match(staged.error ?? "", /links outside/);
});

test("Chromium's _metadata and hidden files stay out of the copy and the digest", { skip }, () => {
  const folder = extension("meta", { "_metadata/computed_hashes.json": "{}", ".git/HEAD": "ref", "a.js": "a" });
  const first = staging("stage", join(work, "data-f"), folder);
  writeFileSync(join(folder, "_metadata", "computed_hashes.json"), "{\"changed\":1}");
  const second = staging("stage", join(work, "data-f"), folder);
  assert.equal(first.digest, second.digest);
  assert.equal(spawnSync("test", ["-e", join(first.staged, "_metadata")]).status, 1);
});
