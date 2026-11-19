import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
#import "ArdiaExtensionWalk.h"
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>
using namespace ardia_extensions;
int main(int argc, char **argv) {
  @autoreleasepool {
    NSString *root = @(argv[1]);
    NSMutableDictionary *staged = [NSMutableDictionary dictionary];
    NSMutableDictionary *lives = [NSMutableDictionary dictionary];
    NSMutableArray *out = [NSMutableArray array];
    for (int i = 2; i < argc; i++) {
      NSArray<NSString *> *op = [@(argv[i]) componentsSeparatedByString:@"|"];
      NSString *verb = op[0];
      NSMutableDictionary *row = [NSMutableDictionary dictionaryWithObject:@(argv[i]) forKey:@"op"];
      if ([verb isEqualToString:@"stage"]) {
        NSDictionary *info = StageUnpacked(op[2], op[3], root);
        for (NSString *key in @[ @"error", @"staged", @"digest", @"installId", @"installPath", @"path", @"name", @"version" ])
          if ([info[key] isKindOfClass:NSString.class]) row[key] = info[key];
        if (info[@"staged"]) staged[op[1]] = @{@"staged" : info[@"staged"], @"digest" : info[@"digest"], @"profile" : op[3]};
      } else if ([verb isEqualToString:@"begin"]) {
        NSDictionary *s = staged[op[1]];
        NSString *error = nil;
        NSString *live = BeginPromotion(s[@"staged"], s[@"digest"], s[@"profile"], root, &error);
        row[@"live"] = live ?: NSNull.null;
        row[@"error"] = error ?: NSNull.null;
        if (live) lives[op[1]] = live;
      } else if ([verb isEqualToString:@"finish"]) {
        FinishPromotion(lives[op[1]], [op[2] isEqualToString:@"1"]);
      } else if ([verb isEqualToString:@"write"]) {
        [op[3] writeToFile:[staged[op[1]][@"staged"] stringByAppendingPathComponent:op[2]] atomically:NO encoding:NSUTF8StringEncoding error:nil];
      } else if ([verb isEqualToString:@"discard"]) {
        DiscardStaged(staged[op[1]][@"staged"], root);
      } else if ([verb isEqualToString:@"remove"]) {
        RemoveManaged(op[1], op[2], root);
      } else if ([verb isEqualToString:@"info"]) {
        row[@"info"] = ManagedInfo(op[1], root) ?: NSNull.null;
      } else if ([verb isEqualToString:@"backdate"]) {
        struct timeval old[2] = {{(long)(NSDate.date.timeIntervalSince1970 - 3 * 86400), 0}, {(long)(NSDate.date.timeIntervalSince1970 - 3 * 86400), 0}};
        utimes([staged[op[1]][@"staged"] fileSystemRepresentation], old);
      } else if ([verb isEqualToString:@"swap"]) {
        NSString *folder = op[1], *inner = op[2], *outside = op[3];
        SetWalkHook(^(NSString *relative) {
          if (![relative isEqualToString:inner]) return;
          NSString *at = [folder stringByAppendingPathComponent:inner];
          rename(at.fileSystemRepresentation, [at stringByAppendingString:@"-moved"].fileSystemRepresentation);
          symlink(outside.fileSystemRepresentation, at.fileSystemRepresentation);
        });
      } else if ([verb isEqualToString:@"id"]) {
        row[@"id"] = IdForPath(op[1]);
      }
      [out addObject:row];
    }
    printf("%s\\n", [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:out options:0 error:nil] encoding:NSUTF8StringEncoding].UTF8String);
  }
  return 0;
}
`;

let work;
let run;
let roots = 0;

before(() => {
  if (skip) return;
  work = realpathSync(mkdtempSync(join(tmpdir(), "extension-staging-")));
  writeFileSync(join(work, "main.mm"), MAIN);
  run = join(work, "stage");
  const sources = ["ArdiaExtensionStaging.mm", "ArdiaExtensionWalk.mm", "ArdiaExtensionPackage.mm"].map((f) => join(native, f));
  execFileSync("xcrun", ["clang++", "-std=c++17", "-fobjc-arc", `-I${native}`, ...sources, join(work, "main.mm"), "-framework", "Foundation", "-o", run], { stdio: "pipe" });
});

after(() => {
  if (!work) return;
  spawnSync("chmod", ["-R", "u+rwx", work]);
  rmSync(work, { recursive: true, force: true });
});

const freshRoot = () => join(work, `data-${++roots}`, "Ardia Unpacked Extensions");
const ops = (root, ...list) => {
  mkdirSync(dirname(root), { recursive: true });
  return JSON.parse(execFileSync(run, [root, ...list], { encoding: "utf8", timeout: 20_000 }).trim());
};

function extension(name, files = {}, manifest = {}) {
  const folder = join(work, "src", name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({ manifest_version: 3, name, version: "1.0", ...manifest }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), body);
  }
  return folder;
}

const live = (rows, index) => rows[index].live;
const read = (folder, file) => readFileSync(join(folder, file), "utf8");

test("each profile gets its own copy: approving a newer copy in Work leaves Personal's files alone", { skip }, () => {
  const root = freshRoot();
  const folder = extension("shared", { "bg.js": "one" });
  const first = ops(root, `stage|personal|${folder}|personal`, "begin|personal", "finish|personal|1");
  writeFileSync(join(folder, "bg.js"), "two");
  const second = ops(root, `stage|work|${folder}|work`, "begin|work", "finish|work|1");
  assert.notEqual(live(first, 1), live(second, 1));
  assert.equal(read(live(first, 1), "bg.js"), "one", "Personal still runs what it approved");
  assert.equal(read(live(second, 1), "bg.js"), "two");
});

test("a reinstall Chromium rejects leaves the earlier copy exactly as it was", { skip }, () => {
  const root = freshRoot();
  const folder = extension("rejected", { "bg.js": "one" });
  const [, accepted] = ops(root, `stage|a|${folder}|p`, "begin|a", "finish|a|1");
  writeFileSync(join(folder, "bg.js"), "two");
  const rows = ops(root, `stage|b|${folder}|p`, "begin|b", "finish|b|0");
  assert.equal(rows[1].live, accepted.live, "the same place, so the same id");
  assert.equal(read(accepted.live, "bg.js"), "one");
  assert.deepEqual(readdirSync(dirname(accepted.live)).filter((n) => n.endsWith(".stage")), [], "the rejected copy is gone");
  const swapped = ops(root, `stage|c|${folder}|p`, "begin|c", "finish|c|1", `info|${accepted.live}`);
  assert.equal(read(accepted.live, "bg.js"), "two");
  assert.deepEqual(readdirSync(dirname(accepted.live)).filter((n) => n.endsWith(".stage")), [], "the old copy goes once Chromium accepts the new one");
  assert.equal(swapped[3].info.source, folder);
  assert.equal(swapped[3].info.digest, swapped[0].digest);
});

test("the id Chromium will assign is predicted from the key or from the copy's place", { skip }, () => {
  const root = freshRoot();
  const unkeyed = ops(root, `stage|u|${extension("unkeyed")}|p`)[0];
  assert.equal(unkeyed.installId, ops(root, `id|${unkeyed.installPath}`)[0].id);
  assert.match(unkeyed.installPath, /\/p-[0-9a-f]{16}\/[0-9a-f]{32}\/live$/);
  const key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest";
  const keyed = ops(root, `stage|k|${extension("keyed", {}, { key })}|p`)[0];
  assert.match(keyed.installId, /^[a-p]{32}$/);
  assert.notEqual(keyed.installId, ops(root, `id|${keyed.installPath}`)[0].id);
});

test("a folder swapped for a link mid-walk is still read through the folder Ardia opened", { skip }, () => {
  const root = freshRoot();
  const outside = join(work, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "x.js"), "secret");
  const folder = extension("swapped", { "a/x.js": "inside" });
  const [, stage] = ops(root, `swap|${folder}|a|${outside}`, `stage|s|${folder}|p`);
  assert.ok(stage.staged, JSON.stringify(stage));
  assert.ok(existsSync(join(folder, "a-moved")), "the folder was swapped for a link while Ardia walked it");
  assert.equal(read(stage.staged, "a/x.js"), "inside");
});

test("links, FIFOs and unreadable folders are refused without blocking", { skip }, () => {
  const root = freshRoot();
  const linked = extension("linked", { "real.js": "x" });
  symlinkSync(join(linked, "real.js"), join(linked, "alias.js"));
  assert.match(ops(root, `stage|l|${linked}|p`)[0].error, /alias\.js is a link/);
  const piped = extension("piped");
  execFileSync("mkfifo", [join(piped, "pipe")]);
  assert.match(ops(root, `stage|f|${piped}|p`)[0].error, /pipe isn't a file or a folder/);
  const locked = extension("locked", { "inner/a.js": "a" });
  chmodSync(join(locked, "inner"), 0o000);
  try {
    assert.match(ops(root, `stage|u|${locked}|p`)[0].error, /inner couldn't be read/);
  } finally {
    chmodSync(join(locked, "inner"), 0o755);
  }
});

test("default_locale must name a folder inside _locales", { skip }, () => {
  const root = freshRoot();
  const escaping = extension("escaping", { "_locales/en/messages.json": "{}" }, { default_locale: "../../outside" });
  assert.match(ops(root, `stage|e|${escaping}|p`)[0].error, /default_locale/);
  const missing = extension("missing", { "_locales/en/messages.json": "{}" }, { default_locale: "fr" });
  assert.match(ops(root, `stage|m|${missing}|p`)[0].error, /default_locale/);
  const fine = extension("fine", { "_locales/en/messages.json": JSON.stringify({ title: { message: "Fine One" } }) }, { default_locale: "en", name: "__MSG_title__" });
  assert.equal(ops(root, `stage|g|${fine}|p`)[0].name, "Fine One");
});

test("big assets are copied; only files read into memory keep the 4 MB cap", { skip }, () => {
  const root = freshRoot();
  const big = extension("big", { "model.bin": Buffer.alloc(5 * 1024 * 1024, 1) });
  const stage = ops(root, `stage|b|${big}|p`)[0];
  assert.ok(stage.staged, JSON.stringify(stage));
  assert.equal(readFileSync(join(stage.staged, "model.bin")).length, 5 * 1024 * 1024);
  const hugeManifest = extension("huge-manifest");
  writeFileSync(join(hugeManifest, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1", pad: "x".repeat(5 * 1024 * 1024) }));
  assert.match(ops(root, `stage|h|${hugeManifest}|p`)[0].error, /Manifest/);
});

test("version control and Finder files stay out; other dotfiles are copied", { skip }, () => {
  const root = freshRoot();
  const folder = extension("dots", { ".git/HEAD": "ref", ".DS_Store": "x", ".config.json": "{}", "_metadata/computed_hashes.json": "{}" });
  const stage = ops(root, `stage|d|${folder}|p`)[0];
  assert.deepEqual(readdirSync(stage.staged).sort(), [".config.json", "manifest.json"]);
});

test("the sweep keeps a day-old stage that's still showing and removes only stale stages it made", { skip }, () => {
  const root = freshRoot();
  const rows = ops(root, `stage|keep|${extension("kept")}|p`, "backdate|keep", `stage|other|${extension("other")}|p`);
  assert.ok(existsSync(rows[0].staged), "the active stage survives the sweep");
  const keyFolder = dirname(rows[2].staged);
  const stale = join(keyFolder, "1700000000000-00000000-0000-0000-0000-000000000000.stage");
  const unrelated = join(keyFolder, "notes");
  mkdirSync(stale);
  mkdirSync(unrelated);
  utimesSync(stale, new Date(Date.now() - 3 * 86400e3), new Date(Date.now() - 3 * 86400e3));
  utimesSync(unrelated, new Date(Date.now() - 3 * 86400e3), new Date(Date.now() - 3 * 86400e3));
  ops(root, `stage|again|${extension("again")}|p`);
  assert.equal(existsSync(stale), false, "an inactive stage of the exact pattern goes");
  assert.equal(existsSync(unrelated), true, "anything else stays");
});

test("the staging root must be private to the user", { skip }, () => {
  const root = freshRoot();
  ops(root, `stage|a|${extension("private")}|p`);
  chmodSync(root, 0o755);
  assert.match(ops(root, `stage|b|${extension("private")}|p`)[0].error, /isn't private/);
  const fake = join(work, "fake-root-target");
  mkdirSync(fake, { mode: 0o700 });
  const linkedRoot = freshRoot();
  mkdirSync(dirname(linkedRoot), { recursive: true });
  symlinkSync(fake, linkedRoot);
  assert.match(ops(linkedRoot, `stage|c|${extension("private")}|p`)[0].error, /isn't private/);
});

test("a tampered copy isn't promoted, and uninstall removes the managed copy", { skip }, () => {
  const root = freshRoot();
  const folder = extension("tampered", { "a.js": "a" });
  assert.match(ops(root, `stage|t|${folder}|p`, "write|t|extra.js|b", "begin|t")[2].error ?? "", /changed/);
  const [, ok] = ops(root, `stage|g|${folder}|p`, "begin|g", "finish|g|1");
  ops(root, `remove|${ok.live}|p`);
  assert.equal(existsSync(dirname(ok.live)), false);
});
