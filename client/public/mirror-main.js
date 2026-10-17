(function(){
  if (typeof window === 'undefined') return;
  if (window.__kbMirrorMainInstalled) return;
  window.__kbMirrorMainInstalled = true;

  var frameCount = 0;

  function ensureMirror(){
    var m = document.getElementById('mirror');
    if (m) return m;
    m = document.createElement('canvas');
    m.id = 'mirror';
    m.style.cssText = 'position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;z-index:9000!important;pointer-events:none!important;background:#000!important;object-fit:contain!important;object-position:center!important;';
    document.documentElement.appendChild(m);
    // PATCH v1.29.1: applica brightness real-time
    try {
      var _g = parseFloat(localStorage.getItem('__kbGamma') || '1.0');
      if (_g && _g !== 1.0) m.style.filter = 'brightness(' + _g + ')';
    } catch(e){}
    console.log('[mirror-main] canvas mirror creato (z-index alto, bordo lime)');
    return m;
  }

  // Latest-frame-wins: se arrivano piu' frame per vsync, tiene solo l'ultimo e scarta gli altri.
  var pending = null, rafId = 0, mode = null;

  function flush(){
    rafId = 0;
    var bitmap = pending; pending = null;
    if (!bitmap) return;
    frameCount++;
    window.__kbMirrorBmp = { w: bitmap.width, h: bitmap.height };
    var m = ensureMirror();
    if (!m) { try { bitmap.close(); } catch(e){} return; }
    if (frameCount <= 3 || frameCount % 300 === 0) console.log('[mirror-main] frame ' + frameCount + ' bmp=' + bitmap.width + 'x' + bitmap.height + ' mode=' + mode);
    if (mode === null) {
      var br = null;
      try { br = m.getContext('bitmaprenderer'); } catch(e){}
      if (br) { m.__br = br; mode = 'bitmaprenderer'; }
      else { m.__c2d = m.getContext('2d', { alpha: false, desynchronized: true }); mode = '2d'; }
    }
    try {
      if (mode === 'bitmaprenderer') {
        m.__br.transferFromImageBitmap(bitmap);   // zero-copy, il bitmap viene ceduto al canvas
        return;
      }
      if (m.width !== bitmap.width || m.height !== bitmap.height) { m.width = bitmap.width; m.height = bitmap.height; }
      m.__c2d.drawImage(bitmap, 0, 0, m.width, m.height);
    } catch(e) {
      console.log('[mirror-main] draw FAIL (' + mode + '): ' + e.message);
    }
    try { bitmap.close(); } catch(e){}
  }

  function drawFrame(bitmap){
    if (pending) { try { pending.close(); } catch(e){} }
    pending = bitmap;
    if (!rafId) rafId = requestAnimationFrame(flush);
  }

  window.__kbSetGamma = function(v) {
    var val = parseFloat(v) || 1.0;
    var m = document.getElementById('mirror');
    if (m) {
      if (val === 1.0) m.style.filter = '';
      else m.style.filter = 'brightness(' + val + ')';
    }
    try { localStorage.setItem('__kbGamma', String(val)); } catch(e){}
  };

  var OrigWorker = window.Worker;
  window.Worker = function(url, opts){
    var w = new OrigWorker(url, opts);
    w.addEventListener('message', function(e){
      if (!e.data) return;
      if (e.data.type === 'kb_frame' && e.data.bitmap) {
        e.stopImmediatePropagation();
        drawFrame(e.data.bitmap);
      } else if (e.data.type === 'kb_log') {
        e.stopImmediatePropagation();
        try { console.log(e.data.msg); } catch(err){}
      }
    }, true);
    return w;
  };
  window.Worker.prototype = OrigWorker.prototype;

  console.log('[mirror-main] installed');
})();
