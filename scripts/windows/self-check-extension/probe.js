const tabOf = (tab) => ({ id: tab.id, windowId: tab.windowId, active: tab.active, url: tab.url });
globalThis.extensionWindows = async () => {
  const windows = await chrome.windows.getAll({ populate: true });
  const current = await chrome.windows.getCurrent({ populate: true });
  const self = await chrome.tabs.getCurrent();
  return {
    self: self ? tabOf(self) : null,
    windows: windows.map((each) => ({ id: each.id, type: each.type, focused: each.focused, tabs: each.tabs.map(tabOf) })),
    current: { id: current.id, tabs: current.tabs.map(tabOf) },
    activeInCurrent: (await chrome.tabs.query({ active: true, currentWindow: true })).map(tabOf),
    activeInLastFocused: (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).map(tabOf),
  };
};
