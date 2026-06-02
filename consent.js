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

  function logConsentEvent(action){
    // Action is "agreed" or "declined".
    // 1) Console log — visible to the operator in DevTools during testing
    //    and to anyone who opens DevTools. Useful for local verification.
    try {
      console.log('%c[Bundle Consent]', 'color:#0f7b6c;font-weight:bold',
                  action.toUpperCase() + ' at ' + new Date().toISOString());
    } catch(e) {}

    // 2) Microsoft Clarity custom event — only works for Agree (Clarity is
    //    loaded then). Wait briefly for Clarity to initialize.
    var label = (action === 'agreed') ? 'Consent Agreed' : 'Consent Declined';
    var tries = 0;
    var fireClarityEvent = function(){
      try {
        if (typeof window.clarity === 'function') {
          window.clarity('event', label);
          return;
        }
      } catch(e) {}
      if (tries++ < 20) setTimeout(fireClarityEvent, 200);
    };
    fireClarityEvent();

    // 3) Beacon to your own domain — generates a GET request that Cloudflare
    //    logs at the edge. The URL pattern shows up if you ever enable
    //    detailed Cloudflare request logs. Cheap fallback so DECLINE events
    //    have ANY server-side trace (Clarity won't record them).
    try {
      var img = new Image();
      img.referrerPolicy = 'no-referrer-when-downgrade';
      img.src = '/?consent=' + encodeURIComponent(action)
              + '&t=' + Date.now();
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
