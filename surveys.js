/* Lightweight feedback surveys for bundle-research.xyz.
 *
 * - Homepage (index.html):
 *     "Do you like our projects?" → Yes / No
 *
 * - Research page (desertflow.html):
 *     "Did you like the research?" → Yes / No
 *     (then) "Can we contact you for feedback? This would be very useful
 *            for us, we would appreciate it." → Yes / No
 *
 * All answers POST to the same Google Sheet logger as consent.js
 * (same SHEET_URL, distinct `action` values).
 *
 * UX:
 *   - The survey banner uses the same look/feel as the consent banner
 *     (bottom-right, non-blocking, .consent-banner class).
 *   - Surveys only show AFTER the visitor has answered the consent banner
 *     (so the two don't stack visually).
 *   - One survey per browser session per page (sessionStorage).
 *   - Default delay before the survey appears: 30 seconds.
 */
(function(){
  // Keys keep each survey unique per session, so we don't nag.
  var KEY_HOMEPAGE  = 'br_survey_homepage_v1';
  var KEY_RESEARCH  = 'br_survey_research_v1';
  var KEY_CONTACT   = 'br_survey_contact_v1';
  var CONSENT_KEY   = 'br_analytics_consent';

  // Same logger Google Sheet Apps Script URL as consent.js
  var SHEET_URL = 'https://script.google.com/macros/s/AKfycbwnw36gVv0X752KAiGt6DEik7ks3YIpcxWUXdigUsaHDnMR_SCHmtNR1k4Ez6aLUyWgzQ/exec';

  // Tunable: how long after consent is dismissed before the survey appears.
  var DELAY_MS = 7000;

  // ------------------------------------------------------------------
  // Logging — same shape as consent.js, simpler (no geo race)
  // ------------------------------------------------------------------
  function logSurveyEvent(action){
    try {
      console.log('%c[Bundle Survey]', 'color:#0f7b6c;font-weight:bold',
                  action + ' at ' + new Date().toISOString());
    } catch(e) {}

    // Microsoft Clarity custom event (works only if consent=agreed)
    try {
      if (typeof window.clarity === 'function') {
        window.clarity('event', 'Survey ' + action);
      }
    } catch(e) {}

    // POST to the Google Sheet
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

    try {
      fetch(SHEET_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: {'Content-Type': 'text/plain;charset=utf-8'},
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function(){});
    } catch(e) {}
  }

  // ------------------------------------------------------------------
  // Banner builder (reuses consent-banner CSS)
  // ------------------------------------------------------------------
  function buildBanner(questionHTML, yesAction, noAction, onDone){
    var b = document.createElement('div');
    b.className = 'consent-banner survey-banner';
    b.setAttribute('role','dialog');
    b.setAttribute('aria-label','Feedback survey');
    b.innerHTML =
      '<p>' + questionHTML + '</p>' +
      '<div class="consent-banner-buttons">' +
        '<button class="consent-btn consent-agree"   type="button">Yes</button>' +
        '<button class="consent-btn consent-decline" type="button">No</button>' +
      '</div>';
    document.body.appendChild(b);
    b.querySelector('.consent-agree').addEventListener('click', function(){
      logSurveyEvent(yesAction);
      b.remove();
      if (onDone) onDone(true);
    });
    b.querySelector('.consent-decline').addEventListener('click', function(){
      logSurveyEvent(noAction);
      b.remove();
      if (onDone) onDone(false);
    });
  }

  // ------------------------------------------------------------------
  // Page detection
  // ------------------------------------------------------------------
  function isHomepage(){
    var p = window.location.pathname || '';
    return p === '' || p === '/' || /\/index\.html$/.test(p);
  }
  function isResearchPage(){
    return /desertflow/.test(window.location.pathname || '');
  }

  // ------------------------------------------------------------------
  // Surveys
  // ------------------------------------------------------------------
  // Tiny logger so the operator can see what's happening in DevTools.
  function L(){
    try {
      var args = ['%c[Bundle Survey]', 'color:#0f7b6c;font-weight:bold'];
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
      console.log.apply(console, args);
    } catch(e) {}
  }

  function showHomepageSurvey(){
    if (sessionStorage.getItem(KEY_HOMEPAGE)) {
      L('homepage survey already answered this session — skipping.',
        'To re-test, clear sessionStorage key', KEY_HOMEPAGE);
      return;
    }
    L('showing homepage survey: "Do you like our projects?"');
    buildBanner(
      'Do you like our projects?',
      'projects_liked',
      'projects_disliked',
      function(){
        try { sessionStorage.setItem(KEY_HOMEPAGE, '1'); } catch(e) {}
      }
    );
  }

  function showResearchSurvey(){
    if (sessionStorage.getItem(KEY_RESEARCH)) {
      L('research survey already answered this session — skipping.',
        'To re-test, clear sessionStorage key', KEY_RESEARCH);
      return;
    }
    L('showing research survey Q1: "Did you like the research?"');
    buildBanner(
      'Did you like the research?',
      'research_liked',
      'research_disliked',
      function(){
        try { sessionStorage.setItem(KEY_RESEARCH, '1'); } catch(e) {}
        // Q2 follows Q1 regardless of the Q1 answer
        setTimeout(showContactSurvey, 600);
      }
    );
  }

  function showContactSurvey(){
    if (sessionStorage.getItem(KEY_CONTACT)) {
      L('contact survey already answered — skipping.');
      return;
    }
    L('showing research survey Q2: "Can we contact you?"');
    buildBanner(
      'Can we contact you for feedback? This would be very useful for us — we would appreciate it.',
      'contact_yes',
      'contact_no',
      function(){
        try { sessionStorage.setItem(KEY_CONTACT, '1'); } catch(e) {}
      }
    );
  }

  // ------------------------------------------------------------------
  // Init — wait until consent has been chosen, then delay, then show
  // ------------------------------------------------------------------
  function waitForConsent(cb){
    var stored;
    try { stored = sessionStorage.getItem(CONSENT_KEY); } catch(e) { stored = null; }
    if (stored) { L('consent detected (' + stored + ') — starting survey timer'); cb(); return; }
    // Re-check fast so the survey fires soon after the user clicks consent
    setTimeout(function(){ waitForConsent(cb); }, 400);
  }

  function init(){
    L('surveys.js loaded. Path:', window.location.pathname,
      'isHomepage:', isHomepage(), 'isResearchPage:', isResearchPage());
    L('sessionStorage state:', {
      consent: sessionStorage.getItem(CONSENT_KEY),
      homepage_answered: sessionStorage.getItem(KEY_HOMEPAGE),
      research_answered: sessionStorage.getItem(KEY_RESEARCH),
      contact_answered: sessionStorage.getItem(KEY_CONTACT)
    });

    // No survey on the about page (or any page that isn't homepage/research)
    if (!isHomepage() && !isResearchPage()) {
      L('not on a survey-eligible page — exiting.');
      return;
    }

    L('waiting for consent to be chosen...');
    waitForConsent(function(){
      L('survey will appear in', DELAY_MS, 'ms');
      setTimeout(function(){
        L('delay elapsed — attempting to show survey');
        if (isResearchPage()) {
          showResearchSurvey();
        } else if (isHomepage()) {
          showHomepageSurvey();
        }
      }, DELAY_MS);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
