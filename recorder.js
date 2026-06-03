/* recorder.js — Snapshot-based session recorder (v2, html2canvas + JPEG).
 *
 * Replaces the earlier rrweb DOM-mutation recorder, which kept producing
 * "Node not found" errors at replay time on this site's animated content.
 *
 * How it works:
 *   - After consent, loads html2canvas from CDN.
 *   - Every SNAPSHOT_INTERVAL_MS, renders the current viewport to a
 *     canvas, converts to JPEG (quality JPEG_QUALITY), and POSTs the
 *     base64-encoded JPEG to the recorder Apps Script.
 *   - Tracks mouse position + scroll continuously; each snapshot
 *     payload includes the current values so the replay can draw a
 *     cursor dot and show the page at the right scroll position.
 *   - Also snapshots on every click (so we never miss a moment of
 *     interaction even between scheduled snapshots).
 *
 * Privacy / safety:
 *   - Only runs after the visitor agrees to the consent banner.
 *   - Skipped on localhost, when DNT is set, or when the visitor sets
 *     localStorage.session_recording_opt_out = '1'.
 *   - Never breaks the page on failure (every async path is try/catch'd
 *     and silent if the upload fails).
 *
 * Bandwidth budget for a typical 60s session:
 *   - 12 snapshots (every 5s) × ~150 KB JPEG = ~1.8 MB
 *   - Plus ~2 KB of events (mouse/scroll/click metadata)
 */
