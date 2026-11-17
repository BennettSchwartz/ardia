chrome.action.onClicked.addListener((tab) => {
  chrome.storage.local.get({ clicks: [] }).then(({ clicks }) => chrome.storage.local.set({ clicks: [...clicks, tab.id] }));
});
