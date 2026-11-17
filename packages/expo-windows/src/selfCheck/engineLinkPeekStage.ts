import { hostCall, onEngineTopic } from "../engine/host";
import { expectEqual, type Check } from "./check";
import { evaluate, LEFT, LINKS_TITLE, listed, painted, show, sleepOnce, withPages } from "./engineSleep";

const SAME_TAB_LINK = { x: 110, y: 30 };
const REAL_CLICK_MS = 30000;

type PeekConfig = { peek?: unknown; split?: unknown; otherSitePages?: unknown };
type Opened = { disposition?: unknown; url?: unknown } | null;

const peekConfig = (change: Record<string, unknown>) => hostCall<PeekConfig>("peek.config", change);

async function screenPoint(page: string, point: { x: number; y: number }) {
  const tab = (await listed(page)) as { left?: unknown; top?: unknown } | undefined;
  const scale = Number(await evaluate(page, 'post("result", JSON.stringify(window.devicePixelRatio));')) || 1;
  return { x: Math.round(Number(tab?.left) + point.x * scale), y: Math.round(Number(tab?.top) + point.y * scale) };
}

function openedFrom(page: string): Promise<Opened> {
  return new Promise((resolve) => {
    const watching = onEngineTopic("tab", (event: { key?: unknown; name?: unknown; data?: Opened }) => {
      if (event.key !== page || event.name !== "openWindow") return;
      clearTimeout(deadline);
      watching.remove();
      resolve(event.data ?? null);
    });
    const deadline = setTimeout(() => {
      watching.remove();
      resolve(null);
    }, REAL_CLICK_MS);
  });
}

async function peeksOnRealClick(name: string, wake: boolean) {
  const before = await peekConfig({});
  try {
    await peekConfig({ peek: "shift" });
    await withPages(
      [name],
      async ([page], windowId) => {
        await show(page!, windowId, LEFT);
        if (wake) await sleepOnce(page!, windowId, LINKS_TITLE);
        else await painted(page!);
        const at = await screenPoint(page!, SAME_TAB_LINK);
        const opened = openedFrom(page!);
        console.info(`[ardia windows] self-check note: peek stage ready ${name} ${at.x},${at.y}`);
        const event = await opened;
        expectEqual(
          { disposition: event?.disposition ?? null, url: String(event?.url ?? "").endsWith("/a") },
          { disposition: "peek", url: true },
          `a real Shift+click (sent by launch-smoke.ps1 through SendInput, so it passes the host's native mouse-up gate) on the ${name} page's link opens a Peek of it (openWindow ${JSON.stringify(event)})`,
        );
      },
      "links",
      LINKS_TITLE,
    );
  } finally {
    await peekConfig({ peek: before.peek, split: before.split, otherSitePages: Array.isArray(before.otherSitePages) ? before.otherSitePages : [] }).catch(() => null);
  }
}

export const linkPeekStage: Check[] = [
  { name: "engine links, real input: a Shift+click on an ordinary page's link opens a Peek", run: () => peeksOnRealClick("ordinary", false) },
  { name: "engine links, real input: a Shift+click on a sandboxed (opaque-origin) page's link opens a Peek", run: () => peeksOnRealClick("sandboxed", false) },
  { name: "engine links, real input: a Shift+click on a page that just woke from sleep opens a Peek", run: () => peeksOnRealClick("woken", true) },
];