(function(){
  'use strict';

  // ===== CONFIGURATION ====================================================

  // Apps Script URL — must accept the new {type:'snapshot'|'events'|'meta'}
  // payload shape (see apps-script-recorder.gs). This is the v2 deployment;
  // the old v1 URL is now retired.
  var RECORDER_ENDPOINT = 'https://script.google.com/macros/s/AKfycbyzInKU7GhqMgvnJvX9zfOg17sPdiB3khXFE_aLV1yshNnSP7YlvClX-BMoP9ielnVf/exec';

  // html-to-image — a maintained dom-to-image fork. Has a proper UMD
  // bundle (modern-screenshot only ships ESM). Uses SVG <foreignObject>
  // internally → typically much faster than html2canvas's pixel-walking
  // approach. Global is `window.htmlToImage`.
  var SCREENSHOT_CDN = 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.js';

  // Cadence + quality knobs (tune for size vs fidelity).
  //
  // Frame rate budget for a 60s session:
  //   Interval 1000ms → 60 frames × ~100 KB = ~6 MB
  //   Interval  500ms → 120 frames × ~100 KB = ~12 MB    (current)
  //   Interval  250ms → 240 frames × ~100 KB = ~24 MB
  //
  // Real-world html2canvas takes 200-800 ms per snapshot on a complex
  // page like Desertflow. At a 500 ms interval some snapshots will be
  // skipped (snapshotInFlight guard) — that's fine and self-regulating.
  // The effective rate becomes whatever the CPU can sustain.
  // Now using modern-screenshot which should be 2-3x faster than
  // html2canvas. Tuning for high frame count.
  var SNAPSHOT_INTERVAL_MS = 200;
  var SNAPSHOT_SCALE       = 0.35;
  var JPEG_QUALITY         = 0.5;

  // Events buffer + flush
  var EVENT_FLUSH_MS = 5000;

  // Wait this long after consent before starting. Just enough for the
  // visible viewport to paint after the consent banner is dismissed.
  // We DON'T wait for document.fonts.ready anymore — that can take 1-2 s
  // on a cold connection and means a short test recording catches
  // nothing past the first frame. Fonts fall back gracefully if not
  // ready yet (Inter / Crimson Pro → system serif/sans).
  var RECORD_START_DELAY_MS = 300;

  // Skip recording on these hostnames (local dev)
  var SKIP_HOSTNAMES = ['localhost', '127.0.0.1', '0.0.0.0', ''];

  // ===== UTILITIES ========================================================

  function log() {
    try {
      var args = ['[recorder]'].concat([].slice.call(arguments));
      console.log.apply(console, args);
    } catch (e) {}
  }

  function shouldSkip() {
    if (SKIP_HOSTNAMES.indexOf(location.hostname) !== -1) {
      log('skip: localhost'); return true;
    }
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') {
      log('skip: DNT header'); return true;
    }
    try {
      if (localStorage.getItem('session_recording_opt_out') === '1') {
        log('skip: opt-out flag set'); return true;
      }
    } catch (e) {}
    if (RECORDER_ENDPOINT === 'PASTE_RECORDER_APPS_SCRIPT_URL_HERE') {
      log('skip: endpoint not configured'); return true;
    }
    return false;
  }

  function makeSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'rec_' + crypto.randomUUID();
    }
    return 'rec_' + Date.now().toString(36) + '_' +
           Math.random().toString(36).slice(2, 10);
  }

  function getMetadata(sessionId) {
    return {
      sessionId: sessionId,
      startedAt: new Date().toISOString(),
      page: location.pathname,
      url: location.href,
      referrer: document.referrer || null,
      language: navigator.language || null,
      userAgent: navigator.userAgent || null,
      platform: navigator.platform || null,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      screen: window.screen
        ? window.screen.width + 'x' + window.screen.height
        : null,
      timezone: Intl && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : null,
      snapshotInterval: SNAPSHOT_INTERVAL_MS,
      snapshotScale: SNAPSHOT_SCALE,
      jpegQuality: JPEG_QUALITY
    };
  }

  function loadScript(src) {
    return new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function(){ resolve(); };
      s.onerror = function(){ reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function blobToBase64(blob) {
    return new Promise(function(resolve, reject){
      var r = new FileReader();
      r.onload = function(){
        // r.result is "data:image/jpeg;base64,<...>", strip prefix
        var s = r.result;
        var i = s.indexOf(',');
        resolve(i >= 0 ? s.substring(i + 1) : s);
      };
      r.onerror = function(){ reject(new Error('read failed')); };
      r.readAsDataURL(blob);
    });
  }

  // ===== STATE ============================================================

  var state = {
    sessionId: null,
    metadata: null,
    metadataSent: false,
    snapshotIndex: 0,
    snapshotInFlight: false,
    snapshotTimer: null,
    eventBuffer: [],
    eventFlushTimer: null,
    lastMouseX: 0,
    lastMouseY: 0,
    started: false
  };

  // ===== NETWORK ==========================================================

  // POST any JSON payload to the Apps Script. Uses no-cors so Apps Script
  // doesn't need to answer CORS preflight; we don't read the response.
  function postJson(payload, useBeacon) {
    var body;
    try { body = JSON.stringify(payload); }
    catch (e) { log('json stringify failed:', e); return Promise.resolve({ ok: false }); }

    if (useBeacon && navigator.sendBeacon) {
      try {
        var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
        navigator.sendBeacon(RECORDER_ENDPOINT, blob);
        return Promise.resolve({ ok: true, viaBeacon: true });
      } catch (e) { /* fall through */ }
    }

    return fetch(RECORDER_ENDPOINT, {
      method: 'POST',
      mode: 'no-cors',
      cache: 'no-store',
      keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: body
    }).then(function(){ return { ok: true }; })
      .catch(function(err){ log('post failed:', err); return { ok: false }; });
  }

  function sendMetadataOnce() {
    if (state.metadataSent) return Promise.resolve();
    state.metadataSent = true;
    return postJson({
      sessionId: state.sessionId,
      type: 'meta',
      metadata: state.metadata
    }, false);
  }

  function sendSnapshot(jpegBase64, snapMeta, useBeacon) {
    return postJson({
      sessionId: state.sessionId,
      type: 'snapshot',
      index: snapMeta.index,
      timestamp: snapMeta.timestamp,
      scrollY: snapMeta.scrollY,
      scrollX: snapMeta.scrollX,
      mouseX: snapMeta.mouseX,
      mouseY: snapMeta.mouseY,
      viewport: snapMeta.viewport,
      jpeg: jpegBase64
    }, !!useBeacon);
  }

  function flushEvents(useBeacon) {
    if (state.eventBuffer.length === 0) return Promise.resolve();
    var batch = state.eventBuffer.splice(0);
    return postJson({
      sessionId: state.sessionId,
      type: 'events',
      events: batch
    }, !!useBeacon);
  }

  // ===== SNAPSHOTTING =====================================================

  function captureSnapshot(useBeacon) {
    if (state.snapshotInFlight) {
      log('snapshot skipped: previous capture still in flight');
      return Promise.resolve();
    }
    if (!window.htmlToImage || !window.htmlToImage.toCanvas) {
      log('snapshot skipped: html-to-image not loaded');
      return Promise.resolve();
    }
    state.snapshotInFlight = true;
    var startWall = Date.now();

    var snapMeta = {
      index: state.snapshotIndex++,
      timestamp: startWall,
      scrollY: window.scrollY || window.pageYOffset || 0,
      scrollX: window.scrollX || window.pageXOffset || 0,
      mouseX: state.lastMouseX,
      mouseY: state.lastMouseY,
      viewport: window.innerWidth + 'x' + window.innerHeight
    };

    log('snapshot ' + snapMeta.index + ' START',
        '(scroll=' + snapMeta.scrollY + ', mouse=' +
        snapMeta.mouseX + ',' + snapMeta.mouseY + ')');

    // html-to-image's toCanvas captures the WHOLE element passed to it.
    // We capture document.documentElement (the entire page) and crop
    // the resulting canvas to the viewport ourselves below. The crop
    // (~1ms via drawImage) is negligible compared to the render time.
    //
    // pixelRatio is html-to-image's "scale" knob — it multiplies the
    // canvas dimensions. We set it equal to SNAPSHOT_SCALE.
    return window.htmlToImage.toCanvas(document.documentElement, {
      pixelRatio: SNAPSHOT_SCALE,
      backgroundColor: '#ffffff',
      cacheBust: false,
      skipAutoScale: true,
      // CRITICAL: skip font embedding. html-to-image tries to fetch
      // Google Fonts CSS and inline it into the snapshot SVG. Google's
      // CORS blocks reading cssRules from cross-origin stylesheets,
      // which throws a SecurityError, which crashes the whole render
      // → 2 KB empty blobs. With skipFonts:true, text falls back to
      // system fonts in the snapshot, the page content renders, AND
      // the snapshot completes faster (no font-embed roundtrip).
      skipFonts: true,
      // Skip elements with rr-block class (escape hatch for future
      // noisy elements that misrender)
      filter: function(node) {
        if (node && node.classList && node.classList.contains('rr-block')) {
          return false;
        }
        return true;
      }
    }).then(function(fullCanvas){
      var renderMs = Date.now() - startWall;
      log('snapshot ' + snapMeta.index + ' rendered in ' + renderMs + 'ms');

      // Crop to viewport. fullCanvas is the entire page rendered at
      // SNAPSHOT_SCALE. We want just the part the visitor was looking at.
      var cropW = Math.round(window.innerWidth * SNAPSHOT_SCALE);
      var cropH = Math.round(window.innerHeight * SNAPSHOT_SCALE);
      var srcX  = Math.round(snapMeta.scrollX * SNAPSHOT_SCALE);
      var srcY  = Math.round(snapMeta.scrollY * SNAPSHOT_SCALE);

      var cropped = document.createElement('canvas');
      cropped.width  = cropW;
      cropped.height = cropH;
      var ctx = cropped.getContext('2d');
      // White background so any out-of-bounds area is white not transparent
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cropW, cropH);
      ctx.drawImage(fullCanvas, -srcX, -srcY);

      return new Promise(function(resolve){
        cropped.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
      });
    }).then(function(blob){
      // CAPTURE IS DONE — release the lock NOW so the next snapshot can
      // start immediately. The upload runs in the background (fire-and-
      // forget); we don't wait for Apps Script to finish writing the
      // file before allowing the next capture. This decouples the capture
      // rate (gated by html2canvas speed) from the upload rate (gated by
      // Apps Script speed), and is what stops the recorder from getting
      // wedged when uploads are slow.
      state.snapshotInFlight = false;

      if (!blob) {
        log('snapshot ' + snapMeta.index + ' toBlob returned null');
        return;
      }
      log('snapshot ' + snapMeta.index + ' blob size ' +
          Math.round(blob.size / 1024) + ' KB (uploading in background)');

      // Background upload — don't await. Errors are logged but don't
      // affect future captures.
      blobToBase64(blob)
        .then(function(b64){ return sendSnapshot(b64, snapMeta, !!useBeacon); })
        .then(function(){
          var totalMs = Date.now() - startWall;
          log('snapshot ' + snapMeta.index + ' UPLOADED in ' + totalMs + 'ms total');
        })
        .catch(function(err){
          log('snapshot ' + snapMeta.index + ' UPLOAD FAILED:',
              err && err.message ? err.message : err);
        });
    }).catch(function(err){
      log('snapshot ' + snapMeta.index + ' CAPTURE FAILED:',
          err && err.message ? err.message : err);
      // Capture failed — release the lock so the next attempt can try
      state.snapshotInFlight = false;
    });
  }

  // ===== EVENT TRACKING ===================================================

  function pushEvent(ev) {
    state.eventBuffer.push(ev);
    // Cap buffer so it doesn't grow unbounded if the network is down
    if (state.eventBuffer.length > 500) {
      state.eventBuffer = state.eventBuffer.slice(-500);
    }
  }

  function attachEventListeners() {
    // Mouse position — updated synchronously, sent as part of the next snapshot
    window.addEventListener('mousemove', function(e){
      state.lastMouseX = e.clientX;
      state.lastMouseY = e.clientY;
    }, { passive: true });

    // Click — append to event log AND take a snapshot immediately
    window.addEventListener('click', function(e){
      pushEvent({
        t: Date.now(),
        type: 'click',
        x: e.clientX,
        y: e.clientY,
        target: (e.target && e.target.tagName) ? e.target.tagName : null
      });
      // Fire-and-forget snapshot of the click
      captureSnapshot(false);
    }, { passive: true });

    // Scroll — coalesce into 250ms ticks so we don't spam the buffer
    var scrollTimer = null;
    window.addEventListener('scroll', function(){
      if (scrollTimer) return;
      scrollTimer = setTimeout(function(){
        scrollTimer = null;
        pushEvent({
          t: Date.now(),
          type: 'scroll',
          y: window.scrollY || window.pageYOffset || 0
        });
      }, 250);
    }, { passive: true });
  }

  // ===== LIFECYCLE ========================================================

  function startRecording() {
    if (state.started) return;
    state.started = true;

    state.sessionId = makeSessionId();
    state.metadata = getMetadata(state.sessionId);

    log('starting session', state.sessionId,
        '· interval', SNAPSHOT_INTERVAL_MS + 'ms',
        '· scale', SNAPSHOT_SCALE,
        '· jpeg quality', JPEG_QUALITY);

    attachEventListeners();

    // Send metadata FIRST (so the Drive folder exists with metadata.json)
    sendMetadataOnce().then(function(){
      // Initial snapshot
      captureSnapshot(false);
    });

    // Periodic snapshots
    state.snapshotTimer = setInterval(function(){
      captureSnapshot(false);
    }, SNAPSHOT_INTERVAL_MS);

    // Periodic event flush
    state.eventFlushTimer = setInterval(function(){
      flushEvents(false);
    }, EVENT_FLUSH_MS);

    // Final flush on tab close. Note: html2canvas is async and won't
    // complete during pagehide, so the final snapshot is best-effort.
    // The events flush IS reliable via sendBeacon.
    var onPageHide = function(){
      flushEvents(true);
      captureSnapshot(true);  // probably won't land, but try
    };
    window.addEventListener('pagehide', onPageHide, { capture: true });
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState === 'hidden') onPageHide();
    });
  }

  // ===== ENTRY POINT (called by consent.js) ==============================

  function init() {
    if (shouldSkip()) return;

    loadScript(SCREENSHOT_CDN).then(function(){
      log('html-to-image loaded, starting in ' + RECORD_START_DELAY_MS + 'ms');
      setTimeout(startRecording, RECORD_START_DELAY_MS);
    }).catch(function(err){
      log('failed to load html-to-image:', err);
    });
  }

  window.__BundleRecorder = {
    init: init,
    stop: function(){
      if (state.snapshotTimer) clearInterval(state.snapshotTimer);
      if (state.eventFlushTimer) clearInterval(state.eventFlushTimer);
      flushEvents(true);
      captureSnapshot(true);
      state.started = false;
    },
    state: state
  };

})();
