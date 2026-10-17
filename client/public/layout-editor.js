(function(){
  if (window.__kbLayoutEditorInstalled) return;
  window.__kbLayoutEditorInstalled = true;

  var LAYOUT_KEY = '__kbLayout';
  var btns = [];
  var savedLayout = {};
  var editMode = false;
  var selectedBtn = null;
  var editUI = null;
  var activeDragId = null;  // FIX: un solo drag alla volta

  try { savedLayout = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'); } catch(e){ savedLayout = {}; }

  // Applica layout salvato a un pulsante
  function applyLayout(el, cfg) {
    if (!cfg) return;
    if (cfg.x == null || cfg.y == null) return;
    var sc = cfg.scale || 1;

    // PATCH v1.33: reset transform per leggere dimensione BASE reale (non scalata)
    el.style.transform = '';
    el.style.transformOrigin = 'top left';
    var baseW = el.offsetWidth || 60;
    var baseH = el.offsetHeight || 60;
    el.style.transform = 'scale(' + sc + ')';
    el.dataset.scale = String(sc);

    // Centro VISIVO = (x * vw, y * vh)
    // Con transform-origin top-left, il box visivo parte da (left, top) e misura (baseW*sc, baseH*sc)
    var cx = cfg.x * window.innerWidth;
    var cy = cfg.y * window.innerHeight;
    var left = cx - (baseW * sc) / 2;
    var top = cy - (baseH * sc) / 2;
    el.style.left = (left / window.innerWidth * 100).toFixed(3) + 'vw';
    el.style.top = (top / window.innerHeight * 100).toFixed(3) + 'vh';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  // PATCH v1.33: riapplica layout quando cambia viewport (fullscreen, rotazione, resize)
  function reapplyAll() {
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (savedLayout[b.id]) applyLayout(b.el, savedLayout[b.id]);
    }
  }
  window.addEventListener('resize', function(){ setTimeout(reapplyAll, 100); });
  window.addEventListener('orientationchange', function(){ setTimeout(reapplyAll, 400); });
  document.addEventListener('fullscreenchange', function(){ setTimeout(reapplyAll, 400); });
  document.addEventListener('webkitfullscreenchange', function(){ setTimeout(reapplyAll, 400); });

  // Registrazione pulsante (chiamata da touch-test.js)
  window.__kbRegisterBtn = function(el, id, defaultCfg, baseSize){
    if (!id) id = 'btn_' + btns.length;
    el.dataset.layoutId = id;
    el.dataset.baseSize = baseSize || el.offsetWidth;
    el.dataset.defaultCfg = JSON.stringify(defaultCfg || {});
    btns.push({ el: el, id: id, baseSize: baseSize || el.offsetWidth });
    // Applica layout salvato se esiste
    if (savedLayout[id]) applyLayout(el, savedLayout[id]);
  };

  function saveLayout() {
    var out = {};
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var r = b.el.getBoundingClientRect();
      var vw = window.innerWidth, vh = window.innerHeight;
      var scale = b.el.dataset.scale ? parseFloat(b.el.dataset.scale) : 1;
      // getBoundingClientRect restituisce le dimensioni GIA' scalate
      // Quindi il centro visivo e' r.left + r.width/2
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      out[b.id] = {
        x: cx / vw,
        y: cy / vh,
        scale: scale
      };
    }
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(out)); } catch(e){}
    savedLayout = out;
    console.log('[layout-editor] saved ' + btns.length + ' buttons');
  }

  function resetLayout() {
    try { localStorage.removeItem(LAYOUT_KEY); } catch(e){}
    savedLayout = {};
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var def = {};
      try { def = JSON.parse(b.el.dataset.defaultCfg || '{}'); } catch(e){}
      // Ripristina stile originale
      b.el.style.left = '';
      b.el.style.top = '';
      b.el.style.right = '';
      b.el.style.bottom = '';
      b.el.style.transform = '';
      if (def.right != null) b.el.style.right = def.right + 'px';
      if (def.left != null) b.el.style.left = def.left + 'px';
      if (def.top != null) b.el.style.top = def.top + 'px';
      if (def.bottom != null) b.el.style.bottom = def.bottom + 'px';
      var sc = b.el.dataset.baseSize || b.baseSize;
      b.el.style.width = sc + 'px';
      b.el.style.height = sc + 'px';
      b.el.dataset.scale = '1';
    }
  }

  // === DRAG NATIVO con touchstart/touchmove/touchend ===
  function deselectAll() {
    for (var i = 0; i < btns.length; i++) {
      var el = btns[i].el;
      var origBorder = el.dataset.origBorder;
      if (origBorder != null) {
        el.style.setProperty('border', origBorder, 'important');
      } else {
        el.style.removeProperty('border');
      }
    }
  }

  function startDrag(e) {
    if (!editMode) return;
    // FIX: se c'e' gia' un drag attivo, ignora questo touchstart
    if (activeDragId !== null) return;
    var t = e.changedTouches ? e.changedTouches[0] : e;
    var el = e.currentTarget;
    var id = t.identifier;
    activeDragId = id;

    // FIX 1: deseleziona tutti gli altri
    deselectAll();
    selectedBtn = el;
    // Salva bordo originale (la prima volta)
    if (el.dataset.origBorder == null) {
      var cs = window.getComputedStyle(el);
      el.dataset.origBorder = cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor;
    }
    el.style.setProperty('border', '3px solid #ff0', 'important');

    // FIX 2: offset dal CENTRO del pulsante (in coordinate schermo)
    var r = el.getBoundingClientRect();
    var centerX = r.left + r.width / 2;
    var centerY = r.top + r.height / 2;
    var offsetX = t.clientX - centerX;
    var offsetY = t.clientY - centerY;

    function onMove(ev) {
      var tt = null;
      for (var i = 0; i < ev.touches.length; i++) if (ev.touches[i].identifier === id) { tt = ev.touches[i]; break; }
      if (!tt) return;
      ev.preventDefault();

      // FIX 2: il nuovo centro e' dove e' il dito meno l'offset iniziale
      var newCenterX = tt.clientX - offsetX;
      var newCenterY = tt.clientY - offsetY;

      // Converti centro in left/top dello spazio del pulsante
      var w = el.offsetWidth, h = el.offsetHeight;
      var nx = newCenterX - w / 2;
      var ny = newCenterY - h / 2;

      el.style.left = (nx / window.innerWidth * 100).toFixed(2) + 'vw';
      el.style.top = (ny / window.innerHeight * 100).toFixed(2) + 'vh';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.transformOrigin = 'top left';
    }
    function onEnd(ev) {
      for (var i = 0; i < ev.changedTouches.length; i++) {
        if (ev.changedTouches[i].identifier === id) {
          document.removeEventListener('touchmove', onMove);
          document.removeEventListener('touchend', onEnd);
          document.removeEventListener('touchcancel', onEnd);
          activeDragId = null;  // FIX: libera per il prossimo drag
          return;
        }
      }
    }
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: false });
    document.addEventListener('touchcancel', onEnd, { passive: false });
  }

  function scaleSelected(delta) {
    if (!selectedBtn) return;
    var cur = parseFloat(selectedBtn.dataset.scale || '1');
    var next = Math.max(0.5, Math.min(2.5, cur + delta));
    selectedBtn.dataset.scale = String(next);
    selectedBtn.style.transformOrigin = 'top left';
    selectedBtn.style.transform = 'scale(' + next + ')';
  }

  function setEditMode(on) {
    editMode = on;
    for (var i = 0; i < btns.length; i++) {
      var el = btns[i].el;
      if (on) {
        el.addEventListener('touchstart', startDrag, { passive: false });
        el.style.cursor = 'move';
      } else {
        el.removeEventListener('touchstart', startDrag);
        el.style.cursor = '';
        var origBorder = el.dataset.origBorder;
        if (origBorder != null) {
          el.style.setProperty('border', origBorder, 'important');
        } else {
          el.style.removeProperty('border');
        }
      }
    }
    if (on) {
      showEditUI();
    } else {
      hideEditUI();
      selectedBtn = null;
    }
  }

  var collapsed = false;
  function showEditUI() {
    if (editUI) { editUI.remove(); editUI = null; }
    var ui = document.createElement('div');
    ui.id = '__kbLayoutUI';
    ui.style.cssText = 'position:fixed!important;top:5px!important;right:5px!important;z-index:2147483647!important;background:rgba(0,0,0,0.6)!important;display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:6px!important;padding:6px!important;font-family:monospace!important;pointer-events:none!important;border-radius:10px!important;';
    ui.innerHTML =
      '<button id="__kbBtnCollapse" style="width:44px!important;height:44px!important;background:#333!important;color:#fff!important;border:2px solid #0ff!important;border-radius:8px!important;font-size:20px!important;font-weight:bold!important;cursor:pointer!important;pointer-events:auto!important;">▼</button>' +
      '<div id="__kbExpandContent" style="display:flex!important;gap:6px!important;align-items:center!important;">' +
        '<button id="__kbBtnMinus" style="width:44px!important;height:44px!important;background:#046!important;color:#fff!important;border:2px solid #0ff!important;border-radius:8px!important;font-size:24px!important;font-weight:bold!important;cursor:pointer!important;pointer-events:auto!important;">−</button>' +
        '<span style="color:#0f0!important;font-size:12px!important;min-width:44px!important;text-align:center!important;" id="__kbScaleLabel">100%</span>' +
        '<button id="__kbBtnPlus" style="width:44px!important;height:44px!important;background:#046!important;color:#fff!important;border:2px solid #0ff!important;border-radius:8px!important;font-size:24px!important;font-weight:bold!important;cursor:pointer!important;pointer-events:auto!important;">+</button>' +
        '<button id="__kbBtnSave" style="padding:0 14px!important;height:44px!important;background:#0a0!important;color:#fff!important;border:2px solid #0f0!important;border-radius:8px!important;font-size:14px!important;font-weight:bold!important;cursor:pointer!important;pointer-events:auto!important;">SALVA</button>' +
        '<button id="__kbBtnReset" style="padding:0 14px!important;height:44px!important;background:#a50!important;color:#fff!important;border:2px solid #fa0!important;border-radius:8px!important;font-size:14px!important;font-weight:bold!important;cursor:pointer!important;pointer-events:auto!important;">RESET</button>' +
        '<button id="__kbBtnClose" style="padding:0 14px!important;height:44px!important;background:#a00!important;color:#fff!important;border:2px solid #f00!important;border-radius:8px!important;font-size:14px!important;font-weight:bold!important;cursor:pointer!important;pointer-events:auto!important;">ESCI</button>' +
      '</div>';
    document.documentElement.appendChild(ui);
    editUI = ui;

    // Toggle collapse
    var collapseBtn = ui.querySelector('#__kbBtnCollapse');
    var contentDiv = ui.querySelector('#__kbExpandContent');
    collapsed = false;
    function toggleCollapse() {
      collapsed = !collapsed;
      contentDiv.style.display = collapsed ? 'none' : 'flex';
      collapseBtn.textContent = collapsed ? '▶' : '▼';
    }
    collapseBtn.addEventListener('touchstart', function(e){ e.preventDefault(); e.stopPropagation(); toggleCollapse(); }, { passive: false });
    collapseBtn.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); toggleCollapse(); });

    function attach(id, fn) {
      var el = ui.querySelector('#' + id);
      el.addEventListener('touchstart', function(e){ e.preventDefault(); e.stopPropagation(); fn(); }, { passive: false });
      el.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); fn(); });
    }
    attach('__kbBtnMinus', function(){ scaleSelected(-0.1); updateLabel(); });
    attach('__kbBtnPlus',  function(){ scaleSelected( 0.1); updateLabel(); });
    attach('__kbBtnSave',  function(){
      saveLayout();
      var saveBtnEl = ui.querySelector('#__kbBtnSave');
      if (saveBtnEl) {
        saveBtnEl.textContent = 'OK!';
        saveBtnEl.style.background = '#0f0';
        setTimeout(function(){
          saveBtnEl.textContent = 'SALVA';
          saveBtnEl.style.background = '#0a0';
        }, 600);
      }
    });
    attach('__kbBtnReset', function(){ resetLayout(); });
    attach('__kbBtnClose', function(){ setEditMode(false); });
    function updateLabel() {
      var lbl = ui.querySelector('#__kbScaleLabel');
      var cur = selectedBtn ? parseFloat(selectedBtn.dataset.scale || '1') : 1;
      lbl.textContent = Math.round(cur * 100) + '%';
    }
  }

  function hideEditUI() {
    if (editUI) { editUI.remove(); editUI = null; }
  }

  // Espone per il pannello impostazioni
  window.__kbOpenLayoutEditor = function() { setEditMode(true); };

  console.log('[layout-editor] installato');
})();
