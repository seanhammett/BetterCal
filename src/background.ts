// Clicking the toolbar icon opens (or focuses) the calendar tab.
//
// The existing tab is found with runtime.getContexts, which only ever sees this
// extension's own pages — deliberately, instead of tabs.query({ url }), which
// would need the "tabs" permission and so make Chrome warn at install that
// nonstop can "read your browsing history". It cannot, and shouldn't ask to.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("calendar.html");
  const [existing] = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.TAB],
    documentUrls: [url],
  });

  if (existing && existing.tabId >= 0) {
    await chrome.tabs.update(existing.tabId, { active: true });
    if (existing.windowId >= 0) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url });
  }
});
