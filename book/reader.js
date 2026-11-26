/* reader.js — reads the book PDF right on the page (works on phones too).
 *
 * Uses pdf.js (loaded from cdnjs in book/index.html). Every page gets a
 * placeholder of the right shape; pages are drawn only when they come near
 * the screen and are cleared again when far away, so long books stay light
 * on memory. Toolbar: zoom, current page / jump to page, download.
 */
(function(){
  var PDF_URL = document.getElementById('reader').getAttribute('data-pdf');
  var pagesEl = document.getElementById('reader-pages');
  var statusEl = document.getElementById('reader-status');
  var pageInput = document.getElementById('reader-page');
  var totalEl = document.getElementById('reader-total');
  var zoomEl = document.getElementById('reader-zoom-level');
  var pdfDoc = null, pages = [], zoom = 1, renderToken = 0;

  function fail(msg){
    statusEl.hidden = false;
    statusEl.innerHTML = msg + ' <a href="' + PDF_URL + '" download>Download the PDF instead</a>.';
  }
  if (!window.pdfjsLib) { fail('The reader could not load.'); return; }
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  function baseWidth(){ return Math.min(pagesEl.clientWidth - 2, 880); }

  function sizePage(p){
    var w = Math.round(baseWidth() * zoom);
    p.el.style.width = w + 'px';
    p.el.style.height = Math.round(w * p.ratio) + 'px';
  }

  function draw(p){
    if (p.drawn === renderToken || p.busy) return;
    p.busy = true;
    var token = renderToken;
    var cssW = p.el.clientWidth || baseWidth();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var vp = p.page.getViewport({ scale: (cssW * dpr) / p.width });
    var canvas = p.canvas;
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    p.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function(){
      p.busy = false; p.drawn = token;
      p.el.classList.add('is-drawn');
      if (token !== renderToken && p.near) draw(p);   // zoom changed while drawing
    }, function(){ p.busy = false; });
  }

  function release(p){
    if (p.busy) return;
    p.canvas.width = 0; p.canvas.height = 0; p.drawn = -1;
    p.el.classList.remove('is-drawn');
  }

  var nearObserver = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      var p = pages[+e.target.getAttribute('data-n') - 1];
      p.near = e.isIntersecting;
      if (!p.page) return;
      if (e.isIntersecting) draw(p); else release(p);
    });
  }, { rootMargin: '1200px 0px' });

  function currentPage(){
    var mid = window.innerHeight / 2, best = 1, bestD = Infinity;
    for (var i = 0; i < pages.length; i++) {
      var r = pages[i].el.getBoundingClientRect();
      if (r.bottom < 0) continue;
      if (r.top > window.innerHeight) break;
      var d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < bestD) { bestD = d; best = i + 1; }
    }
    return best;
  }
  var ticking = false;
  window.addEventListener('scroll', function(){
    if (ticking || !pages.length) return;
    ticking = true;
    requestAnimationFrame(function(){
      if (document.activeElement !== pageInput) pageInput.value = currentPage();
      ticking = false;
    });
  }, { passive: true });

  function goTo(n){
    n = Math.max(1, Math.min(pages.length, n | 0));
    var top = pages[n - 1].el.getBoundingClientRect().top + window.scrollY - 130;
    window.scrollTo({ top: top, behavior: 'smooth' });
  }
  pageInput.addEventListener('change', function(){ goTo(parseInt(pageInput.value, 10) || 1); });
  pageInput.addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); goTo(parseInt(pageInput.value, 10) || 1); pageInput.blur(); } });

  function setZoom(z){
    var keep = currentPage();
    zoom = Math.max(0.6, Math.min(2.2, Math.round(z * 10) / 10));
    zoomEl.textContent = Math.round(zoom * 100) + '%';
    renderToken++;
    pages.forEach(function(p){ sizePage(p); if (p.near && p.page) draw(p); });
    goTo(keep);
  }
  document.getElementById('reader-zoom-out').addEventListener('click', function(){ setZoom(zoom - 0.2); });
  document.getElementById('reader-zoom-in').addEventListener('click', function(){ setZoom(zoom + 0.2); });

  var resizeTimer;
  window.addEventListener('resize', function(){
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){
      renderToken++;
      pages.forEach(function(p){ sizePage(p); if (p.near && p.page) draw(p); });
    }, 200);
  });

  pdfjsLib.getDocument(PDF_URL).promise.then(function(doc){
    pdfDoc = doc;
    totalEl.textContent = doc.numPages;
    pageInput.max = doc.numPages;
    statusEl.hidden = true;
    // Use the first page's shape for every placeholder, then correct each page once it loads.
    return doc.getPage(1).then(function(first){
      var v = first.getViewport({ scale: 1 }), ratio = v.height / v.width;
      for (var n = 1; n <= doc.numPages; n++) {
        var el = document.createElement('div');
        el.className = 'reader-page';
        el.setAttribute('data-n', n);
        el.setAttribute('aria-label', 'Page ' + n);
        var canvas = document.createElement('canvas');
        el.appendChild(canvas);
        var num = document.createElement('span');
        num.className = 'reader-page-num'; num.textContent = n;
        el.appendChild(num);
        pagesEl.appendChild(el);
        var p = { n: n, el: el, canvas: canvas, ratio: ratio, width: v.width, page: null, drawn: -1, near: false, busy: false };
        pages.push(p);
        sizePage(p);
        nearObserver.observe(el);
      }
      pages.forEach(function(p){
        doc.getPage(p.n).then(function(pg){
          var vv = pg.getViewport({ scale: 1 });
          p.page = pg; p.width = vv.width; p.ratio = vv.height / vv.width;
          sizePage(p);
          if (p.near) draw(p);
        });
      });
    });
  }).catch(function(){ fail('Sorry, the book could not be shown here.'); });
})();
