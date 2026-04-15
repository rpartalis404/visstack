/**
 * Background service worker.
 *
 * Handles the extension toolbar-icon click:
 *   1. Requests a `streamId` for the current tab via chrome.tabCapture.
 *      This does NOT show Chrome's screen-share banner — tabCapture uses
 *      the extension's install-time permission model instead.
 *   2. Sends the streamId to the content script (already loaded on every
 *      page via manifest.content_scripts) so it can build a MediaStream
 *      and feed the audio to our AudioEngine.
 *
 * Service workers in MV3 are ephemeral — any state is transient. We pass
 * the streamId explicitly through messaging rather than relying on any
 * worker-local storage.
 */

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;

  // Only meaningful on normal web pages — skip chrome:// / about: etc.
  if (!/^https?:\/\//.test(tab.url)) {
    console.warn(
      '[Soundstack] Cannot capture audio from non-http(s) page:',
      tab.url,
    );
    return;
  }

  let streamId: string;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });
  } catch (err) {
    console.error('[Soundstack] getMediaStreamId failed:', err);
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'SOUNDSTACK_ACTIVATE',
      streamId,
    });
  } catch (err) {
    console.error('[Soundstack] sendMessage failed:', err);
  }
});
