globalThis.clicks = () => chrome.storage.local.get({ clicks: [] }).then(({ clicks }) => clicks);
globalThis.tabIdOf = async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id ?? null;
globalThis.disableFor = (tabId) => chrome.action.disable(tabId);
