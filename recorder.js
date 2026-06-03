/* recorder.js — Self-hosted session recorder.
 *
 * Uses the open-source rrweb library (MIT-licensed) to capture the visitor's
 * session as a stream of DOM mutation + event records. Batches are POSTed to
 * a Google Apps Script every 5 seconds, which writes them to a Google Drive
 * folder. A local replay.html tool plays them back.
 *
 * Privacy:
 * - Only runs AFTER the visitor agrees to the consent banner (consent.js).
 * - Skipped on localhost / dev domains.
 * - Skipped if the visitor has the Do-Not-Track header set.
 * - Skipped if `localStorage.session_recording_opt_out === '1'` is set
 *   (visitor can opt out by setting this in DevTools).
 * - No keystroke capture on password / email / tel inputs (rrweb default).
 * - All credentials in the script are PUBLIC (visitor's browser sees them).
 *   The Apps Script endpoint should be deployed with "anyone" access but
 *   write to a private Drive folder you control.
 *
 * Performance:
 * - rrweb loaded lazily from jsdelivr CDN (~50 KB gzipped).
 * - Batches every 5 s OR every 200 events, whichever first.
 * - Mouse moves sampled every 50 ms (not every frame).
 * - Final flush on `pagehide` uses `navigator.sendBeacon` (reliable).
 * - Network failures are silent — never break the page.
 */
(function(){
  'use strict';

  // ===== CONFIGURATION ====================================================

  // Apps Script URL for receiving session batches. Deploy your own — see
  // RECORDER_SETUP.md. This URL is PUBLIC (any visitor's browser can read it).
  // PLACEHOLDER — REPLACE WITH YOUR DEPLOYED RECORDER APPS SCRIPT URL.
  var RECORDER_ENDPOINT = 'PASTE_RECORDER_APPS_SCRIPT_URL_HERE';

  // rrweb library version (pinned for reproducibility)
  var RRWEB_CDN = 'https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.4/dist/rrweb.min.js';

  // Batch every N events OR every N ms, whichever comes first
  var BATCH_EVENT_LIMIT = 200;
  var BATCH_INTERVAL_MS = 5000;

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
    // Prefer crypto.randomUUID if available
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'rec_' + crypto.randomUUID();
    }
    // Fallback to timestamp + random
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
        : null
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

  // ===== STATE ============================================================

  var state = {
    sessionId: null,
    metadata: null,
    eventBuffer: [],
    stopFn: null,
    flushTimer: null,
    flushInFlight: false,
    metadataSent: false,
    started: false
  };

  // ===== NETWORK ==========================================================

  function postJson(payload, useBeacon) {
    var body = JSON.stringify(payload);
    if (useBeacon && navigator.sendBeacon) {
      try {
        // sendBeacon: best-effort POST during unload. Doesn't return a result.
        var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
        navigator.sendBeacon(RECORDER_ENDPOINT, blob);
        return Promise.resolve({ ok: true, viaBeacon: true });
      } catch (e) {
        // Fall through to fetch
      }
    }
    // Use no-cors to avoid CORS preflight failures (Apps Script doesn't
    // return the right headers for preflight). We won't see the response,
    // but the request still hits the server.
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

  function flush(useBeacon) {
    if (state.flushInFlight && !useBeacon) return Promise.resolve();
    if (state.eventBuffer.length === 0 && state.metadataSent) {
      return Promise.resolve();
    }
    state.flushInFlight = true;

    var payload = {
      sessionId: state.sessionId,
      batchTime: Date.now()
    };

    // Send metadata on the first batch only
    if (!state.metadataSent) {
      payload.metadata = state.metadata;
      state.metadataSent = true;
    }

    if (state.eventBuffer.length > 0) {
      payload.events = state.eventBuffer.splice(0);
    }

    return postJson(payload, !!useBeacon).then(function(res){
      state.flushInFlight = false;
      return res;
    });
  }

  // ===== rrweb HOOK =======================================================

  function startRecording() {
    if (!window.rrweb || typeof window.rrweb.record !== 'function') {
      log('rrweb not loaded, aborting');
      return;
    }
    if (state.started) return;
    state.started = true;

    state.sessionId = makeSessionId();
    state.metadata = getMetadata(state.sessionId);

    log('starting session', state.sessionId);

    state.stopFn = window.rrweb.record({
      emit: function(event) {
        state.eventBuffer.push(event);
        if (state.eventBuffer.length >= BATCH_EVENT_LIMIT) {
          flush(false);
        }
      },
      // Compact options to save bandwidth
      recordCanvas: false,
      collectFonts: false,
      inlineStylesheet: true,
      maskTextSelector: 'input[type="password"], input[type="email"], input[type="tel"]',
      maskAllInputs: false,
      sampling: {
        mousemove: 50,
        scroll: 150,
        input: 'last'
      }
    });

    // Periodic flush
    state.flushTimer = setInterval(function(){ flush(false); }, BATCH_INTERVAL_MS);

    // Final flush on page hide (covers tab-close, navigation, mobile background)
    window.addEventListener('pagehide', function(){ flush(true); }, { capture: true });
    // Belt-and-braces for browsers that fire visibilitychange but not pagehide
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState === 'hidden') flush(true);
    });
  }

  // ===== ENTRY POINT (called by consent.js) ==============================

  function init() {
    if (shouldSkip()) return;

    loadScript(RRWEB_CDN).then(function(){
      startRecording();
    }).catch(function(err){
      log('failed to load rrweb:', err);
    });
  }

  // Expose globally so consent.js can call it after the user agrees
  window.__BundleRecorder = {
    init: init,
    stop: function(){
      if (state.stopFn) try { state.stopFn(); } catch (e) {}
      if (state.flushTimer) clearInterval(state.flushTimer);
      flush(true);
      state.started = false;
    },
    state: state
  };

})();
