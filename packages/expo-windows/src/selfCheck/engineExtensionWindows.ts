import type { DomainModule } from "@ardia/ardiacore";
import { engineAvailable, hostCall } from "../engine/host";
import { requireNativeModule } from "../modules";
import { httpPagesPort } from "./engineBackForward";
import { expectTrue, type Check } from "./check";
import { evaluate, firstWindow, hide, LEFT, listed, RIGHT, show, until } from "./engineSleep";
import { dataFolder } from "./importFiles";

const LOAD_MS = 20000;
const PAGES = ["a", "b"];

const extensions = () => requireNativeModule<DomainModule>("ArdiaExtensions");

async function installed(): Promise<string> {
  const answer = JSON.parse(await extensions().call("install", "", JSON.stringify({ path: `${dataFolder()}\\self-check-extension` }))) as { id?: unknown };
  expectTrue(typeof answer.id === "string" && answer.id.length > 0, `the unpacked self-check extension installs (got ${JSON.stringify(answer)})`);
  return answer.id;
}

const seen = async (key: string) => evaluate(key, 'extensionWindows().then((seen) => post("result", JSON.stringify(seen)), (error) => post("result", JSON.stringify({ error: String(error) })));');

function note(layout: string, keys: Record<string, string>, seenFrom: unknown) {
  console.info(`[ardia windows] self-check note: extension windows, ${layout}: pages ${JSON.stringify(keys)} saw ${JSON.stringify(seenFrom)}`);
}

const probeChecks = (port: string): Check[] => [
  {
    name: "engine extensions: what an extension page sees as its window and the other windows (a probe, recorded for #2317)",
    run: async () => {
      const windowId = await firstWindow();
      const id = await installed();
      const probe = "self-check-extension-probe";
      const pages = PAGES.map((name) => `self-check-extension-page-${name}`);
      const keys: Record<string, string> = { probe: `chrome-extension://${id}/probe.html` };
      try {
        for (const [index, key] of pages.entries()) {
          const url = `http://127.0.0.1:${port}/sleep?extension-${PAGES[index]}`;
          keys[key] = url;
          await hostCall("tab.create", { key, url, profile: "" }, windowId);
        }
        await hostCall("tab.create", { key: probe, url: keys.probe, profile: "" }, windowId);
        for (const key of [...pages, probe]) await until(`the page ${key} loads`, LOAD_MS, () => listed(key), (tab) => tab?.loading === false && String(tab?.url ?? "").length > 0);
        await show(pages[0]!, windowId, LEFT);
        await show(probe, windowId, RIGHT);
        note("page a shown left, the probe shown right, page b hidden", keys, await seen(probe));
        await hide(pages[0]!, windowId);
        note("only the probe shown, pages a and b hidden", keys, await seen(probe));
        await hide(probe, windowId);
        await show(pages[1]!, windowId, LEFT);
        note("page b shown, the probe hidden", keys, await seen(probe));
      } finally {
        for (const key of [...pages, probe]) await hostCall("tab.close", { key }).catch(() => null);
        await extensions().call("uninstall", "", JSON.stringify({ id })).catch(() => null);
      }
    },
  },
];

const port = engineAvailable() ? httpPagesPort() : null;

export const checks: Check[] = port ? probeChecks(port) : [];
