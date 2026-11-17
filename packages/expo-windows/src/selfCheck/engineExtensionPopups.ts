import { hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { pause } from "./engineSleep";
import { act, closePopup, inPage, openPopup, popupUrl, port, tabIdOf, testExtensions, withPages, type Behind } from "./engineExtensionKit";

const POPUP = "self-check-ext-popup";
const SIZE_SLACK = 2;

const popupChecks: Check[] = [
  {
    name: "engine extensions: a toolbar click on an action with a pop-up opens it in a page window the app places, its size reaches the app, and it is never a tab",
    run: async () => {
      const ids = await testExtensions();
      await withPages("open", ids, async (pages) => {
        expectEqual(await act(pages.right, ids.popup, pages.windowId), "popup", "executeExtensionAction after real input");
        const url = await popupUrl(pages.right, ids.popup);
        expectEqual(url, `chrome-extension://${ids.popup}/popup.html`, "the action's pop-up address for the tab");
        try {
          const size = await openPopup(POPUP, url, pages.windowId);
          expectEqual(await inPage(POPUP, "document.title"), "self-check popup", "the pop-up's page");
          expectTrue(size && Math.abs(Number(size.width) - 220) <= SIZE_SLACK && Math.abs(Number(size.height) - 140) <= SIZE_SLACK, `the pop-up's preferred size reaches the app (${JSON.stringify(size)})`);
          const tabs = (await hostCall<{ tabs?: { key: string }[] }>("tabs.list")).tabs ?? [];
          expectTrue(!tabs.some((tab) => tab.key === POPUP), "the pop-up is never listed as a tab");
        } finally {
          await closePopup(POPUP);
        }
      });
    },
  },
  {
    name: "engine extensions: with the page behind in the second pane of a split, a pop-up's lastFocusedWindow, currentWindow and windows.getCurrent all name it",
    run: async () => {
      const ids = await testExtensions();
      await withPages("pane", ids, async (pages) => {
        expectEqual(await act(pages.right, ids.popup, pages.windowId), "popup", "executeExtensionAction on the second pane");
        try {
          await openPopup(POPUP, await popupUrl(pages.right, ids.popup), pages.windowId);
          const seen = await inPage<Behind>(POPUP, "behind()");
          expectEqual(
            { lastFocused: seen?.lastFocused?.url, current: seen?.current?.url, window: seen?.window === seen?.lastFocused?.windowId },
            { lastFocused: pages.rightUrl, current: pages.rightUrl, window: true },
            `what the pop-up sees as its window and active tab ${JSON.stringify(seen)}`,
          );
        } finally {
          await closePopup(POPUP);
        }
      });
    },
  },
  {
    name: "engine extensions: activeTab lets the pop-up run a script in the page behind only after the click",
    run: async () => {
      const ids = await testExtensions();
      await withPages("active-tab", ids, async (pages) => {
        const tabId = await tabIdOf(pages.control, pages.rightUrl);
        const before = await inPage<{ ran?: unknown; refused?: unknown }>(pages.control, `runIn(${tabId})`);
        expectTrue(before && "refused" in before, `before the click, scripting.executeScript on the page is refused (${JSON.stringify(before)})`);
        expectEqual(await act(pages.right, ids.popup, pages.windowId), "popup", "executeExtensionAction");
        try {
          await openPopup(POPUP, await popupUrl(pages.right, ids.popup), pages.windowId);
          expectEqual(await inPage(POPUP, `runIn(${tabId})`), { ran: "loaded b" }, "after the click, the pop-up's scripting.executeScript runs in the page behind");
        } finally {
          await closePopup(POPUP);
        }
      });
    },
  },
  {
    name: "engine extensions: an action without a pop-up fires onClicked for the page behind",
    run: async () => {
      const ids = await testExtensions();
      await withPages("clicked", ids, async (pages) => {
        const tabId = await tabIdOf(pages.clickControl!, pages.rightUrl);
        expectEqual(await act(pages.right, ids.click, pages.windowId), "none", "executeExtensionAction on an action with no pop-up");
        await pause(500);
        expectEqual(await inPage(pages.clickControl!, "clicks()"), [tabId], "action.onClicked fired once, for the page behind");
      });
    },
  },
  {
    name: "engine extensions: a pop-up set for one tab with action.setPopup is the one that opens there",
    run: async () => {
      const ids = await testExtensions();
      await withPages("set-popup", ids, async (pages) => {
        await inPage(pages.control, `setPopup(${await tabIdOf(pages.control, pages.rightUrl)}, "other.html")`);
        const url = await popupUrl(pages.right, ids.popup);
        expectEqual(url, `chrome-extension://${ids.popup}/other.html`, "the action's pop-up for that tab");
        expectEqual(await popupUrl(pages.left, ids.popup), `chrome-extension://${ids.popup}/popup.html`, "the other tab keeps the default pop-up");
        expectEqual(await act(pages.right, ids.popup, pages.windowId), "popup", "executeExtensionAction");
        try {
          await openPopup(POPUP, url, pages.windowId);
          expectEqual(await inPage(POPUP, "document.title"), "self-check other popup", "the tab's own pop-up opened");
        } finally {
          await closePopup(POPUP);
        }
      });
    },
  },
  {
    name: "engine extensions: a click without real input in the last second is refused, and one input grants one click",
    run: async () => {
      const ids = await testExtensions();
      await withPages("input", ids, async (pages) => {
        await pause(1100);
        expectEqual(await act(pages.right, ids.popup, pages.windowId, false), "none", "executeExtensionAction with no recent input");
        await expectRefusedPopup(pages.windowId, await popupUrl(pages.right, ids.popup));
        expectEqual(await act(pages.right, ids.popup, pages.windowId), "popup", "executeExtensionAction right after one input");
        expectEqual(await act(pages.right, ids.popup, pages.windowId, false), "none", "a second click on the same input");
        await hostCall("popup.create", { key: `${POPUP}-unused`, url: "chrome-extension://nothing/popup.html", profile: "" }, pages.windowId).catch(() => null);
      });
    },
  },
];

async function expectRefusedPopup(windowId: string, url: string) {
  const refused = await hostCall("popup.create", { key: `${POPUP}-refused`, url, profile: "" }, windowId).then(
    () => false,
    () => true,
  );
  await closePopup(`${POPUP}-refused`);
  expectTrue(refused, "popup.create with no grant for that window is refused");
}

export const checks: Check[] = port ? popupChecks : [];
