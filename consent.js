/* Session-recording consent banner for bundle-research.xyz
 *
 * Shows a small bottom-right banner on first visit asking for explicit
 * opt-in to collect session data via Microsoft Clarity.
 * - Stores the choice in localStorage so we don't re-ask on every page.
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

  function showBanner(){
    var b = document.createElement('div');
    b.className = 'consent-banner';
    b.setAttribute('role','dialog');
    b.setAttribute('aria-label','Analytics consent');
    b.innerHTML =
      '<p>Do you think that this website is built correctly? Your answear is important</p>' +
      '<div class="consent-banner-buttons">' +
        '<button class="consent-btn consent-agree" type="button">Agree</button>' +
        '<button class="consent-btn consent-decline" type="button">Decline</button>' +
      '</div>';
    document.body.appendChild(b);
    b.querySelector('.consent-agree').addEventListener('click', function(){
      try{ localStorage.setItem(CONSENT_KEY,'agree'); }catch(e){}
      b.remove();
      loadClarity();
    });
    b.querySelector('.consent-decline').addEventListener('click', function(){
      try{ localStorage.setItem(CONSENT_KEY,'decline'); }catch(e){}
      b.remove();
    });
  }

  function init(){
    var stored;
    try{ stored = localStorage.getItem(CONSENT_KEY); }catch(e){ stored = null; }
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
