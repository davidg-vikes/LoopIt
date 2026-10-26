// LoopIt background service worker (MV3)
chrome.runtime.onInstalled.addListener(() => {
  // Nothing needed here for now
});

// Open side panel when the action icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    await chrome.sidePanel.setOptions({ windowId: tab.windowId, path: 'index.html', enabled: true });
  } catch (e) {
    // ignore
  }
});
