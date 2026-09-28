/*
 * Chrunos Downloader - background service worker.
 *
 * TUBLY_DOWNLOAD: save a progressive (muxed) URL through chrome.downloads.
 * INJECT_MAIN_PROXY: inject a fetch proxy into the page's MAIN world
 *   (bypasses YouTube's CSP that blocks inline <script> tags).  The proxy
 *   fetches media URLs from the youtube.com origin so googlevideo accepts
 *   them (content-script fetches carry Origin: chrome-extension://... and
 *   are rejected with 403).
 *
 * SET_DNR_UA: set the User-Agent header for googlevideo requests (used to
 *   match the client that signed the URL — ANDROID or IOS).  We also strip
 *   the Origin header so requests look like they come from a native app
 *   rather than a browser extension.
 */

// Static rule: strip browser-identifying headers from all googlevideo
// requests so they look like they come from a native app, not a browser.
const STRIP_HEADERS_RULE = {
  id: 1,
  priority: 1,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [
      { header: 'origin', operation: 'remove' },
      { header: 'referer', operation: 'remove' },
      { header: 'sec-fetch-site', operation: 'remove' },
      { header: 'sec-fetch-mode', operation: 'remove' },
      { header: 'sec-fetch-dest', operation: 'remove' },
      { header: 'sec-fetch-user', operation: 'remove' },
      { header: 'sec-ch-ua', operation: 'remove' },
      { header: 'sec-ch-ua-mobile', operation: 'remove' },
      { header: 'sec-ch-ua-platform', operation: 'remove' },
      { header: 'sec-ch-ua-full-version', operation: 'remove' },
      { header: 'sec-ch-ua-full-version-list', operation: 'remove' },
      { header: 'sec-ch-ua-platform-version', operation: 'remove' },
      { header: 'sec-ch-ua-arch', operation: 'remove' },
      { header: 'sec-ch-ua-model', operation: 'remove' },
    ],
  },
  condition: {
    urlFilter: '||googlevideo.com/',
  },
};

// Dynamic rule (session-scoped): sets the User-Agent to the client that
// signed the current URL.  Replaced on each SET_DNR_UA message.
let uaRuleId = 2;

chrome.runtime.onInstalled.addListener(() => {
  ensureStripOriginRule();
});

// Also set the strip-origin rule on startup (onInstalled only fires once).
ensureStripOriginRule();

function ensureStripOriginRule() {
  chrome.declarativeNetRequest.getSessionRules((rules) => {
    const exists = rules.some((r) => r.id === STRIP_HEADERS_RULE.id);
    if (!exists) {
      chrome.declarativeNetRequest.updateSessionRules({
        addRules: [STRIP_HEADERS_RULE],
      });
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === 'TUBLY_DOWNLOAD') {
    try {
      chrome.downloads.download(
        {
          url: message.url,
          filename: message.filename || 'Chrunos/video.mp4',
          conflictAction: 'uniquify',
          saveAs: false,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({
              success: false,
              error: chrome.runtime.lastError.message,
            });
          } else {
            sendResponse({ success: true, downloadId });
          }
        }
      );
    } catch (e) {
      sendResponse({ success: false, error: String(e && e.message || e) });
    }
    return true; // async response
  }

  if (message.type === 'SET_DNR_UA') {
    const ua = message.ua;
    // Remove any existing UA rule first.
    chrome.declarativeNetRequest.updateSessionRules(
      { removeRuleIds: [uaRuleId] },
      () => {
        if (!ua) {
          // Null UA = remove the rule (use default browser UA for WEB URLs).
          sendResponse({ success: true });
          return;
        }
        chrome.declarativeNetRequest.updateSessionRules(
          {
            addRules: [{
              id: uaRuleId,
              priority: 2,
              action: {
                type: 'modifyHeaders',
                requestHeaders: [
                  { header: 'user-agent', operation: 'set', value: ua },
                ],
              },
              condition: {
                urlFilter: '||googlevideo.com/',
              },
            }],
          },
          () => {
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse({ success: true });
            }
          }
        );
      }
    );
    return true; // async response
  }

  if (message.type === 'INJECT_MAIN_PROXY') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'No sender tab' });
      return;
    }
    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: 'MAIN',
        files: ['src/main-proxy.js'],
      },
      () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true });
        }
      }
    );
    return true; // async response
  }
});
