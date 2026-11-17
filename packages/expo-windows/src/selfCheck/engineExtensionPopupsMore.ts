import { hostCall, onEngineTopic } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { firstWindow, LEFT, listed, pause, show, until } from "./engineSleep";
import { act, allowPrivate, closePopup, heardFrom, inPage, LOAD_MS, openPopup, origin, popupUrl, port, removeTestExtensions, setEnabled, tabIdOf, testExtensions, withPages } from "./engineExtensionKit";

const POPUP = "self-check-ext-popup-more";
const PRIVATE = "incognito:self-check-extensions@";

const moreChecks: Check[] = [
  {
    name: "engine extensions: an action disabled for the tab does nothing: no pop-up, no onClicked, no activeTab",
    run: async () => {
      const ids = await testExtensions();
      await withPages("disabled", ids, async (pages) => {
        const tabId = await tabIdOf(pages.control, pages.rightUrl);
        await inPage(pages.control, `disableFor(${tabId})`);
        await inPage(pages.clickControl!, `disableFor(${tabId})`);
        const clicksBefore = await inPage<number[]>(pages.clickControl!, "clicks()");
        expectEqual(await act(pages.right, ids.popup, pages.windowId), "none", "executeExtensionAction on a disabled pop-up action");
        expectEqual(await act(pages.right, ids.click, pages.windowId), "none", "executeExtensionAction on a disabled onClicked action");
        await pause(500);
        expectEqual(await inPage(pages.clickControl!, "clicks()"), clicksBefore, "no onClicked fired");
        const refused = await hostCall("popup.create", { key: POPUP, url: `chrome-extension://${ids.popup}/popup.html`, profile: "" }, pages.windowId).then(
          () => false,
          () => true,
        );
        await closePopup(POPUP);
        expectTrue(refused, "no pop-up can be made");
        const ran = await inPage<{ refused?: unknown }>(pages.control, `runIn(${tabId})`);
        expectTrue(ran && "refused" in ran, `no activeTab was granted (${JSON.stringify(ran)})`);
      });
    },
  },
  {
    name: "engine extensions: on a chrome:// page the pop-up opens, and its script injection into that page is refused",
    run: async () => {
      const ids = await testExtensions();
      await withPages(
        "chrome-page",
        ids,
        async (pages) => {
          expectEqual(await act(pages.right, ids.popup, pages.windowId), "popup", "executeExtensionAction on chrome://version");
          try {
            await openPopup(POPUP, await popupUrl(pages.right, ids.popup), pages.windowId);
            const ran = await inPage<{ refused?: unknown }>(POPUP, `runIn(${await tabIdOf(pages.control, pages.rightUrl)})`);
            expectTrue(ran && "refused" in ran, `scripting.executeScript into chrome://version is refused (${JSON.stringify(ran)})`);
          } finally {
            await closePopup(POPUP);
          }
        },
        "chrome://version/",
      );
    },
  },
  {
    name: "engine extensions: a pop-up closes on window.close() and when its extension is turned off",
    run: async () => {
      const ids = await testExtensions();
      await withPages("closing", ids, async (pages) => {
        try {
          expectEqual(await act(pages.right, ids.popup, pages.windowId), "popup", "executeExtensionAction");
          await openPopup(POPUP, await popupUrl(pages.right, ids.popup), pages.windowId);
          const closed = heardFrom(POPUP, "windowClose");
          await inPage(POPUP, "(setTimeout(() => window.close(), 0), true)");
          expectTrue(await closed, "window.close() in the pop-up tells the app windowClose");
          await closePopup(POPUP);
          expectEqual(await act(pages.right, ids.popup, pages.windowId), "popup", "executeExtensionAction again");
          await openPopup(POPUP, await popupUrl(pages.right, ids.popup), pages.windowId);
          const off = heardFrom(POPUP, "windowClose");
          await setEnabled(ids.popup, false);
          expectTrue(await off, "turning the extension off closes its pop-up");
        } finally {
          await closePopup(POPUP);
          await setEnabled(ids.popup, true).catch(() => null);
        }
      });
    },
  },
  {
    name: "engine extensions: a tab the pop-up opens comes to the app window and the pop-up closes, and tabs.update reaches the page behind",
    run: async () => {
      const ids = await testExtensions();
      await withPages("open-tab", ids, async (pages) => {
        try {
          expectEqual(await act(pages.right, ids.popup, pages.windowId), "popup", "executeExtensionAction");
          await openPopup(POPUP, await popupUrl(pages.right, ids.popup), pages.windowId);
          const tabId = await tabIdOf(pages.control, pages.rightUrl);
          await inPage(POPUP, `update(${tabId}, ${JSON.stringify(`${origin}/a?updated`)})`);
          await until("tabs.update from the pop-up navigates the page behind", LOAD_MS, () => listed(pages.right), (tab) => String(tab?.url).endsWith("/a?updated"));
          const opened = new Promise<{ url?: unknown; adopt?: unknown; parent?: unknown } | null>((resolve) => {
            const watching = onEngineTopic("tab.opened", (event: { url?: unknown; adopt?: unknown; parent?: unknown }) => {
              const url = String(event.url ?? "");
              if (url && !url.includes("/b?from-popup")) return;
              watching.remove();
              resolve(event);
            });
            setTimeout(() => (watching.remove(), resolve(null)), LOAD_MS);
          });
          const closed = heardFrom(POPUP, "windowClose");
          await inPage(POPUP, `openTab(${JSON.stringify(`${origin}/b?from-popup`)})`);
          const tab = await opened;
          expectTrue(tab && tab.parent !== "0", `chrome.tabs.create from the pop-up is offered to the app window (${JSON.stringify(tab)})`);
          if (typeof tab?.adopt === "string") await hostCall("tab.discard", { adopt: tab.adopt }).catch(() => null);
          expectTrue(await closed, "the pop-up closes once it opened a tab");
        } finally {
          await closePopup(POPUP);
        }
      });
    },
  },
  {
    name: "engine extensions: on a private page an extension not allowed there answers none, and once allowed it opens its pop-up",
    run: async () => {
      const ids = await testExtensions();
      const windowId = await firstWindow();
      const key = "self-check-ext-private";
      try {
        await hostCall("tab.create", { key, url: `${origin}/b?private`, profile: PRIVATE }, windowId);
        await until(`the page ${key} loads`, LOAD_MS, () => listed(key), (tab) => tab?.loading === false);
        await show(key, windowId, LEFT);
        expectEqual(await act(key, ids.popup, windowId), "none", "an extension not allowed in private windows, on a private page");
        await allowPrivate(ids.popup, true);
        await pause(1000);
        expectEqual(await act(key, ids.popup, windowId), "popup", "the same extension once allowed in private windows");
        try {
          await openPopup(POPUP, await popupUrl(key, ids.popup), windowId);
        } finally {
          await closePopup(POPUP);
        }
      } finally {
        await hostCall("tab.close", { key }).catch(() => null);
        await hostCall("profile.release", { profile: PRIVATE }).catch(() => null);
        await removeTestExtensions();
      }
    },
  },
];

export const checks: Check[] = port ? moreChecks : [];
