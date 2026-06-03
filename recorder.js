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

  // html2canvas library — pinned to a stable version.
  var HTML2CANVAS_CDN = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';

  // Cadence + quality knobs (tune for size vs fidelity).
  //
  // Frame rate budget for a 60s session:
  //   Interval 5000ms → 12 frames × ~150 KB = ~1.8 MB
  //   Interval 1000ms → 60 frames × ~150 KB = ~9 MB     (current)
  //   Interval  500ms → 120 frames × ~150 KB = ~18 MB
  //
  // Reducing the interval too far also costs CPU on the visitor's machine
  // (html2canvas takes 100–400 ms per snapshot on a complex page).
  // 1 fps is a good balance of "smooth enough to understand visitor
  // behaviour" without burning their battery.
  var SNAPSHOT_INTERVAL_MS = 1000;   // 1 fps
  var SNAPSHOT_SCALE       = 0.75;   // 0.75 = 25% smaller than 1:1
  var JPEG_QUALITY         = 0.65;   // 0.65 = good balance of size + clarity

  // Events buffer + flush
  var EVENT_FLUSH_MS = 5000;

  // Wait this long after consent before starting. The old rrweb recorder
  // needed 2 s to dodge a "mid-animation FullSnapshot" bug; html2canvas
  // captures pixels and doesn't have that problem, so 800 ms (mostly for
  // web-font loading via `document.fonts.ready`) is enough.
  var RECORD_START_DELAY_MS = 800;

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
    if (state.snapshotInFlight) return Promise.resolve();
    if (!window.html2canvas) return Promise.resolve();
    state.snapshotInFlight = true;

    var snapMeta = {
      index: state.snapshotIndex++,
      timestamp: Date.now(),
      scrollY: window.scrollY || window.pageYOffset || 0,
      scrollX: window.scrollX || window.pageXOffset || 0,
      mouseX: state.lastMouseX,
      mouseY: state.lastMouseY,
      viewport: window.innerWidth + 'x' + window.innerHeight
    };

    // Capture the visible viewport (not the full document) — this keeps
    // each JPEG small and matches what the visitor actually saw.
    return window.html2canvas(document.body, {
      x: snapMeta.scrollX,
      y: snapMeta.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      scale: SNAPSHOT_SCALE,
      logging: false,
      useCORS: true,
      foreignObjectRendering: false,
      imageTimeout: 4000,
      removeContainer: true
    }).then(function(canvas){
      return new Promise(function(resolve){
        canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
      });
    }).then(function(blob){
      if (!blob) return null;
      return blobToBase64(blob);
    }).then(function(b64){
      if (!b64) return;
      return sendSnapshot(b64, snapMeta, !!useBeacon);
    }).catch(function(err){
      log('snapshot failed (index ' + snapMeta.index + '):', err);
    }).then(function(){
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

    loadScript(HTML2CANVAS_CDN).then(function(){
      log('html2canvas loaded, settling page for ' +
          RECORD_START_DELAY_MS + 'ms');

      // Also wait for fonts so snapshots aren't using fallback typefaces
      var fontsReady = document.fonts && document.fonts.ready
                        ? document.fonts.ready
                        : Promise.resolve();

      Promise.all([
        fontsReady,
        new Promise(function(r){ setTimeout(r, RECORD_START_DELAY_MS); })
      ]).then(startRecording);
    }).catch(function(err){
      log('failed to load html2canvas:', err);
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
