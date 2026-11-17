import type { DomainModule } from "@ardia/ardiacore";
import { engineAvailable, hostCall, onEngineTopic } from "../engine/host";
import { requireNativeModule } from "../modules";
import { httpPagesPort } from "./engineBackForward";
import { expectTrue } from "./check";
import { evaluate, firstWindow, LEFT, listed, RIGHT, show, until } from "./engineSleep";
import { dataFolder } from "./importFiles";

export const LOAD_MS = 20000;
export const EVENT_MS = 8000;
export const POPUP_PLACE = { unit: "px", x: 620, y: 40, width: 240, height: 180 };
export const port = engineAvailable() ? httpPagesPort() : null;
export const origin = `http://127.0.0.1:${port}`;

type PageEvent = { key?: unknown; name?: unknown; data?: Record<string, unknown> };
export type Behind = { lastFocused?: { id?: number; windowId?: number; url?: string } | null; current?: { id?: number; windowId?: number; url?: string } | null; window?: number };

const extensions = () => requireNativeModule<DomainModule>("ArdiaExtensions");

export async function installed(folder: string): Promise<string> {
  const answer = JSON.parse(await extensions().call("install", "", JSON.stringify({ path: `${dataFolder()}\\${folder}` }))) as { id?: unknown };
  expectTrue(typeof answer.id === "string" && answer.id.length > 0, `the unpacked ${folder} extension installs (got ${JSON.stringify(answer)})`);
  return answer.id;
}

export const uninstall = (id: string) => extensions().call("uninstall", "", JSON.stringify({ id })).catch(() => null);
export const setEnabled = (id: string, enabled: boolean) => extensions().call("setEnabled", "", JSON.stringify({ id, enabled }));
export const allowPrivate = (id: string, incognito: boolean) => extensions().call("configure", "", JSON.stringify({ id, options: { incognito } }));

export async function act(key: string, id: string, windowId: string, input = true): Promise<unknown> {
  if (input) await hostCall("input.noteForTest", {}, windowId);
  return (await hostCall<{ result?: unknown }>("tab.call", { key, method: "executeExtensionAction", extensionId: id }, windowId)).result;
}

export async function popupUrl(key: string, id: string): Promise<string> {
  const states = (await hostCall<{ states?: Record<string, { popup?: unknown }> }>("tab.call", { key, method: "extensionActionStates", ids: [id] })).states ?? {};
  return String(states[id]?.popup ?? "");
}

export function heardFrom(key: string, name: string, wanted: (data: Record<string, unknown>) => boolean = () => true, ms = EVENT_MS): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const watching = onEngineTopic("tab", (event: PageEvent) => {
      if (event.key !== key || event.name !== name || !wanted(event.data ?? {})) return;
      clearTimeout(deadline);
      watching.remove();
      resolve(event.data ?? {});
    });
    const deadline = setTimeout(() => {
      watching.remove();
      resolve(null);
    }, ms);
  });
}

export async function openPopup(key: string, url: string, windowId: string): Promise<Record<string, unknown> | null> {
  const loaded = heardFrom(key, "navigation", (data) => data.isLoading === false);
  const sized = heardFrom(key, "preferredSize");
  await hostCall("popup.create", { key, url, profile: "" }, windowId);
  await hostCall("tab.show", { key, visible: true, ...POPUP_PLACE }, windowId);
  expectTrue(await loaded, `the pop-up ${key} reports its page loaded`);
  return sized;
}

export const closePopup = (key: string) => hostCall("tab.close", { key }).catch(() => null);

export const inPage = async <Result>(key: string, call: string) => (await evaluate(key, `Promise.resolve(${call}).then((value) => post("result", JSON.stringify(value ?? null)), (error) => post("result", JSON.stringify({ error: String(error && error.message) })));`)) as Result;

export type Pages = { windowId: string; left: string; right: string; leftUrl: string; rightUrl: string; control: string; clickControl?: string };

export async function withPages(name: string, ids: { popup: string; click?: string }, run: (pages: Pages) => Promise<void>, rightUrl = `${origin}/b`) {
  const windowId = await firstWindow();
  const pages: Pages = { windowId, left: `self-check-ext-${name}-left`, right: `self-check-ext-${name}-right`, leftUrl: `${origin}/a`, rightUrl, control: `self-check-ext-${name}-control` };
  if (ids.click) pages.clickControl = `self-check-ext-${name}-click-control`;
  const keys = [pages.left, pages.right, pages.control, ...(pages.clickControl ? [pages.clickControl] : [])];
  try {
    await hostCall("tab.create", { key: pages.left, url: pages.leftUrl, profile: "" }, windowId);
    await hostCall("tab.create", { key: pages.right, url: pages.rightUrl, profile: "" }, windowId);
    await hostCall("tab.create", { key: pages.control, url: `chrome-extension://${ids.popup}/control.html`, profile: "" }, windowId);
    if (ids.click && pages.clickControl) await hostCall("tab.create", { key: pages.clickControl, url: `chrome-extension://${ids.click}/control.html`, profile: "" }, windowId);
    for (const key of keys) await until(`the page ${key} loads`, LOAD_MS, () => listed(key), (tab) => tab?.loading === false && String(tab?.url ?? "").length > 0);
    await show(pages.left, windowId, LEFT);
    await show(pages.right, windowId, RIGHT);
    await run(pages);
  } finally {
    for (const key of keys) await hostCall("tab.close", { key }).catch(() => null);
  }
}

export const tabIdOf = (control: string, url: string) => inPage<number | null>(control, `tabIdOf(${JSON.stringify(url)})`);

let installing: Promise<{ popup: string; click: string }> | null = null;

export const testExtensions = () => (installing ??= Promise.all([installed("self-check-extension-popup"), installed("self-check-extension-click")]).then(([popup, click]) => ({ popup, click })));

export async function removeTestExtensions() {
  if (!installing) return;
  const ids = await installing.catch(() => null);
  installing = null;
  if (ids) for (const id of [ids.popup, ids.click]) await uninstall(id);
}
