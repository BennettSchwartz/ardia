const tabOf = (tab) => (tab ? { id: tab.id, windowId: tab.windowId, url: tab.url } : null);
globalThis.behind = async () => ({
  lastFocused: tabOf((await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]),
  current: tabOf((await chrome.tabs.query({ active: true, currentWindow: true }))[0]),
  window: (await chrome.windows.getCurrent()).id,
});
globalThis.tabIdOf = async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id ?? null;
globalThis.runIn = (tabId) =>
  chrome.scripting.executeScript({ target: { tabId }, func: () => document.title }).then(
    (results) => ({ ran: results[0]?.result ?? null }),
    (error) => ({ refused: String(error && error.message) }),
  );
globalThis.setPopup = (tabId, popup) => chrome.action.setPopup({ tabId, popup });
globalThis.disableFor = (tabId) => chrome.action.disable(tabId);
globalThis.openTab = (url) => chrome.tabs.create({ url }).then((tab) => tab.id);
globalThis.update = (tabId, url) => chrome.tabs.update(tabId, { url }).then((tab) => tab.id);
