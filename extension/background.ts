/**
 * Background service worker.
 *
 * Handles the extension toolbar-icon click: dispatch a single
 * `VIZ_ACTIVATE` message to the active tab's content script.
 *
 * The content script then acquires audio via `getDisplayMedia` (user
 * picks a tab in Chrome's native picker) — see `content/mount.tsx`.
 * We don't use `chrome.tabCapture` anymore: tabCapture *redirects*
 * the source tab's audio into our stream, and Chrome silences any
 * attempt to play it back from the same tab (to prevent a self-
 * feedback loop). getDisplayMedia *duplicates* tab audio instead,
 * so the source keeps playing normally and we just get a copy for
 * analysis.
 *
 * Service workers in MV3 are ephemeral; we keep no state here.
 */

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;

  // Only meaningful on normal web pages — skip chrome:// / about: etc.
  if (!/^https?:\/\//.test(tab.url)) {
    console.warn('[viz] Cannot activate on non-http(s) page:', tab.url);
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'VIZ_ACTIVATE' });
  } catch (err) {
    console.error('[viz] sendMessage failed:', err);
  }
});
