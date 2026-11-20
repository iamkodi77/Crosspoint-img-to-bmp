/**
 * Service worker: opens the studio, and turns "right-click an image → send to
 * CrossPoint Studio" into a URL the studio can pick up.
 */
const STUDIO_URL = chrome.runtime.getURL('studio.html');
const TAB_KEY = 'studioTabId';

/**
 * Focus the studio tab if it is still open, otherwise create it. The tab id is
 * remembered in session storage because `tabs.query({url})` would need the
 * broad "tabs" permission, and the extension deliberately does not ask for it.
 */
async function openStudio(query = '') {
  const url = STUDIO_URL + query;
  const stored = await chrome.storage.session.get(TAB_KEY).catch(() => ({}));
  const existingId = stored?.[TAB_KEY];
  if (typeof existingId === 'number') {
    try {
      await chrome.tabs.update(existingId, { active: true, url });
      const tab = await chrome.tabs.get(existingId);
      await chrome.windows.update(tab.windowId, { focused: true });
      return existingId;
    } catch {
      // The tab was closed — fall through and make a new one.
    }
  }
  const tab = await chrome.tabs.create({ url });
  if (tab?.id !== undefined) {
    await chrome.storage.session.set({ [TAB_KEY]: tab.id }).catch(() => {});
  }
  return tab.id;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'cp-image',
      title: 'Convert for CrossPoint (X3 / X4 / X4 Pro)',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: 'cp-studio',
      title: 'Open CrossPoint Studio',
      contexts: ['action', 'page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'cp-image' && info.srcUrl) {
    await openStudio(`?src=${encodeURIComponent(info.srcUrl)}`);
  } else if (info.menuItemId === 'cp-studio') {
    await openStudio();
  }
});

chrome.action.onClicked.addListener(async () => {
  // Only fires when the popup is unavailable; normally the popup handles it.
  await openStudio();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-studio') openStudio();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'open-studio') {
    openStudio(typeof message.query === 'string' ? message.query : '')
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
