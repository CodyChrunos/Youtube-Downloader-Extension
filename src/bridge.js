/*
 * Chrunos - bridge document.
 *
 * This extension page is loaded as a hidden iframe inside the YouTube tab.
 * The content script fetches the (large) media streams from the page's
 * youtube.com origin (the context googlevideo trusts) and posts the Blobs
 * here via window.postMessage — frame messages have no 64 MB limit, and
 * postMessaged Blobs are structured-cloned so this document owns its copy.
 *
 * Unlike the offscreen document, a normal extension page has the full
 * chrome.* API surface, so we can merge video + audio with MP4Box and save
 * directly through chrome.downloads without any user gesture.
 */
(() => {
  'use strict';

  const BRIDGE_ORIGIN = location.origin; // chrome-extension://<id>

  function postParent(message) {
    if (window.parent) window.parent.postMessage(message, '*');
  }

  function reply(jobId, patch) {
    postParent({ source: 'chrunos-bridge', jobId, ...patch });
  }

  // Normal extension pages have chrome.downloads — the offscreen document
  // did not, which is why saveBlob failed there with "reading 'download'".
  //
  // We wait for the download to actually reach `complete` (or `interrupted`)
  // via chrome.downloads.onChanged before resolving.  Resolving on the
  // download() callback alone is too eager — that fires when the download
  // is *initiated*, and blob: URLs from an iframe can be silently rejected
  // by the network layer, leaving the user with "Saved" but no file.
  function saveBlob(blob, filename) {
    // Fallback path: if chrome.downloads isn't available in this context
    // (e.g. the page was somehow treated as a content context), fall back
    // to an <a download> click which triggers a standard browser download.
    if (typeof chrome === 'undefined' || !chrome.downloads) {
      return saveBlobViaAnchor(blob, filename);
    }
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      let settled = false;
      let targetId = null;

      const cleanup = () => {
        chrome.downloads.onChanged.removeListener(onChanged);
        // Keep the blob URL alive for a while in case Chrome re-reads it.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      };
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onChanged = (delta) => {
        if (targetId === null || delta.id !== targetId || !delta.state) return;
        if (delta.state.current === 'complete') {
          finish(() => resolve(targetId));
        } else if (delta.state.current === 'interrupted') {
          const reason = (delta.error && delta.error.current)
            || 'Download interrupted';
          finish(() => reject(new Error(reason)));
        }
      };

      chrome.downloads.onChanged.addListener(onChanged);
      chrome.downloads.download({
        url: objectUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      }, (id) => {
        if (chrome.runtime.lastError) {
          finish(() => reject(
            new Error(chrome.runtime.lastError.message)));
          return;
        }
        targetId = id;
      });
    });
  }

  // Fallback saver: programmatic <a download> click. Works in any context
  // that can create DOM elements, regardless of chrome.* availability.
  function saveBlobViaAnchor(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    return Promise.resolve();
  }

  async function runJob(job) {
    const kind = job.kind;

    if (kind === 'merge') {
      reply(job.jobId, { type: 'BRIDGE_STATUS', text: 'Merging video + audio…' });
      const [vBuf, aBuf] = await Promise.all([
        job.video.arrayBuffer(),
        job.audio.arrayBuffer(),
      ]);
      const [vStream, aStream] = await Promise.all([
        TublyMuxer.parseStream(vBuf, 'video'),
        TublyMuxer.parseStream(aBuf, 'audio'),
      ]);
      const merged = TublyMuxer.muxStreams(vStream, aStream);
      reply(job.jobId, { type: 'BRIDGE_STATUS', text: 'Saving to downloads…' });
      await saveBlob(
        new Blob([merged], { type: 'video/mp4' }), job.filename);
      return;
    }

    if (kind === 'video-only') {
      reply(job.jobId, { type: 'BRIDGE_STATUS', text: 'Saving to downloads…' });
      await saveBlob(job.video, job.filename);
      return;
    }

    if (kind === 'audio-only') {
      reply(job.jobId, { type: 'BRIDGE_STATUS', text: 'Saving to downloads…' });
      await saveBlob(job.audio, job.filename);
      return;
    }

    throw new Error('Unknown job kind: ' + kind);
  }

  window.addEventListener('message', (event) => {
    // Only accept work from our embedding frame; Blobs in the message are
    // clones owned by this document regardless.
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.source !== 'chrunos-page' || msg.type !== 'BRIDGE_RUN') {
      return;
    }

    (async () => {
      try {
        await runJob(msg);
        reply(msg.jobId, { type: 'BRIDGE_DONE', success: true });
      } catch (e) {
        reply(msg.jobId, {
          type: 'BRIDGE_DONE',
          success: false,
          error: String(e && e.message || e),
        });
      }
    })();
  });

  // Tell the content script the bridge is ready (it also waits on load).
  postParent({ source: 'chrunos-bridge', type: 'BRIDGE_READY', origin: BRIDGE_ORIGIN });
})();
