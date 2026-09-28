/*
 * Tubly - shared download/mux pipeline.
 *
 * Loaded after lib/mp4box.min.js. Used by the offscreen document that
 * performs video+audio merging. Exposes a single global.
 */
var TublyMuxer = (function () {
  // How many consecutive failed attempts are tolerated before giving up.
  const MAX_RETRIES = 8;
  // Parallel (IDM-style) downloader tuning. googlevideo throttles each
  // request individually, so splitting a file into Range fragments and
  // fetching several at once multiplies effective throughput.
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const MAX_CHUNK_RETRIES = 8;
  const HARD_CONCURRENCY = 8; // never exceed: avoids 429s / connection storms
  const PROGRESS_STEP = 262144; // throttle progress events to ~every 256 KB

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Concurrency tier by file size: small files gain nothing from many
  // sockets, large files get more (up to the hard cap).
  function concurrencyFor(total) {
    if (total < 8 * 1024 * 1024) return 2;
    if (total < 40 * 1024 * 1024) return 4;
    if (total < 150 * 1024 * 1024) return 6;
    return HARD_CONCURRENCY;
  }

  function totalFromRange(resp) {
    const cr = resp.headers.get('content-range');
    if (!cr) return 0;
    const m = cr.match(/\/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  // One-byte probe: discovers the total size and whether Range requests
  // (206 + Content-Range) are supported. Returns 0 when unsupported.
  async function probeSize(url) {
    const resp = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    try {
      if (resp.status === 206) return totalFromRange(resp);
    } finally {
      // We don't need the probe byte; release the socket promptly.
      if (resp.body && resp.body.cancel) {
        try { await resp.body.cancel(); } catch (e) { /* ignore */ }
      }
    }
    return 0;
  }

  // Sequential, resume-capable download (fallback and used when Range is
  // unsupported). If the connection drops mid-stream it reconnects with a
  // Range header and resumes from the bytes already received.
  async function downloadSequential(url, onProgress, onRetry) {
    const chunks = [];
    let received = 0;
    let attempt = 0;
    let madeProgress = false;

    for (;;) {
      try {
        const headers = {};
        if (received) headers.Range = 'bytes=' + received + '-';
        const resp = await fetch(url, received ? { headers } : undefined);

        if (resp.status === 416 && received) {
          // Range not satisfiable: we already have the whole file.
          break;
        }
        if (!resp.ok) {
          throw new Error('Stream fetch failed: HTTP ' + resp.status);
        }
        if (received && resp.status === 200) {
          // Server ignored the Range header and restarted from byte 0.
          chunks.length = 0;
          received = 0;
        }

        let total = 0;
        const cr = resp.headers.get('content-range');
        if (cr) {
          const m = cr.match(/\/(\d+)\s*$/);
          if (m) total = parseInt(m[1], 10);
        }
        if (!total) {
          total = received +
            parseInt(resp.headers.get('content-length') || '0', 10);
        }

        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          madeProgress = true;
          if (onProgress) onProgress(received, total);
        }
        if (total && received < total) {
          throw new Error('Connection closed early (' + received + '/' +
            total + ' bytes)');
        }
        break; // finished
      } catch (e) {
        attempt = madeProgress ? 1 : attempt + 1;
        madeProgress = false;
        if (attempt > MAX_RETRIES) throw e;
        if (onRetry) onRetry(attempt, received, e);
        // Back off a little before resuming.
        await sleep(Math.min(15000, 500 * 2 ** (attempt - 1)));
      }
    }

    const all = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      all.set(c, offset);
      offset += c.length;
    }
    return all.buffer;
  }

  // Parallel Range-fragment download. The file is split into fixed-size
  // chunks; a small worker pool pulls and fetches them. Each chunk resumes
  // independently on drops (so a flaky socket only stalls one fragment),
  // and repeated 429/5xx responses shrink the pool automatically.
  async function downloadParallel(url, total, onProgress, onRetry) {
    const chunkList = [];
    for (let start = 0; start < total; start += CHUNK_SIZE) {
      chunkList.push({ start, end: Math.min(start + CHUNK_SIZE, total) - 1 });
    }

    const result = new Uint8Array(total);
    let nextIndex = 0;
    let transferred = 0;
    let lastReported = -PROGRESS_STEP;
    let globalAttempt = 0;
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
      const parts = [];
      let local = 0;
      let attempt = 0;

      for (;;) {
        const from = chunk.start + local;
        try {
          const resp = await fetch(url, {
            headers: { Range: 'bytes=' + from + '-' + chunk.end },
          });
          if (resp.status === 416 && local >= want) break;
          if (!resp.ok) {
            // Server-side throttle/error: ease off globally.
            if (resp.status === 429 || resp.status >= 500) {
              workers = Math.max(2, workers - 1);
            }
            throw new Error('Stream fetch failed: HTTP ' + resp.status);
          }

          const reader = resp.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            local += value.length;
            transferred += value.length;
            report(false);
          }
          if (local < want) {
            throw new Error('Connection closed early (' + local + '/' +
              want + ' bytes)');
          }
          break;
        } catch (e) {
          attempt++;
          globalAttempt++;
          if (attempt > MAX_CHUNK_RETRIES) throw e;
          if (onRetry) onRetry(globalAttempt, transferred, e);
          // Exponential backoff for this fragment.
          await sleep(Math.min(15000, 500 * 2 ** (attempt - 1)));
        }
      }

      // Splice the fragment's pieces into the final buffer at its offset.
      let off = chunk.start;
      for (const p of parts) {
        result.set(p, off);
        off += p.length;
      }
    }

    async function worker(slot) {
      for (;;) {
        // If the pool was downgraded, surplus workers stand down.
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
    report(true); // guarantee a final 100% event
    return result.buffer;
  }

  // Streams a whole URL into an ArrayBuffer; onProgress(received,total).
  // Probes for Range support, then downloads fragments in parallel;
  // falls back to sequential resume if the probe fails or is unsupported.
  async function downloadBuffer(url, onProgress, onRetry) {
    try {
      const total = await probeSize(url);
      if (total > 0) {
        return await downloadParallel(url, total, onProgress, onRetry);
      }
    } catch (e) { /* probe failed: use the resilient sequential path */ }
    return downloadSequential(url, onProgress, onRetry);
  }

  // Parses a single-track DASH MP4 (ftyp/moov/mdat) into the raw trak
  // object (codec configuration) plus all samples with their data.
  function parseStream(arrayBuffer, kind) {
    return new Promise((resolve, reject) => {
      const file = MP4Box.createFile();
      let trak = null;
      let expected = 0;
      const got = [];

      file.onReady = (info) => {
        const list = kind === 'video' ? info.videoTracks : info.audioTracks;
        if (!list.length) {
          reject(new Error('No ' + kind + ' track inside stream'));
          return;
        }
        trak = file.getTrackById(list[0].id);
        expected = list[0].nb_samples;
        file.setExtractionOptions(trak.tkhd.track_id, null,
          { nbSamples: 500 });
        file.start();
      };
      file.onSamples = (id, user, list) => {
        got.push(...list);
        if (got.length >= expected) resolve({ trak, samples: got });
      };

      const buf = arrayBuffer.slice(0);
      buf.fileStart = 0;
      file.appendBuffer(buf);
      // flush(last=true) forces out the final partial batch; all extraction
      // callbacks fire synchronously, so got[] is complete by this point.
      file.flush();

      if (got.length) resolve({ trak, samples: got });
      else reject(new Error('No ' + kind + ' samples could be extracted'));
    });
  }

  // Options for the writer's addTrack(), copied from the source trak.
  function trackOptions(trak, kind) {
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const opt = {
      type: entry.type, // "avc1" or "mp4a"
      timescale: trak.mdia.mdhd.timescale,
      language: trak.mdia.mdhd.languageString || 'und',
      hdlr: kind === 'video' ? 'vide' : 'soun',
      media_duration: trak.samples_duration,
      // Reuse the original avcC / esds box objects directly.
      description_boxes: (entry.boxes || []).slice(),
    };
    if (kind === 'video') {
      opt.width = entry.getWidth();
      opt.height = entry.getHeight();
    } else {
      opt.samplerate = entry.getSampleRate();
      opt.channel_count = entry.getChannelCount();
      opt.samplesize = entry.getSampleSize();
    }
    return opt;
  }

  // Interleaves the two sample streams into one fragmented MP4 and returns
  // the complete file as an ArrayBuffer.
  function muxStreams(vStream, aStream) {
    const out = MP4Box.createFile();
    const vOpt = trackOptions(vStream.trak, 'video');
    const aOpt = trackOptions(aStream.trak, 'audio');
    const vId = out.addTrack(vOpt);
    const aId = out.addTrack(aOpt);

    const vs = vStream.samples;
    const as = aStream.samples;
    let vi = 0;
    let ai = 0;

    while (vi < vs.length || ai < as.length) {
      const v = vs[vi];
      const a = as[ai];
      const takeVideo = !!v && (!a || v.dts / vOpt.timescale <=
        a.dts / aOpt.timescale);
      const s = takeVideo ? v : a;
      out.addSample(takeVideo ? vId : aId, s.data, {
        dts: s.dts,
        cts: s.cts,
        duration: s.duration,
        is_sync: s.is_sync,
        sample_description_index: 1,
      });
      if (takeVideo) vi++; else ai++;
    }

    // The writer leaves movie/track durations at 0; fill them in so the
    // fragmented file reports a correct duration to players.
    const movieTS = 600;
    const vEnd = vs.length
      ? (vs[vs.length - 1].dts + vs[vs.length - 1].duration) / vOpt.timescale
      : 0;
    const aEnd = as.length
      ? (as[as.length - 1].dts + as[as.length - 1].duration) / aOpt.timescale
      : 0;
    out.moov.mvhd.timescale = movieTS;
    out.moov.mvhd.duration = Math.round(Math.max(vEnd, aEnd) * movieTS);
    out.moov.mvhd.volume = 0x0100;
    for (const trak of out.moov.traks) {
      const tkTS = trak.mdia.mdhd.timescale;
      trak.tkhd.duration =
        Math.round(trak.mdia.mdhd.duration / tkTS * movieTS);
    }

    return out.getBuffer();
  }

  return {
    downloadBuffer,
    parseStream,
    trackOptions,
    muxStreams,
  };
})();
