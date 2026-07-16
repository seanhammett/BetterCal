// Clicking the toolbar icon opens (or focuses) the calendar tab.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("calendar.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url });
  }
});
