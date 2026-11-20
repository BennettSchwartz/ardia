import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = readFileSync(new URL("../../../../scripts/windows/tour.ps1", import.meta.url), "utf8");
const paramBlock = /^param\(([\s\S]*?)^\)/m.exec(source);
const paramNames = [...(paramBlock?.[1] ?? "").matchAll(/\]\s*\$(\w+)/g)].map((m) => m[1]);

const setupEnd = source.indexOf('if (-not ([System.Management.Automation.PSTypeName]"ArdiaTour").Type)');
const setup = source.slice(0, setupEnd);

const listsIn = (text) => [...text.matchAll(/^\$script:(\w+) = \[System\.Collections\.Generic\.List\[string\]\]::new\(\)/gm)].map((m) => m[1]);
const lists = listsIn(setup);
const allLists = listsIn(source);

const found = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
const hasPwsh = !found.error && found.status === 0;

test("none of tour.ps1's lists has the name of one of its parameters", () => {
  assert.ok(paramNames.includes("App") && paramNames.includes("Required"), `parameters read: ${paramNames.join(", ")}`);
  assert.ok(setupEnd > 0 && lists.length >= 2 && allLists.length > lists.length, `lists found: ${allLists.join(", ")}`);
  const shadowing = allLists.filter((name) => paramNames.some((param) => param.toLowerCase() === name.toLowerCase()));
  assert.deepEqual(shadowing, [], "a $script: list named like a parameter is the parameter itself, and takes its type");
});

test("tour.ps1 keeps -Required, and every list it starts accepts an Add", { skip: !hasPwsh && "pwsh is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ardia-tour-"));
  try {
    const script = join(dir, "tour-setup.ps1");
    writeFileSync(
      script,
      [setup, ...lists.map((name) => `$script:${name}.Add("probe")`), 'Write-Output "required=$($Required -join ",")"'].join("\n"),
    );
    const ran = spawnSync(
      "pwsh",
      ["-NoProfile", "-File", script, "-App", "Ardia.exe", "-Out", join(dir, "out"), "-Required", "peek-tabs"],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout, /^required=peek-tabs$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
