/* effects.js — scroll-triggered reveals, animated stat counters, nav shadow.
 * Keeps the site feeling alive without being annoying.
 *
 * - Adds `is-visible` class to elements with `data-reveal` as they enter
 *   the viewport, triggering CSS fade/slide animation.
 * - Counts stat numbers up from 0 to their target value when scrolled
 *   into view (only for elements with `data-counter-target`).
 * - Shadows the sticky nav once the page scrolls.
 *
 * No external libraries. Uses IntersectionObserver (supported in every
 * modern browser).
 */
(function(){
  document.documentElement.classList.add('js');

  // ---------- Scroll reveals ----------
  function initReveals(){
    var els = document.querySelectorAll('[data-reveal]');
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) {
      // Fallback: just show everything
      els.forEach(function(el){ el.classList.add('is-visible'); });
      return;
    }
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
    els.forEach(function(el){ io.observe(el); });
  }

  // ---------- Animated counters ----------
  function animateCounter(el, target, duration){
    var start = performance.now();
    var isFloat = target % 1 !== 0;
    var decimals = isFloat ? (String(target).split('.')[1] || '').length : 0;
    function tick(now){
      var elapsed = now - start;
      var progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      var eased = 1 - Math.pow(1 - progress, 3);
      var value = target * eased;
      el.textContent = isFloat ? value.toFixed(decimals) : Math.floor(value).toLocaleString();
      if (progress < 1) requestAnimationFrame(tick);
      else el.textContent = isFloat ? target.toFixed(decimals) : Math.floor(target).toLocaleString();
    }
    requestAnimationFrame(tick);
  }

  function initCounters(){
    var els = document.querySelectorAll('[data-counter-target]');
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) {
      els.forEach(function(el){
        el.textContent = el.getAttribute('data-counter-target');
      });
      return;
    }
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (entry.isIntersecting) {
          var target = parseFloat(entry.target.getAttribute('data-counter-target'));
          if (!isNaN(target)) animateCounter(entry.target, target, 1400);
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });
    els.forEach(function(el){
      // Start at 0 so the animation has somewhere to count from
      el.textContent = '0';
      io.observe(el);
    });
  }

  // ---------- Nav shadow on scroll ----------
  function initNavShadow(){
    var nav = document.querySelector('.nav');
    if (!nav) return;
    var update = function(){
      if (window.scrollY > 12) nav.classList.add('scrolled');
      else nav.classList.remove('scrolled');
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
  }

  // ---------- Circular TOC center display ----------
  // When the visitor hovers a chamber in the circular TOC, swap the
  // center disc text to the chamber's full title (taken from `title`
  // attribute). When they move away, restore the default.
  function initTocCircle(){
    var center = document.getElementById('tocCenterTitle');
    var chambers = document.querySelectorAll('.toc-chamber');
    if (!center || !chambers.length) return;
    var defaultText = center.textContent;
    chambers.forEach(function(ch){
      var full = ch.getAttribute('title') || ch.textContent.trim();
      ch.addEventListener('mouseenter', function(){ center.textContent = full; });
      ch.addEventListener('focus',      function(){ center.textContent = full; });
      ch.addEventListener('mouseleave', function(){ center.textContent = defaultText; });
      ch.addEventListener('blur',       function(){ center.textContent = defaultText; });
    });
  }

  // ---------- Phone menu button ----------
  // Adds a ☰ button to the menu bar. CSS only shows it (and hides the
  // links until it is pressed) on narrow screens; without JS the links
  // simply stay visible.
  function initNavToggle(){
    var nav = document.querySelector('.nav');
    var inner = nav && nav.querySelector('.nav-inner');
    var links = nav && nav.querySelector('.nav-links');
    if (!inner || !links || inner.querySelector('.nav-toggle')) return;
    if (!links.id) links.id = 'site-menu';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-toggle';
    btn.setAttribute('aria-label', 'Open menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', links.id);
    btn.innerHTML = '<span></span><span></span><span></span>';
    inner.insertBefore(btn, links);
    function setOpen(open){
      nav.classList.toggle('nav-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    btn.addEventListener('click', function(){ setOpen(!nav.classList.contains('nav-open')); });
    links.addEventListener('click', function(e){ if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape') setOpen(false); });
  }

  // ---------- Init ----------
  function init(){
    initReveals();
    initCounters();
    initNavShadow();
    initTocCircle();
    initNavToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
