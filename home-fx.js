/* home-fx.js — home-page-only animations.
 *
 * - Scroll progress bar at the very top.
 * - Rotating word in the hero headline.
 * - Drifting dot network behind the hero that reaches toward the mouse
 *   (paused when off-screen or the tab is hidden).
 * - Cards tilt toward the mouse with a soft spotlight (mouse devices only).
 *
 * Everything is skipped when the visitor asks for reduced motion.
 * No external libraries.
 */
(function(){
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Scroll progress bar ----------
  function initProgress(){
    var bar = document.querySelector('.scroll-progress');
    if (!bar) return;
    var ticking = false;
    function update(){
      var h = document.documentElement.scrollHeight - window.innerHeight;
      var p = h > 0 ? Math.min(window.scrollY / h, 1) : 0;
      bar.style.transform = 'scaleX(' + p + ')';
      ticking = false;
    }
    window.addEventListener('scroll', function(){
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  }

  // ---------- Rotating headline word ----------
  function initRotator(){
    var host = document.querySelector('.rotator');
    if (!host || reduce) return;
    var word = host.querySelector('.rotator-word');
    var words = (host.getAttribute('data-words') || '').split('|').filter(Boolean);
    if (!word || words.length < 2) return;
    var i = 0;
    setInterval(function(){
      if (document.hidden) return;
      word.classList.remove('is-in');
      word.classList.add('is-out');
      setTimeout(function(){
        i = (i + 1) % words.length;
        word.textContent = words[i];
        word.classList.remove('is-out');
        void word.offsetWidth;            // restart the entry animation
        word.classList.add('is-in');
      }, 380);
    }, 2600);
  }

  // ---------- Hero dot network ----------
  function initNetwork(){
    var canvas = document.querySelector('.hero-canvas');
    if (!canvas || reduce || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var hero = canvas.parentElement;
    var dots = [], w = 0, h = 0, dpr = 1, running = false, visible = true;
    var mouse = { x: -9999, y: -9999 };
    var LINK = 130, MOUSE_LINK = 170;

    function resize(){
      var r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width; h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var count = Math.round(Math.min(70, Math.max(24, (w * h) / 16000)));
      dots = [];
      for (var k = 0; k < count; k++) {
        dots.push({
          x: Math.random() * w, y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
          r: 1.2 + Math.random() * 1.8,
          gold: Math.random() < 0.18
        });
      }
    }

    function frame(){
      if (!running) return;
      ctx.clearRect(0, 0, w, h);
      for (var a = 0; a < dots.length; a++) {
        var d = dots[a];
        d.x += d.vx; d.y += d.vy;
        if (d.x < 0 || d.x > w) d.vx *= -1;
        if (d.y < 0 || d.y > h) d.vy *= -1;
        for (var b = a + 1; b < dots.length; b++) {
          var e = dots[b], dx = d.x - e.x, dy = d.y - e.y, dist = Math.sqrt(dx*dx + dy*dy);
          if (dist < LINK) {
            ctx.strokeStyle = 'rgba(45,212,191,' + (0.28 * (1 - dist / LINK)).toFixed(3) + ')';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(e.x, e.y); ctx.stroke();
          }
        }
        var mx = d.x - mouse.x, my = d.y - mouse.y, md = Math.sqrt(mx*mx + my*my);
        if (md < MOUSE_LINK) {
          ctx.strokeStyle = 'rgba(244,196,48,' + (0.45 * (1 - md / MOUSE_LINK)).toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
          d.x += mx / md * 0.25; d.y += my / md * 0.25;   // drift gently away from the cursor
        }
        ctx.fillStyle = d.gold ? 'rgba(212,160,23,0.9)' : 'rgba(94,234,212,0.75)';
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
      }
      requestAnimationFrame(frame);
    }

    function setRunning(on){
      if (on && !running) { running = true; requestAnimationFrame(frame); }
      else if (!on) running = false;
    }

    resize();
    window.addEventListener('resize', resize);
    hero.addEventListener('mousemove', function(ev){
      var r = canvas.getBoundingClientRect();
      mouse.x = ev.clientX - r.left; mouse.y = ev.clientY - r.top;
    });
    hero.addEventListener('mouseleave', function(){ mouse.x = mouse.y = -9999; });
    document.addEventListener('visibilitychange', function(){ setRunning(!document.hidden && visible); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function(entries){
        visible = entries[0].isIntersecting;
        setRunning(visible && !document.hidden);
      }).observe(hero);
    }
    setRunning(true);
  }

  // ---------- Card tilt + spotlight ----------
  function initTilt(){
    if (reduce || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    var cards = document.querySelectorAll('.photo-card, .team-card');
    cards.forEach(function(card){
      card.addEventListener('mousemove', function(ev){
        var r = card.getBoundingClientRect();
        var px = (ev.clientX - r.left) / r.width, py = (ev.clientY - r.top) / r.height;
        card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
        card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
        card.classList.add('is-tilting');
        card.style.transform = 'perspective(900px) rotateX(' + ((0.5 - py) * 7).toFixed(2) + 'deg) rotateY(' + ((px - 0.5) * 9).toFixed(2) + 'deg) translateY(-6px)';
      });
      card.addEventListener('mouseleave', function(){
        card.classList.remove('is-tilting');
        card.style.transform = '';
      });
    });
  }

  function init(){
    initProgress();
    initRotator();
    initNetwork();
    initTilt();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
