/* Session-recording consent banner for bundle-research.xyz
 *
 * Shows a small bottom-right banner asking for explicit opt-in to collect
 * session data via Microsoft Clarity.
 * - Stores the choice in sessionStorage — the choice is remembered for the
 *   current browsing session only. When the visitor closes the browser/tab
 *   and reopens the site later, the banner appears again so they can
 *   reaffirm (or change) their choice.
 * - Within a single session, the choice IS remembered (no nagging on every
 *   page navigation).
 * - Only loads the Clarity script if the user has explicitly clicked Agree.
 * - Cloudflare Web Analytics is loaded UNCONDITIONALLY in the HTML files
 *   because it is cookie-free, fingerprint-free, and does not identify
 *   individuals — so it does not require user consent.
 *
 * To enable Clarity:
 *   1. Sign up at https://clarity.microsoft.com (free, no limits)
 *   2. Add bundle-research.xyz as a project
 *   3. Replace CLARITY_ID below with your project ID
 *   4. Commit + push
 */
(function(){
  var CONSENT_KEY = 'br_analytics_consent';
  // Microsoft Clarity Project ID — Bundle Research project.
  // Dashboard: https://clarity.microsoft.com
  var CLARITY_ID = 'x0x4wc5l93';

  function loadClarity(){
    if(!CLARITY_ID || CLARITY_ID === 'YOUR_CLARITY_ID') return;
    (function(c,l,a,r,i,t,y){
      c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
      t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
      y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window,document,"clarity","script",CLARITY_ID);
  }

  // Google Apps Script Web App that logs each consent event into a
  // Google Sheet. Set up via https://sheets.google.com → Extensions →
  // Apps Script (deployed as Web App, "Anyone" access).
  var SHEET_URL = 'https://script.google.com/macros/s/AKfycbwnw36gVv0X752KAiGt6DEik7ks3YIpcxWUXdigUsaHDnMR_SCHmtNR1k4Ez6aLUyWgzQ/exec';

  function logConsentEvent(action){
    // Action is "agreed" or "declined".

    // 1) Console log — visible to the operator in DevTools during testing.
    try {
      console.log('%c[Bundle Consent]', 'color:#0f7b6c;font-weight:bold',
                  action.toUpperCase() + ' at ' + new Date().toISOString());
    } catch(e) {}

    // 2) Microsoft Clarity custom event — only works for Agree (Clarity is
    //    loaded then). Wait briefly for Clarity to initialize.
    var label = (action === 'agreed') ? 'Consent Agreed' : 'Consent Declined';
    var clarityTries = 0;
    var fireClarityEvent = function(){
      try {
        if (typeof window.clarity === 'function') {
          window.clarity('event', label);
          return;
        }
      } catch(e) {}
      if (clarityTries++ < 20) setTimeout(fireClarityEvent, 200);
    };
    fireClarityEvent();

    // 3) Cloudflare-edge beacon (cheap fallback so the request is logged
    //    at the edge even if the Sheet POST fails).
    try {
      var img = new Image();
      img.referrerPolicy = 'no-referrer-when-downgrade';
      img.src = '/?consent=' + encodeURIComponent(action)
              + '&t=' + Date.now();
    } catch(e) {}

    // 4) POST to the Google Sheet logger (rich per-event data).
    //    First collect everything the browser can report synchronously,
    //    then try to enrich with IP geolocation via ipapi.co. Whichever
    //    finishes first posts to the Sheet (with a 1.5s geo timeout so
    //    a slow ipapi doesn't lose the event).
    var payload = {
      action: action,
      timestamp: new Date().toISOString(),
      page: window.location.href,
      referrer: document.referrer || '',
      user_agent: navigator.userAgent || '',
      language: navigator.language || '',
      timezone: '',
      screen: (window.screen && window.screen.width)
                ? window.screen.width + 'x' + window.screen.height : '',
      viewport: window.innerWidth + 'x' + window.innerHeight,
      platform: navigator.platform || ''
    };
    try {
      if (Intl && Intl.DateTimeFormat) {
        payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      }
    } catch(e) {}

    var posted = false;
    function postOnce(data){
      if (posted) return;
      posted = true;
      try {
        // text/plain + no-cors avoids the CORS preflight that Apps Script
        // doesn't answer. keepalive lets the request survive page unload.
        fetch(SHEET_URL, {
          method: 'POST',
          mode: 'no-cors',
          headers: {'Content-Type': 'text/plain;charset=utf-8'},
          body: JSON.stringify(data),
          keepalive: true
        }).catch(function(){});
      } catch(e) {}
    }

    // Best-effort geo enrichment.
    // We race TWO services in parallel:
    //   (a) ipapi.co       — rich data (country name, region, city, IP)
    //                       but often blocked by Opera / Brave / uBlock
    //   (b) Cloudflare cdn-cgi/trace — always works (Cloudflare runs huge
    //                       swathes of the web), gives country code + IP
    // We prefer (a) when it succeeds; we fall back to (b) when (a) is
    // blocked or slow. We post whichever we have at the 1.5s mark.
    var richGeo = null;
    var basicGeo = null;

    function bestGeoSoFar(){
      // Prefer rich data (ipapi.co) when available; merge in IP/country
      // from Cloudflare as fallback fields.
      var out = {};
      if (richGeo) {
        out.country = richGeo.country || '';
        out.country_code = richGeo.country_code || '';
        out.region = richGeo.region || '';
        out.city = richGeo.city || '';
        out.ip = richGeo.ip || '';
        out._geo_source = 'ipapi.co';
      } else if (basicGeo) {
        out.country_code = basicGeo.country_code || '';
        out.ip = basicGeo.ip || '';
        out._geo_source = 'cloudflare-trace';
      }
      return out;
    }

    function postWithBestGeo(){
      var geo = bestGeoSoFar();
      for (var k in geo) { payload[k] = geo[k]; }
      postOnce(payload);
    }

    // Hard timeout: post whatever we have after 1.5s
    var geoTimer = setTimeout(postWithBestGeo, 1500);

    // (a) ipapi.co — preferred
    try {
      fetch('https://ipapi.co/json/', {cache: 'no-store'})
        .then(function(r){ return r.ok ? r.json() : null; })
        .catch(function(){ return null; })
        .then(function(geo){
          if (geo && !geo.error) {
            richGeo = {
              country: geo.country_name || '',
              country_code: geo.country_code || '',
              region: geo.region || '',
              city: geo.city || '',
              ip: geo.ip || ''
            };
            // ipapi succeeded — post immediately with rich data
            clearTimeout(geoTimer);
            postWithBestGeo();
          }
        });
    } catch(e) {}

    // (b) Cloudflare cdn-cgi/trace — fallback, always works
    try {
      fetch('https://www.cloudflare.com/cdn-cgi/trace', {cache: 'no-store'})
        .then(function(r){ return r.ok ? r.text() : ''; })
        .catch(function(){ return ''; })
        .then(function(text){
          if (!text) return;
          var info = {};
          text.trim().split('\n').forEach(function(line){
            var idx = line.indexOf('=');
            if (idx > 0) info[line.slice(0, idx)] = line.slice(idx + 1);
          });
          basicGeo = {
            country_code: info.loc || '',
            ip: info.ip || ''
          };
          // Don't post yet — keep waiting in case ipapi.co also returns
          // (richer data). The geoTimer will fire if ipapi doesn't show up.
        });
    } catch(e) {}
  }

  function showBanner(){
    var b = document.createElement('div');
    b.className = 'consent-banner';
    b.setAttribute('role','dialog');
    b.setAttribute('aria-label','Analytics consent');
    b.innerHTML =
      '<p>Do you agree to only collect data from your session on the website to further improve it</p>' +
      '<div class="consent-banner-buttons">' +
        '<button class="consent-btn consent-agree" type="button">Agree</button>' +
        '<button class="consent-btn consent-decline" type="button">Decline</button>' +
      '</div>';
    document.body.appendChild(b);
    b.querySelector('.consent-agree').addEventListener('click', function(){
      try{ sessionStorage.setItem(CONSENT_KEY,'agree'); }catch(e){}
      b.remove();
      loadClarity();
      logConsentEvent('agreed');
    });
    b.querySelector('.consent-decline').addEventListener('click', function(){
      try{ sessionStorage.setItem(CONSENT_KEY,'decline'); }catch(e){}
      b.remove();
      logConsentEvent('declined');
    });
  }

  function init(){
    var stored;
    try{ stored = sessionStorage.getItem(CONSENT_KEY); }catch(e){ stored = null; }
    if(stored === 'agree'){
      // User already agreed in a previous visit — start tracking immediately
      loadClarity();
    } else if(stored !== 'decline'){
      // First visit (no stored choice) — show the banner
      showBanner();
    }
    // If stored === 'decline' — do nothing this visit
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
