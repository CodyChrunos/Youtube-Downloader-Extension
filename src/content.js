/*
 * Tubly Downloader - content script
 *
 * Runs on youtube.com. Extracts the player response (which contains the
 * video title, duration, channel and the streaming URLs), deciphers signed
 * URLs with the same player JS the page loaded, and hands the final URL to
 * the background service worker, which saves it via chrome.downloads.
 */
(() => {
  'use strict';

  if (window.__tublyContentLoaded) return;
  window.__tublyContentLoaded = true;

  // ---------------------------------------------------------------------------
  // Generic source scanner: walks { [ ( ) ] } while skipping strings,
  // template literals, comments and regex literals.
  // ---------------------------------------------------------------------------
  function skipString(src, i) {
    const quote = src[i];
    i++;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) return i + 1;
      // Opaque template: inner ${...} is treated as string content.
      i++;
    }
    return i;
  }

  function skipRegex(src, i) {
    i++; // opening /
    let inClass = false;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        i++;
        while (i < src.length && /[a-z]/i.test(src[i])) i++; // flags
        return i;
      }
      i++;
    }
    return i;
  }

  function isRegexContext(src, i) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (j < 0) return true;
    const c = src[j];
    return !( /[\w$)\]]/.test(c) );
  }

  // Returns the index just past the bracket closing the one opened at openIdx.
  function balancedEnd(src, openIdx) {
    const open = src[openIdx];
    const close = open === '{' ? '}' : open === '[' ? ']' : ')';
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === '`') { i = skipString(src, i) - 1; continue; }
      if (ch === '/' && src[i + 1] === '/') {
        i += 2;
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        i = src.indexOf('*/', i + 2);
        if (i === -1) return -1;
        i += 1;
        continue;
      }
      if (ch === '/' && isRegexContext(src, i)) { i = skipRegex(src, i) - 1; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }

  // Extracts "{ ... }" that starts at (or shortly after) marker index.
  function extractJsonObject(text, fromIdx) {
    const open = text.indexOf('{', fromIdx);
    if (open === -1) return null;
    const end = balancedEnd(text, open);
    if (end === -1) return null;
    const raw = text.slice(open, end);
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  // ---------------------------------------------------------------------------
  // Page / player response helpers
  // ---------------------------------------------------------------------------
  function currentVideoId() {
    const u = location.href;
    let m = u.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    m = u.match(/(?:shorts|embed|v)\/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  // fetch() with an AbortController timeout so a hung request can never
  // stall the UI indefinitely.
  function fetchWithTimeout(url, opts, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
      .finally(() => clearTimeout(timer));
  }

  async function fetchPageHtml() {
    // Refetching the current URL yields a fresh ytInitialPlayerResponse,
    // which keeps info correct after YouTube's in-page SPA navigation.
    try {
      const r = await fetchWithTimeout(location.href, {
        credentials: 'include',
        headers: { 'Accept': 'text/html' },
      }, 10000);
      if (r.ok) return await r.text();
    } catch (e) { /* fall through */ }
    return document.documentElement.outerHTML;
  }

  function playerResponseFromHtml(html, expectedId) {
    const MARKER = 'ytInitialPlayerResponse';
    let idx = html.indexOf(MARKER);
    while (idx !== -1) {
      const eq = html.indexOf('=', idx + MARKER.length);
      if (eq === -1 || eq - (idx + MARKER.length) > 5) break;
      const obj = extractJsonObject(html, eq);
      if (obj && obj.videoDetails) {
        if (!expectedId || obj.videoDetails.videoId === expectedId) return obj;
      }
      idx = html.indexOf(MARKER, idx + 1);
    }
    return null;
  }

  function findInnertubeKey(html) {
    const m = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    return m ? m[1] : null;
  }

  // Clients whose streams YouTube serves as plain, already-signed URLs
  // without needing the WEB player's signature decipher.
  // NOTE: ANDROID/IOS URLs are signed for the mobile apps and are REJECTED
  // by googlevideo when fetched from a browser (even youtube.com origin).
  // The WEB client returns signatureCipher URLs that are browser-compatible.
  const API_CLIENTS = [
    { clientName: 'ANDROID', clientVersion: '20.10.38',
      androidSdkVersion: 35, osName: 'Android', osVersion: '15',
      ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 15) gzip' },
    { clientName: 'IOS', clientVersion: '20.10.4',
      deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.0.22D63',
      ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_0 like Mac OS X)' },
    { clientName: 'WEB', clientVersion: '2.20240101.00.00' },
  ];

  async function fetchApiPlayerResponse(videoId, client) {
    let html = document.documentElement.outerHTML;
    let apiKey = findInnertubeKey(html);
    if (!apiKey) {
      html = await fetchPageHtml();
      apiKey = findInnertubeKey(html);
    }
    if (!apiKey) throw new Error('InnerTube API key not found');

    const visitorMatch = html.match(/"INNERTUBE_VISITOR_DATA":"([^"]+)"/);

    const payload = {
      context: {
        client: {
          clientName: client.clientName,
          clientVersion: client.clientVersion,
          hl: 'en',
          gl: 'US',
          ...(client.androidSdkVersion
            ? { androidSdkVersion: client.androidSdkVersion } : {}),
          ...(client.deviceModel ? { deviceModel: client.deviceModel } : {}),
          osName: client.osName,
          osVersion: client.osVersion,
          ...(visitorMatch ? { visitorData: visitorMatch[1] } : {}),
        },
      },
      videoId,
      playbackContext: {
        contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' },
      },
      racyCheckOk: true,
      contentCheckOk: true,
    };

    const r = await fetchWithTimeout(
      'https://www.youtube.com/youtubei/v1/player?key=' + apiKey +
        '&prettyPrint=false',
      { method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) }, 15000);
    if (!r.ok) throw new Error('InnerTube player request failed: HTTP ' + r.status);
    return r.json();
  }

  // Tries mobile clients first (direct URLs), then the page-embedded
  // WEB player response as a fallback.  Returns the primary player
  // response plus a `webPr` fallback whose signatureCipher URLs are
  // definitely page-context compatible (used when mobile URLs 403).
  async function getPlayerResponse() {
    const id = currentVideoId();
    if (!id) throw new Error('No video ID in the current URL');

    const html = await fetchPageHtml();
    // WEB response from page HTML (signatureCipher URLs, browser-compatible).
    let webPr = playerResponseFromHtml(html, id);

    let primary = null;
    for (const client of API_CLIENTS) {
      try {
        const pr = await fetchApiPlayerResponse(id, client);
        if (pr && pr.videoDetails && pr.streamingData) {
          if (client.clientName === 'WEB') {
            // WEB client: use as both primary (format list) and webPr (URLs).
            if (!webPr || !webPr.streamingData) webPr = pr;
            if (!primary) primary = { pr, source: client.clientName.toLowerCase(),
              ua: client.ua };
          } else if (!primary) {
            primary = { pr, source: client.clientName.toLowerCase(), ua: client.ua };
          }
          // ANDROID/IOS give us the format list; we already have webPr for URLs.
          if (primary && (webPr && webPr.streamingData)) break;
        }
      } catch (e) { /* try next client */ }
    }

    if (primary) {
      const result = { pr: primary.pr, id, source: primary.source,
        ua: primary.ua, html };
      if (webPr && webPr.streamingData) result.webPr = webPr;
      return result;
    }

    if (webPr && webPr.streamingData) {
      return { pr: webPr, id, source: 'web', html };
    }
    throw new Error('Could not read any downloadable player response');
  }

  function findPlayerJsUrl(html) {
    let m = html.match(/"PLAYER_JS_URL"\s*:\s*"([^"]+)"/);
    if (!m) m = html.match(/"jsUrl"\s*:\s*"(?:https?:)?(\/[^"]+?base\.js)"/);
    return m ? new URL(m[1], location.origin).href : null;
  }

  // ---------------------------------------------------------------------------
  // Player JS analysis (signature decipher + n-parameter throttling bypass)
  // ---------------------------------------------------------------------------
  const BUILTINS = new Set([
    'parseInt', 'parseFloat', 'isNaN', 'String', 'Number', 'Boolean', 'Array',
    'Object', 'Math', 'JSON', 'Date', 'RegExp', 'Error', 'Map', 'Set',
    'Promise', 'Symbol', 'WeakMap', 'WeakSet', 'ArrayBuffer', 'Uint8Array',
    'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
    'Float32Array', 'Float64Array', 'DataView', 'TextEncoder', 'TextDecoder',
    'Function', 'Reflect', 'encodeURIComponent', 'decodeURIComponent',
    'encodeURI', 'decodeURI', 'escape', 'unescape', 'window', 'document',
    'globalThis', 'console', 'setTimeout', 'setInterval', 'clearTimeout',
    'clearInterval', 'atob', 'btoa', 'URL', 'URLSearchParams', 'Promise',
  ]);

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findFunctionSource(src, name) {
    const n = escapeRe(name);
    let m = src.match(new RegExp(
      '(?:^|[^\\w$])(?:(var|let|const)\\s+)?' + n + '\\s*=\\s*function'));
    let at;
    if (m) {
      at = m[1] ? src.indexOf(m[1], m.index)
        : m.index + (/[\w$]/.test(m[0][0]) ? 0 : 1);
    } else {
      m = src.match(new RegExp('function\\s+' + n + '\\s*\\('));
      if (!m) return null;
      at = m.index;
    }
    const brace = src.indexOf('{', m.index + m[0].length);
    const end = balancedEnd(src, brace);
    if (end === -1) return null;
    return src.slice(at, end);
  }

  function findObjectSource(src, name) {
    const n = escapeRe(name);
    const m = src.match(new RegExp(
      '(?:[;{}\\s]|^)(?:var\\s+|let\\s+|const\\s+)?' + n + '\\s*=\\s*\\{'));
    if (!m) return null;
    const open = src.indexOf('{', m.index);
    const end = balancedEnd(src, open);
    if (end === -1) return null;
    const decl = m[0].match(/\b(var|let|const)\s*$/);
    const prefix = decl ? decl[0] + ' ' : 'var ';
    return prefix + src.slice(src.indexOf(n, m.index), end);
  }

  function findHolderMethods(src, holder) {
    const n = escapeRe(holder);
    const re = new RegExp(
      '(?:^|[^\\w$])' + n + '\\.([A-Za-z_$][\\w$]*)\\s*=\\s*function', 'g');
    const out = [];
    let m;
    while ((m = re.exec(src))) {
      const fnIdx = src.indexOf('function', m.index);
      const brace = src.indexOf('{', fnIdx);
      const end = balancedEnd(src, brace);
      if (end !== -1) {
        out.push(m[1] + '=function' + src.slice(fnIdx + 8, end));
      }
    }
    return out;
  }

  // Names referenced by a piece of code: object members, bare calls, `new`.
  function referencedNames(code) {
    const names = new Set();
    let m;
    const re1 = /([A-Za-z_$][\w$]{1,})\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g;
    while ((m = re1.exec(code))) names.add(m[1]);
    const re2 = /(?<![\w$.])([A-Za-z_$][\w$]{1,})\s*\(/g;
    while ((m = re2.exec(code))) names.add(m[1]);
    const re3 = /new\s+([A-Za-z_$][\w$]{1,})/g;
    while ((m = re3.exec(code))) names.add(m[1]);
    return names;
  }

  class PlayerEngine {
    constructor(src) {
      this.src = src;
      this.runners = new Map();
      this.sigName = this.findSigName();
      this.nCandidates = this.findNCandidates();
    }

    findSigName() {
      const anchors = [
        /\b[cse]\s*&&\s*\(?\s*[a-z]\.set\([^,)]*,?\s*([A-Za-z0-9$]{2,})\s*\(/,
        /\bc\s*&&\s*\(\s*([A-Za-z0-9$]{2,})\s*\(\s*decodeURIComponent\(\w+\.s\)\s*\)/,
        /\bm\s*=\s*([A-Za-z0-9$]{2,})\s*\(\s*decodeURIComponent\(\w+\.s\)\s*\)/,
        /\.sig\)\)\s*\|\|\s*([A-Za-z0-9$]{2,})\s*\(/,
        /\.sig\|\|\s*([A-Za-z0-9$]{2,})\s*\(/,
        /akamaized\.net\/\)\s*\|\|\s*([A-Za-z0-9$]{2,})\s*\(/,
      ];
      for (const re of anchors) {
        const m = this.src.match(re);
        if (m) return m[1];
      }
      return null;
    }

    findNCandidates() {
      const names = [];
      const seen = new Set();
      const patterns = [
        /(?:^|[^\w$.])([A-Za-z0-9$]{2,})\s*=\s*function\s*\(\s*([A-Za-z0-9$]+)\s*\)\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/g,
        /(?:^|[^\w$])function\s+([A-Za-z0-9$]{2,})\s*\(\s*([A-Za-z0-9$]+)\s*\)\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/g,
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(this.src))) {
          if (m[1] !== this.sigName && !seen.has(m[1])) {
            seen.add(m[1]);
            names.push(m[1]);
          }
        }
      }
      return names;
    }

    // Builds a runnable Function for one of the player's top-level functions,
    // pulling in every object / helper it references.
    buildRunner(name) {
      const src = this.src;
      const fnSrc = findFunctionSource(src, name);
      if (!fnSrc) return null;

      const externals = new Map();   // other top-level name/method -> source
      const selfMethods = new Map(); // method name -> "x=function..."
      let pool = fnSrc;

      for (let round = 0; round < 6; round++) {
        let added = false;
        for (const ref of referencedNames(pool)) {
          if (BUILTINS.has(ref)) continue;

          // Holder-method assignments (the holder is often this fn itself).
          for (const mm of findHolderMethods(src, ref)) {
            let bucket, key;
            if (ref === name) {
              bucket = selfMethods;
              key = mm;
              if (!bucket.has(key)) { bucket.set(key, mm); added = true; }
            } else {
              bucket = externals;
              key = ref + '.' + mm;
              if (!bucket.has(key)) {
                bucket.set(key, ref + '=' + ref + '||{};' + ref + '.' + mm);
                added = true;
              }
            }
          }

          if (ref === name || externals.has(ref)) continue;

          const objSrc = findObjectSource(src, ref);
          if (objSrc) {
            externals.set(ref, objSrc);
            added = true;
            continue;
          }
          const fn2 = findFunctionSource(src, ref);
          if (fn2) {
            externals.set(ref, fn2);
            added = true;
          }
        }
        if (!added) break;
        pool = fnSrc
          + [...externals.values()].join('')
          + [...selfMethods.values()].map(m => name + '.' + m).join('');
      }

      const code =
        [...externals.values()].map(s => ';' + s + ';').join('') +
        ';' + fnSrc + ';' +
        (selfMethods.size
          ? name + '=' + name + '||{};'
            + [...selfMethods.values()].map(m => name + '.' + m).join(';') + ';'
          : '') +
        'return ' + name + '(__INPUT__);';

      try {
        // eslint-disable-next-line no-new-func
        return new Function('__INPUT__', code);
      } catch (e) {
        return null;
      }
    }

    getRunner(name) {
      if (!this.runners.has(name)) this.runners.set(name, this.buildRunner(name));
      return this.runners.get(name);
    }

    decipher(signature) {
      if (!this.sigName) throw new Error('Signature function not found in player');
      const runner = this.getRunner(this.sigName);
      if (!runner) throw new Error('Could not build signature function');
      return runner(signature);
    }

    // Tries every candidate; the real one returns the same charset and
    // roughly the same length as its input.
    transformN(n) {
      for (const cand of this.nCandidates) {
        try {
          const runner = this.getRunner(cand);
          if (!runner) continue;
          const out = runner(n);
          if (typeof out === 'string' && /^[A-Za-z0-9_-]+$/.test(out)
              && Math.abs(out.length - n.length) <= 2) {
            return out;
          }
        } catch (e) { /* try next candidate */ }
      }
      return null;
    }
  }

  const engineCache = new Map();

  async function getEngine(html) {
    const jsUrl = findPlayerJsUrl(html);
    if (!jsUrl) throw new Error('Player JS URL not found');
    if (engineCache.has(jsUrl)) return engineCache.get(jsUrl);

    const resp = await fetchWithTimeout(jsUrl, { credentials: 'omit' }, 15000);
    if (!resp.ok) throw new Error('Failed to fetch player JS: HTTP ' + resp.status);
    const code = await resp.text();
    const engine = new PlayerEngine(code);
    engineCache.set(jsUrl, engine);
    return engine;
  }

  // ---------------------------------------------------------------------------
  // URL resolution
  // ---------------------------------------------------------------------------
  // asyncGetEngine is invoked lazily: only signed formats or an `n`
  // parameter require analyzing YouTube's player JS.
  async function resolveFinalUrl(format, asyncGetEngine, skipNTransform) {
    let url;
    const cipher = format.signatureCipher || format.cipher;
    // WEB client URLs in signatureCipher can be relative (//host or /path);
    // resolve against the page origin so new URL() doesn't throw.
    const base = location.origin || 'https://www.youtube.com';

    if (cipher) {
      const params = new URLSearchParams(cipher);
      url = params.get('url');
      const s = params.get('s');
      const sp = params.get('sp') || 'signature';
      if (!url || !s) throw new Error('Malformed signature cipher');
      const engine = await asyncGetEngine();
      const sig = engine.decipher(s);
      url = new URL(url, base);
      url.searchParams.set(sp, sig);
    } else {
      url = new URL(format.url, base);
    }

    const n = url.searchParams.get('n');
    if (n && !skipNTransform) {
      try {
        const engine = await asyncGetEngine();
        const nn = engine.transformN(n);
        if (nn) url.searchParams.set('n', nn);
      } catch (e) {
        // Engine unavailable (player JS fetch failed).  Some videos still
        // serve with the original n; better to try than to abort.
      }
    }
    return url.toString();
  }

  // ---------------------------------------------------------------------------
  // Quality list building
  // ---------------------------------------------------------------------------
  function humanSize(bytes) {
    if (!bytes || bytes < 0) return '—';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return mb.toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function estimateSize(bitrate, seconds) {
    if (!bitrate || !seconds) return '—';
    return humanSize((bitrate / 8) * seconds);
  }

  function sanitizeFilename(name) {
    return (name || 'video')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video';
  }

  function formatSize(f, seconds) {
    if (f.contentLength) return humanSize(parseInt(f.contentLength, 10));
    return estimateSize(f.bitrate || f.bitRate || f.averageBitrate, seconds);
  }

  // Numeric byte count (contentLength when known, bitrate estimate else).
  function numericSize(f, seconds) {
    if (f.contentLength) return parseInt(f.contentLength, 10);
    return Math.round((f.bitrate || f.bitRate || f.averageBitrate || 0) *
      seconds / 8);
  }

  function buildVideoInfo(pr) {
    const details = pr.videoDetails;
    const streaming = pr.streamingData || {};
    const seconds = parseInt(details.lengthSeconds, 10);

    const formatMap = new Map(); // key type:itag -> format
    const videoQualities = [];
    const audioQualities = [];

    // Progressive (muxed) formats: video + audio in a single file.
    for (const f of (streaming.formats || [])) {
      const key = 'video:' + f.itag;
      f.__tublyMuxed = true; // distinguish from adaptive video-only streams
      formatMap.set(key, f);
      videoQualities.push({
        id: key,
        kind: 'muxed',
        label: 'MP4 ' + (f.qualityLabel || f.quality || '') + ' (video + audio)',
        height: f.height || 0,
        fileSize: formatSize(f, seconds),
      });
    }

    // Audio-only streams first (needed to size the merged options).
    // YouTube often ships multiple itags at the same codec + bitrate
    // (multi-language tracks, alternate servers). Collapse duplicates so
    // the panel shows one option per codec+kbps, keeping the largest.
    const audioDedup = new Map(); // isMp4:kbps -> { f, size }
    for (const f of (streaming.adaptiveFormats || [])) {
      const mime = f.mimeType || '';
      if (!/^audio\//.test(mime)) continue;
      const isMp4 = /mp4/.test(mime);
      const kbps = Math.round((f.bitRate || f.averageBitrate || 0) / 1000);
      const size = parseInt(f.contentLength, 10) || 0;
      const dedupKey = isMp4 + ':' + kbps;
      const prev = audioDedup.get(dedupKey);
      if (!prev || size > prev.size) audioDedup.set(dedupKey, { f, isMp4, kbps, size });
    }
    for (const { f, isMp4, kbps } of audioDedup.values()) {
      const key = 'audio:' + f.itag;
      formatMap.set(key, f);
      audioQualities.push({
        id: key,
        label: (isMp4 ? 'M4A' : 'Opus') + (kbps ? ' ' + kbps + ' kbps' : ''),
        kbps,
        fileSize: formatSize(f, seconds),
        ext: isMp4 ? 'm4a' : 'weba',
      });
    }
    const bestAudio = pickM4aFormat(formatMap);
    const audioExtra = bestAudio ? numericSize(bestAudio, seconds) : 0;

    // Adaptive video formats come in several itags per quality (e.g. 30fps
    // and 60fps variants of 1080p). Group by height and keep the highest-
    // bitrate itag, then offer two variants per quality:
    //   - merged with the best AAC audio (default download)
    //   - the truly raw video-only stream
    const bestByHeight = new Map();
    for (const f of (streaming.adaptiveFormats || [])) {
      const mime = f.mimeType || '';
      if (!/^video\//.test(mime) || !/mp4/.test(mime)) continue;
      const height = f.height ||
        parseInt(f.qualityLabel, 10) || 0;
      const rate = parseInt(f.contentLength, 10) ||
        f.bitrate || f.bitRate || 0;
      const prev = bestByHeight.get(height);
      if (!prev || rate > prev.rate) bestByHeight.set(height, { f, rate });
    }
    for (const [height, { f }] of [...bestByHeight].sort((a, b) => b[0] - a[0])) {
      const qLabel = f.qualityLabel || (height ? height + 'p' : '?');
      formatMap.set('video:' + f.itag, f);
      formatMap.set('vonly:' + f.itag, f);
      videoQualities.push({
        id: 'video:' + f.itag,
        kind: 'merged',
        label: 'MP4 ' + qLabel + ' (video + audio)',
        height,
        muxed: false,
        fileSize: humanSize(numericSize(f, seconds) + audioExtra),
      });
      videoQualities.push({
        id: 'vonly:' + f.itag,
        kind: 'video-only',
        label: 'MP4 ' + qLabel + ' (video only)',
        height,
        muxed: false,
        fileSize: formatSize(f, seconds),
      });
    }

    // Complete files first (muxed, then merged-on-download), then the raw
    // video-only streams; each group tallest first. Audio: best kbps first.
    const kindOrder = { muxed: 0, merged: 1, 'video-only': 2 };
    videoQualities.sort((a, b) =>
      kindOrder[a.kind] - kindOrder[b.kind] || b.height - a.height);
    audioQualities.sort((a, b) => b.kbps - a.kbps);

    const thumbs = details.thumbnail && details.thumbnail.thumbnails;
    const thumbnail = (thumbs && thumbs.length ? thumbs[thumbs.length - 1].url : null)
      || ('https://i.ytimg.com/vi/' + details.videoId + '/hqdefault.jpg');

    const info = {
      id: details.videoId,
      title: details.title,
      duration: seconds,
      channelName: details.author,
      thumbnail,
      videoQualities,
      audioQualities,
    };
    return { info, formatMap, seconds };
  }

  // ---------------------------------------------------------------------------
  // Message handlers (protocol expected by src/popup.js)
  // ---------------------------------------------------------------------------
  let currentMap = new Map();
  let lastContext = null; // { pr, source, html, id } from the last info load

  async function handleGetVideoInfo() {
    const ctx = await getPlayerResponse();
    const built = buildVideoInfo(ctx.pr);
    currentMap = built.formatMap;
    lastContext = ctx;
    return { videoInfo: built.info };
  }

  // ---------------------------------------------------------------------------
  // MAIN-world fetch proxy.
  //
  // Content scripts fetch with Origin: chrome-extension://<id>, which
  // googlevideo rejects with 403.  We inject a tiny script into the page's
  // MAIN world (Origin: https://www.youtube.com) and route media fetches
  // through it via postMessage.  The proxy returns the full response blob
  // (structured-clone supports Blob with no size limit).
  // ---------------------------------------------------------------------------
  let mainProxyReady = false;
  let mainProxySeq = 0;
  const mainProxyPending = new Map(); // id -> {resolve, reject}

  // The MAIN-world fetch proxy (src/main-proxy.js) is injected automatically
  // via the manifest's content_scripts with world:"MAIN" at document_start,
  // so it's always present before this content script runs.  Here we just
  // set up the reply listener.
  function ensureMainProxy() {
    if (mainProxyReady) return;
    mainProxyReady = true;

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.source !== 'tubly-main-fetch') return;
      const entry = mainProxyPending.get(d.id);
      if (!entry) return;
      mainProxyPending.delete(d.id);
      if (d.error) entry.reject(new Error(d.error));
      else entry.resolve(d.payload);
    });
  }

  // Fetches from the page's MAIN world (youtube.com origin).  Returns
  // { status, ok, headers, blob }.  Always fetches the full body as a blob
  // (no streaming) which is fine for our chunked range requests.
  function mainWorldFetch(url, opts, timeoutMs) {
    ensureMainProxy();
    return new Promise((resolve, reject) => {
      const id = ++mainProxySeq;
      mainProxyPending.set(id, { resolve, reject });
      window.postMessage({
        source: 'tubly-fetch-req', id,
        url, opts: opts || {}, timeout: timeoutMs || 60000,
      }, '*');
      // Safety timeout in case the proxy never replies.
      setTimeout(() => {
        if (mainProxyPending.has(id)) {
          mainProxyPending.delete(id);
          reject(new Error('Main-world fetch proxy timeout'));
        }
      }, (timeoutMs || 60000) + 5000);
    });
  }

  // ---------------------------------------------------------------------------
  // In-page parallel stream downloader.
  //
  // Media requests are made HERE in the content script (origin youtube.com,
  // page cookies attached) rather than from an extension page: googlevideo
  // deterministically rejects real-Chrome fetches from extension origins
  // with 403, while the trusted page context is exactly what YouTube's own
  // player uses. Each stream is split into Range fragments fetched by a
  // small worker pool (googlevideo throttles per request), with independent
  // fragment resume.
  // ---------------------------------------------------------------------------
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const MAX_CHUNK_RETRIES = 8;
  const HARD_CONCURRENCY = 8;
  const PROGRESS_STEP = 262144;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function concurrencyFor(total) {
    if (total < 8 * 1024 * 1024) return 2;
    if (total < 40 * 1024 * 1024) return 4;
    if (total < 150 * 1024 * 1024) return 6;
    return HARD_CONCURRENCY;
  }

  // Returns true if the response content-type is HTML (error page) rather
  // than media.  YouTube sometimes returns 200 with an HTML "error" page
  // instead of a proper 403, so we can't rely on status code alone.
  function isHtmlResponse(resp) {
    const ct = (resp.headers && resp.headers['content-type']) || '';
    return /text\/html|application\/xhtml/i.test(ct);
  }

  // Probes Range support and total size from the page context. Returns 0
  // when the server responds 200 / no Content-Range.
  async function probeStream(url) {
    const resp = await mainWorldFetch(url, {
      credentials: 'include',
      headers: { Range: 'bytes=0-0' },
    }, 15000);
    if (!resp.ok || isHtmlResponse(resp)) {
      throw new Error('Stream fetch failed: HTTP ' + resp.status +
        (isHtmlResponse(resp) ? ' (HTML error page)' : ''));
    }
    if (resp.status === 206) {
      const cr = resp.headers['content-range'];
      const m = cr && cr.match(/\/(\d+)\s*$/);
      if (m) return parseInt(m[1], 10);
    }
    return 0;
  }

  // Full-stream download with fragment resume; onProgress(received,total),
  // throttled. Returns the complete Blob.
  async function downloadStream(url, mime, onProgress) {
    ensureMainProxy();
    const total = await probeStream(url);

    // Range unsupported: one GET (best effort).
    if (!total) {
      const resp = await mainWorldFetch(url, { credentials: 'include' }, 30000);
      if (!resp.ok || isHtmlResponse(resp)) {
        throw new Error('Stream fetch failed: HTTP ' + resp.status +
          (isHtmlResponse(resp) ? ' (HTML error page)' : ''));
      }
      return resp.blob;
    }

    const chunkList = [];
    for (let start = 0; start < total; start += CHUNK_SIZE) {
      chunkList.push({ start, end: Math.min(start + CHUNK_SIZE, total) - 1 });
    }

    const result = new Uint8Array(total);
    let nextIndex = 0;
    let transferred = 0;
    let lastReported = -PROGRESS_STEP;
    let workers = concurrencyFor(total);

    function report(force) {
      if (onProgress && (force ||
          transferred - lastReported >= PROGRESS_STEP)) {
        lastReported = transferred;
        onProgress(transferred, total);
      }
    }

    async function fetchChunk(ci) {
      const chunk = chunkList[ci];
      const want = chunk.end - chunk.start + 1;
      let attempt = 0;

      for (;;) {
        try {
          const resp = await mainWorldFetch(url, {
            credentials: 'include',
            headers: { Range: 'bytes=' + chunk.start + '-' + chunk.end },
          }, 60000);
          if (resp.status === 416) break;
          if (!resp.ok || isHtmlResponse(resp)) {
            if (resp.status === 429 || resp.status >= 500) {
              workers = Math.max(2, workers - 1);
            }
            throw new Error('Stream fetch failed: HTTP ' + resp.status +
              (isHtmlResponse(resp) ? ' (HTML error page)' : ''));
          }

          const buf = await resp.blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          if (bytes.length < want) {
            throw new Error('Connection closed early (' + bytes.length +
              '/' + want + ' bytes)');
          }
          result.set(bytes, chunk.start);
          transferred += bytes.length;
          report(false);
          break;
        } catch (e) {
          attempt++;
          if (attempt > MAX_CHUNK_RETRIES) throw e;
          await sleep(Math.min(15000, 500 * 2 ** (attempt - 1)));
        }
      }
    }

    async function worker(slot) {
      for (;;) {
        if (slot > workers) return;
        const ci = nextIndex++;
        if (ci >= chunkList.length) return;
        await fetchChunk(ci);
      }
    }

    const promises = [];
    for (let slot = 1; slot <= workers; slot++) {
      promises.push(worker(slot));
    }
    await Promise.all(promises);
    report(true);
    return new Blob([result], { type: mime });
  }

  // Finds the same itag in the WEB player response (signatureCipher URLs
  // that are page-context compatible).  Returns null if not found.
  function findWebFormat(ctxRef, itag) {
    if (!ctxRef.webPr || !ctxRef.webPr.streamingData) return null;
    const all = (ctxRef.webPr.streamingData.formats || [])
      .concat(ctxRef.webPr.streamingData.adaptiveFormats || []);
    return all.find(f => f.itag === itag) || null;
  }

  // Sets the User-Agent that googlevideo sees (via DNR) to match the
  // client that signed the URL.  ANDROID URLs need the ANDROID app UA;
  // otherwise googlevideo rejects them.
  let lastDnrUa = null;
  async function setDnrUa(ua) {
    if (ua === lastDnrUa) return;
    lastDnrUa = ua;
    try {
      await chrome.runtime.sendMessage({ type: 'SET_DNR_UA', ua });
      // Give the DNR rule a moment to take effect.
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) { /* best effort */ }
  }

  // Resolves a format URL and downloads it, retrying on 403/HTML error
  // pages with progressively different strategies:
  //   1. original mobile URL (no n-transform) + matching UA via DNR
  //   2. n-transformed mobile URL
  //   3. WEB client URL (signatureCipher — browser-compatible fallback)
  //   4. fresh player response + original URL
  // Returns the complete Blob.
  async function fetchStreamBlob(format, ctxRef, mime, note, opts) {
    opts = opts || {};
    const label = opts.label || '';
    const onProgress = opts.onProgress; // (recv, tot) => void
    const attempts = [
      { skipN: true,  refresh: false, useWeb: false, ua: null },          // browser UA
      { skipN: true,  refresh: false, useWeb: false, ua: 'client' },      // Android UA
      { skipN: false, refresh: false, useWeb: false, ua: 'client' },
      { skipN: false, refresh: false, useWeb: true,  ua: null },          // WEB + browser UA
      { skipN: true,  refresh: true,  useWeb: false, ua: null },
    ];
    let lastErr;
    for (let i = 0; i < attempts.length; i++) {
      const { skipN, refresh, useWeb, ua } = attempts[i];
      let fmt = format;
      if (refresh) {
        note('Refreshing stream URL…', 0);
        const fresh = await getPlayerResponse();
        Object.assign(ctxRef, fresh);
      }
      if (useWeb) {
        const webFmt = findWebFormat(ctxRef, format.itag);
        if (webFmt) {
          fmt = webFmt;
        } else {
          // No matching itag in WEB response — skip this attempt.
          continue;
        }
      }
      // Set the UA.  chrome.downloads works with the browser's default UA,
      // so we try that first.  'client' means the URL-signing client's UA.
      const resolvedUa = ua === 'client' ? (ctxRef.ua || null) : null;
      await setDnrUa(resolvedUa);

      const url = await resolveDownloadUrl(fmt, ctxRef, skipN);
      try {
        return await downloadStream(url, mime, (recv, tot) => {
          if (onProgress) onProgress(recv, tot);
          if (label) {
            const pct = tot ? Math.round(recv / tot * 100) : 0;
            note(label + pct + '%', pct);
          }
        });
      } catch (e) {
        lastErr = e;
        // Retry on 403 or HTML error pages (YouTube returns 200+HTML
        // instead of a proper 403 for some rejected URLs).
        const isRejected = /HTTP 403|HTML error page/.test(e.message);
        if (!isRejected) throw e;
        if (i < attempts.length - 1) {
          note('URL rejected — trying alternative…', 0);
        }
      }
    }
    throw lastErr;
  }

  // ---------------------------------------------------------------------------
  // Bridge iframe: extension page that receives finished Blobs, merges video
  // + audio and saves via chrome.downloads. Frame postMessage has no size
  // limit (the 64 MB cap applies only to chrome.runtime.sendMessage).
  // ---------------------------------------------------------------------------
  let bridgeFrame = null;
  let bridgeLoaded = false;
  let bridgeJobSeq = 0;
  const bridgeJobs = new Map(); // jobId -> {resolve, reject, note}

  function ensureBridge() {
    if (bridgeFrame && bridgeFrame.isConnected) return;
    bridgeLoaded = false;
    bridgeFrame = document.createElement('iframe');
    bridgeFrame.setAttribute('aria-hidden', 'true');
    bridgeFrame.style.cssText =
      'display:none!important;width:0;height:0;border:0;position:absolute';
    bridgeFrame.addEventListener('load', () => { bridgeLoaded = true; });
    bridgeFrame.src = chrome.runtime.getURL('bridge.html');
    document.body.appendChild(bridgeFrame);
  }

  function whenBridgeLoaded() {
    if (bridgeLoaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (!bridgeFrame) { reject(new Error('bridge missing')); return; }
      const timer = setTimeout(() => reject(new Error('Bridge timed out')), 30000);
      bridgeFrame.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  function sendToBridge(job, note) {
    return new Promise((resolve, reject) => {
      bridgeJobs.set(job.jobId, { resolve, reject, note });
      bridgeFrame.contentWindow.postMessage(
        { source: 'chrunos-page', type: 'BRIDGE_RUN', ...job }, '*');
    });
  }

  // Replies from the bridge. Trust is established by message SOURCE (the
  // known bridge window), not origin alone — works regardless of scheme.
  window.addEventListener('message', (event) => {
    if (!bridgeFrame || event.source !== bridgeFrame.contentWindow) return;
    const msg = event.data;
    if (!msg || msg.source !== 'chrunos-bridge') return;
    const j = bridgeJobs.get(msg.jobId);
    if (!j) return;

    if (msg.type === 'BRIDGE_STATUS') {
      if (j.note && msg.text) j.note(msg.text);
    } else if (msg.type === 'BRIDGE_DONE') {
      bridgeJobs.delete(msg.jobId);
      if (msg.success) j.resolve({ success: true });
      else j.reject(new Error(msg.error || 'Bridge failed'));
    }
  });

  function pickM4aFormat(formatMap) {
    let best = null;
    for (const [key, f] of formatMap) {
      if (!/^audio:/.test(key) || !/mp4/.test(f.mimeType || '')) continue;
      if (f.itag === 140) return f;
      const rate = f.bitRate || f.averageBitrate || 0;
      if (!best || rate > (best.bitRate || best.averageBitrate || 0)) best = f;
    }
    return best;
  }

  async function resolveDownloadUrl(format, ctx, skipNTransform) {
    // Fast path: plain URL with no n-transform needed.  Return directly
    // — calling fetchPageHtml()/new URL() here adds a network round-trip
    // that can interfere with the session and trigger 403s.
    if (format.url && skipNTransform) return format.url;
    if (!ctx.html) ctx.html = await fetchPageHtml();
    let enginePromise = null;
    const getEngineLazy = () => {
      if (!enginePromise) enginePromise = getEngine(ctx.html);
      return enginePromise;
    };
    return resolveFinalUrl(format, getEngineLazy, skipNTransform);
  }

  async function handleDownload(message) {
    const note = message.onStatus || function () {};

    if (!chrome.runtime || !chrome.runtime.id) {
      throw new Error(
        'Extension was reloaded — please refresh this YouTube tab and try again');
    }

    // Always fetch a fresh player response: its signed URLs expire after a
    // few hours; a cached context produces "file wasn't available" errors.
    const ctx = await getPlayerResponse();
    lastContext = ctx;
    const built = buildVideoInfo(ctx.pr);
    currentMap = built.formatMap;
    const { info } = built;

    const format = currentMap.get(message.qualityId);
    if (!format) return { success: false, error: 'Selected format no longer available' };

    const isAudio = message.type === 'audio';
    const isAdaptiveVideo = !isAudio
      && /^video\//.test(format.mimeType || '')
      && !format.__tublyMuxed;
    // "vonly:" ids download the raw video stream without merging audio.
    const rawVideoOnly = isAdaptiveVideo && message.qualityId.startsWith('vonly:');

    // Everything except progressive muxed streams is fetched from the
    // trusted page context (parallel Range fragments), then the finished
    // Blobs are posted to the bridge iframe for merging + saving.
    if (isAdaptiveVideo || isAudio) {
      const base = sanitizeFilename(info.title);
      const newJobId = () => 'job-' + (++bridgeJobSeq) + '-' + Date.now();

      ensureBridge();

      let job;
      if (isAudio) {
        const picked = info.audioQualities.find(q => q.id === message.qualityId);
        const ext = (picked && picked.ext) || 'm4a';
        const mime = /webm/.test(format.mimeType || '')
          ? 'audio/webm' : 'audio/mp4';
        note('Downloading audio…', 0);
        const blob = await fetchStreamBlob(
          format, ctx, mime, note, { label: 'Downloading audio ' });
        job = { jobId: newJobId(), kind: 'audio-only',
          filename: 'Chrunos/' + base + '.' + ext, audio: blob };
      } else if (rawVideoOnly) {
        note('Downloading video stream…', 0);
        const blob = await fetchStreamBlob(
          format, ctx, 'video/mp4', note, { label: 'Downloading video ' });
        job = { jobId: newJobId(), kind: 'video-only',
          filename: 'Chrunos/' + base + ' (video only).mp4', video: blob };
      } else {
        const audioFormat = pickM4aFormat(built.formatMap);

        note('Downloading video + audio…', 0);
        // Combined progress across both streams, weighted by byte totals.
        let vRecv = 0, aRecv = 0, vTot = 1, aTot = 1;
        const push = () => {
          const pct = Math.round((vRecv + aRecv) / (vTot + aTot) * 100);
          note('Downloading video + audio ' + pct + '%', pct);
        };
        const [vBlob, aBlob] = await Promise.all([
          fetchStreamBlob(format, ctx, 'video/mp4', note, {
            onProgress: (r, t) => { vRecv = r; vTot = t || 1; push(); },
          }),
          audioFormat
            ? fetchStreamBlob(audioFormat, ctx, 'audio/mp4', note, {
                onProgress: (r, t) => { aRecv = r; aTot = t || 1; push(); },
              })
            : Promise.resolve(null),
        ]);
        job = {
          jobId: newJobId(),
          kind: aBlob ? 'merge' : 'video-only',
          filename: 'Chrunos/' + base + '.mp4',
          video: vBlob,
        };
        if (aBlob) job.audio = aBlob;
      }

      await whenBridgeLoaded();
      await sendToBridge(job, note);
      return { success: true };
    }

    // Progressive muxed files: hand the URL to the browser's download
    // manager immediately (this is the one path that always works there).
    const url = await resolveDownloadUrl(format, ctx);
    const filename = 'Chrunos/' + sanitizeFilename(info.title) + '.mp4';

    const direct = await chrome.runtime.sendMessage({
      type: 'TUBLY_DOWNLOAD',
      url,
      filename,
    });
    if (direct && direct.success) return { success: true };
    return {
      success: false,
      error: (direct && direct.error) || 'Browser downloader refused the file',
    };
  }

  // ---------------------------------------------------------------------------
  // In-page Download button + quality panel (injected into YouTube UI)
  // ---------------------------------------------------------------------------
  let pageHost = null;
  let pagePanel = null;
  let retryTimer = null;

  function makeEl(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function makeDownloadIcon() {
    // Built via SVG DOM (no innerHTML) so CSP / Trusted Types can't block it.
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M12 3v10.6m0 0l-3.8-3.8M12 13.6l3.8-3.8M5 19.5h14');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  // Ensures the panel's prominent progress bar exists (inserted right above
  // the status line), shows it reset to 0%, and returns set()/hide() handles.
  function ensureProgressBar() {
    if (!pagePanel) return null;
    let bar = pagePanel.querySelector('.tubly-progress');
    const status = pagePanel.querySelector('.tubly-status');
    const area = pagePanel.querySelector('.tubly-status-area');
    if (!bar) {
      // Fallback: create the bar inline before the status.
      bar = makeEl('div', 'tubly-progress');
      bar.appendChild(makeEl('div', 'tubly-progress-fill'));
      if (status && status.parentElement) {
        status.parentElement.insertBefore(bar, status);
      }
    }
    if (!bar) return null;
    if (area) area.classList.remove('hidden');
    bar.classList.remove('hidden');
    const fill = bar.querySelector('.tubly-progress-fill');
    if (fill) fill.style.width = '0%';
    return {
      set(pct) {
        if (fill) {
          fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
        }
      },
      // Only hide the bar; the status area (with the text) stays visible
      // so the user still sees "Saved" / error messages afterwards.
      hide() { bar.classList.add('hidden'); },
    };
  }

  function addQualityRow(container, q, type) {
    const btn = makeEl('button', 'tubly-qbtn',
      q.label + '  (' + q.fileSize + ')');
    btn.setAttribute('type', 'button');
    btn.addEventListener('click', async () => {
      const status = pagePanel.querySelector('.tubly-status');
      status.textContent = 'Preparing download…';
      status.className = 'tubly-status';
      const bar = ensureProgressBar();
      try {
        const r = await handleDownload({
          qualityId: q.id,
          type,
          onStatus: (text, pct) => {
            status.textContent = text;
            status.className = 'tubly-status';
            if (bar && typeof pct === 'number') bar.set(pct);
          },
        });
        if (bar) bar.hide();
        if (r && r.success) {
          status.textContent = 'Saved — check your downloads folder';
          status.classList.add('ok');
        } else {
          status.textContent = (r && r.error) || 'Download failed';
          status.classList.add('err');
        }
      } catch (e) {
        if (bar) bar.hide();
        status.textContent = String(e && e.message || e);
        status.classList.add('err');
      }
    });
    container.appendChild(btn);
  }

  async function populatePanel(panel) {
    if (panel.dataset.loaded) return;
    panel.dataset.loaded = '1';

    const body = makeEl('div', 'tubly-panel-body');
    panel.appendChild(body);

    // Prominent status area pinned to the TOP of the panel: progress bar
    // above the status text.  It's hidden until a download starts.
    const statusArea = makeEl('div', 'tubly-status-area hidden');
    const bar = makeEl('div', 'tubly-progress');
    bar.appendChild(makeEl('div', 'tubly-progress-fill'));
    statusArea.appendChild(bar);
    statusArea.appendChild(makeEl('div', 'tubly-status'));
    body.appendChild(statusArea);

    const loading = makeEl('div', 'tubly-loading', 'Reading formats…');
    body.appendChild(loading);

    try {
      // Also refreshes currentMap, which handleDownload relies on.
      const r = await handleGetVideoInfo();
      const info = r.videoInfo;
      body.removeChild(loading);

      if (info.videoQualities.length) {
        body.appendChild(makeEl('div', 'tubly-h', 'Video'));
        const grid = makeEl('div', 'tubly-qgrid');
        info.videoQualities.forEach(q => addQualityRow(grid, q, 'video'));
        body.appendChild(grid);
      }
      if (info.audioQualities.length) {
        body.appendChild(makeEl('div', 'tubly-h', 'Audio'));
        const grid = makeEl('div', 'tubly-qgrid');
        info.audioQualities.forEach(q => addQualityRow(grid, q, 'audio'));
        body.appendChild(grid);
      }
      if (!info.videoQualities.length && !info.audioQualities.length) {
        body.appendChild(makeEl('div', 'tubly-empty',
          'No downloadable formats were offered for this video.'));
      }
    } catch (e) {
      loading.textContent = 'Could not read formats: ' + String(e && e.message || e);
    }
  }

  function removePageHost() {
    if (pageHost) {
      pageHost.remove();
      pageHost = null;
    }
    if (pagePanel) {
      pagePanel.remove();
      pagePanel = null;
    }
  }

  // Anchors the panel (fixed-position, attached to document.body) under
  // the Download button. It must live outside YouTube's button row: rows
  // like #top-level-buttons-computed clip absolutely-positioned children.
  function positionPanel() {
    if (!pagePanel || !pageHost) return;
    const button = pageHost.querySelector('.tubly-dl-btn');
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const shorts = pageHost.classList.contains('tubly-host--shorts');
    pagePanel.style.top = Math.round(rect.bottom + 8) + 'px';
    pagePanel.style.left = 'auto';
    pagePanel.style.right = Math.round(shorts
      ? window.innerWidth - rect.left + 8
      : window.innerWidth - rect.right) + 'px';
  }

  function isShortsPage() {
    return /^\/shorts\//.test(location.pathname);
  }

  function findActionContainer() {
    // Standard watch page: sit directly in the row that holds the
    // Subscribe / like / share buttons so the pill lines up inline.
    const row = document.querySelector('#top-level-buttons-computed');
    if (row) return { container: row, variant: 'watch' };
    // Fallback for alternate layouts: the wrapping actions bar.
    const inner = document.querySelector('#actions-inner');
    if (inner) return { container: inner, variant: 'watch' };
    // Shorts: right-hand vertical action rail.
    if (isShortsPage()) {
      const actions = document.querySelector('ytd-shorts #actions');
      return actions ? { container: actions, variant: 'shorts' } : null;
    }
    return null;
  }

  function injectPageUI() {
    // Only inject on video pages.
    if (!currentVideoId() && !isShortsPage()) {
      removePageHost();
      return;
    }

    const found = findActionContainer();
    if (!found) {
      // YouTube renders the action bar a moment after navigation.
      clearTimeout(retryTimer);
      retryTimer = setTimeout(injectPageUI, 500);
      return;
    }
    if (pageHost && pageHost.isConnected
        && pageHost.parentElement === found.container) {
      return; // already in place
    }

    removePageHost();

    pageHost = makeEl('div',
      'tubly-host' + (found.variant === 'shorts' ? ' tubly-host--shorts' : ''));

    const button = makeEl('button', 'tubly-dl-btn');
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', 'Download with Chrunos');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(makeDownloadIcon());
    button.appendChild(makeEl('span', null, 'Download'));

    // The panel is attached to document.body and positioned with fixed
    // coordinates (see positionPanel) so YouTube's layout can't clip it.
    pagePanel = makeEl('div', 'tubly-panel hidden');
    document.body.appendChild(pagePanel);

    button.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const willOpen = pagePanel.classList.contains('hidden');
      pagePanel.classList.toggle('hidden');
      button.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) {
        positionPanel();
        populatePanel(pagePanel);
      }
    });

    pageHost.appendChild(button);
    // Insert as the first child so the pill sits before Like/Share and
    // doesn't push existing buttons to wrap onto a second line.
    if (found.container.firstChild) {
      found.container.insertBefore(pageHost, found.container.firstChild);
    } else {
      found.container.appendChild(pageHost);
    }
  }

  // Close the panel when clicking anywhere outside (registered once).
  document.addEventListener('mousedown', (ev) => {
    const insideButton = pageHost && pageHost.contains(ev.target);
    const insidePanel = pagePanel && pagePanel.contains(ev.target);
    if (!insideButton && !insidePanel &&
        pagePanel && !pagePanel.classList.contains('hidden')) {
      pagePanel.classList.add('hidden');
      const button = pageHost && pageHost.querySelector('.tubly-dl-btn');
      if (button) button.setAttribute('aria-expanded', 'false');
    }
  });

  // YouTube is an SPA: re-inject after in-page navigations.
  document.addEventListener('yt-navigate-finish', () => {
    removePageHost();
    injectPageUI();
  });

  // Safety net in case YouTube re-renders the action bar.
  setInterval(() => {
    if (currentVideoId() && (!pageHost || !pageHost.isConnected)) {
      injectPageUI();
    }
  }, 3000);

  injectPageUI();

  // ---------------------------------------------------------------------------
  // Message handlers (protocol expected by src/popup.js)
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return;

    if (message.action === 'getVideoInfo') {
      handleGetVideoInfo()
        .then(sendResponse)
        .catch(e => sendResponse({ error: String(e.message || e) }));
      return true; // async response
    }

    if (message.action === 'downloadVideo') {
      handleDownload(message)
        .then(sendResponse)
        .catch(e => sendResponse({ success: false, error: String(e.message || e) }));
      return true;
    }
  });
})();
