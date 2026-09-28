/*
 * Chrunos Downloader - MAIN-world fetch proxy.
 *
 * Injected into the page's MAIN world via chrome.scripting.executeScript
 * (world: 'MAIN').  Listens for fetch requests from the content script
 * (postMessage) and performs the actual fetch from the youtube.com origin
 * so googlevideo accepts the request (content-script fetches carry
 * Origin: chrome-extension://... and are rejected with 403).
 */
(function () {
  if (window.__tublyMainProxyInstalled) return;
  window.__tublyMainProxyInstalled = true;

  window.addEventListener('message', async function (ev) {
    var d = ev.data;
    if (!d || d.source !== 'tubly-fetch-req') return;
    try {
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, d.timeout || 60000);
      var resp = await fetch(d.url, Object.assign({}, d.opts, { signal: ctrl.signal }));
      clearTimeout(t);
      var headers = {};
      if (resp.headers && resp.headers.forEach) {
        resp.headers.forEach(function (v, k) { headers[k.toLowerCase()] = v; });
      }
      var blob = await resp.blob();
      ev.source.postMessage({
        source: 'tubly-main-fetch',
        id: d.id,
        payload: { status: resp.status, ok: resp.ok, headers: headers, blob: blob },
      }, '*');
    } catch (err) {
      ev.source.postMessage({
        source: 'tubly-main-fetch',
        id: d.id,
        error: String(err && err.message || err),
      }, '*');
    }
  });
})();
