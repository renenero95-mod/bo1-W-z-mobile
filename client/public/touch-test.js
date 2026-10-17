(function(){
  if (window.__kbTouchInstalled) return;
  window.__kbTouchInstalled = true;

  function isTouch(){
    return typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);
  }
  if (!isTouch()) return;

  var K_KEY = 0, K_MOUSE = 2, K_CURSOR = 4;
  var K = {
    W:119, A:97, S:115, D:100,
    SPACE:32, R:114, F:102, V:118, G:103,
    C:99, Z:122, SHIFT:160, CTRL:159, TAB:9, ESC:27, D1:49, D2:50
  };
  var M = { LEFT:200, RIGHT:201 };

  // --- Carica impostazioni da localStorage ---
  var S = {
    sens: 3.0,
    btnSize: 1.0,
    btnOpacity: 0.85,
    vibrate: false
  };
  try {
    var saved = JSON.parse(localStorage.getItem('__kbTouchSettings') || '{}');
    if (saved.sens) S.sens = saved.sens;
    if (saved.btnSize) S.btnSize = saved.btnSize;
    if (saved.btnOpacity) S.btnOpacity = saved.btnOpacity;
    if (typeof saved.vibrate === 'boolean') S.vibrate = saved.vibrate;
  } catch(e){}
  function saveSettings(){
    try { localStorage.setItem('__kbTouchSettings', JSON.stringify(S)); } catch(e){}
  }
  function vib(ms){
    if (!S.vibrate) return;
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch(e){}
  }

  // PATCH: pulizia risoluzioni sotto il minimo del motore
  try {
    var mw = parseInt(localStorage.getItem('__kbMaxWidth') || '0', 10);
    if (mw > 0 && mw < 800) localStorage.setItem('__kbMaxWidth', '800');
  } catch(e){}

  var tries = 0;
  var timer = setInterval(function(){
    tries++;
    if (tries > 240) { clearInterval(timer); return; }
    var m = window.__kbModule;
    if (m && typeof m._KB_Input === 'function') {
      clearInterval(timer);
      installUI(m);
    }
  }, 500);

  function installUI(module){
    var activeKeys = {};

    function sendKey(code, down){
      var has = activeKeys[code];
      if (down && has) return;
      if (!down && !has) return;
      if (down) activeKeys[code] = true; else delete activeKeys[code];
      try { module._KB_Input(K_KEY, code, down ? 1 : 0); } catch(e){}
    }
    function sendMouseMove(dx, dy){
      try { module._KB_Input(K_MOUSE, Math.round(dx), Math.round(dy)); } catch(e){}
    }
    function sendCursor(x, y){
      try { module._KB_Input(K_CURSOR, Math.round(x), Math.round(y)); } catch(e){}
    }
    function sendMouseBtn(btn, down){
      try { module._KB_Input(K_KEY, btn, down ? 1 : 0); } catch(e){}
    }
    function isMenuOpen(){
      try { return Boolean(module._KB_UIState && (module._KB_UIState() & 1)); } catch(e){ return false; }
    }
    function viewToCursor(clientX, clientY){
      // Il motore mappa il cursor a 640x480 internamente
      var w = window.innerWidth, h = window.innerHeight; var b = window.__kbMirrorBmp || { w: 640, h: 480 }; var sc = Math.min(w / b.w, h / b.h); var ox = (w - b.w * sc) / 2, oy = (h - b.h * sc) / 2; var bx = (clientX - ox) / sc, by = (clientY - oy) / sc; var x = Math.max(0, Math.min(640, Math.round(bx * 640 / b.w))); var y = Math.max(0, Math.min(480, Math.round(by * 480 / b.h))); return { x: x, y: y };
    }

    // ============ MENU IMPOSTAZIONI ============
    var settingsPanel = null;
    function openSettings(){
      if (settingsPanel) { settingsPanel.remove(); settingsPanel = null; return; }

      var panel = document.createElement('div');
      panel.id = '__kbSettingsPanel';
      panel.style.cssText = 'position:fixed!important;left:0!important;top:0!important;right:0!important;bottom:0!important;z-index:2147483647!important;background:rgba(0,0,0,0.88)!important;color:#fff!important;font-family:monospace!important;font-size:14px!important;padding:24px!important;overflow:auto!important;';

      var html = '';
      html += '<h2 style="color:#e00;text-align:center;margin:0 0 24px;">IMPOSTAZIONI</h2>';
      html += '<div style="max-width:500px;margin:0 auto;">';

      html += '<label style="display:block;margin:20px 0 8px;">Sensibilit\u00e0 mira: <b id="kbSensVal">' + S.sens.toFixed(2) + '</b></label>';
      html += '<input id="kbSens" type="range" min="0.5" max="8" step="0.1" value="' + S.sens + '" style="width:100%;height:32px;">';

      html += '<label style="display:block;margin:20px 0 8px;">Dimensione tasti: <b id="kbSizeVal">' + S.btnSize.toFixed(2) + '</b></label>';
      html += '<input id="kbSize" type="range" min="0.6" max="1.6" step="0.05" value="' + S.btnSize + '" style="width:100%;height:32px;">';

      html += '<label style="display:block;margin:20px 0 8px;">Opacit\u00e0 tasti: <b id="kbOpVal">' + S.btnOpacity.toFixed(2) + '</b></label>';
      html += '<input id="kbOp" type="range" min="0.2" max="1" step="0.05" value="' + S.btnOpacity + '" style="width:100%;height:32px;">';

      var currentMaxW = parseInt(localStorage.getItem('__kbMaxWidth') || '0', 10);
      var resOptions = [
        { label: 'Alta (Auto 1920px)', value: '0' },
        { label: 'Media (1440px)', value: '1440' },
        { label: 'Bassa (1080px)', value: '1080' },
        { label: 'Minima (800px)', value: '800' }
      ];
      html += '<label style="display:block;margin:20px 0 8px;">Risoluzione: <b id="kbResVal">' + (currentMaxW > 0 ? currentMaxW + 'px' : 'Auto') + '</b></label>';
      html += '<select id="kbRes" style="width:100%;padding:12px;font-size:14px;font-family:monospace;background:#111;color:#fff;border:2px solid #0ff;border-radius:6px;">';
      for (var ri = 0; ri < resOptions.length; ri++) {
        var sel = (String(currentMaxW) === resOptions[ri].value) ? ' selected' : '';
        html += '<option value="' + resOptions[ri].value + '"' + sel + '>' + resOptions[ri].label + '</option>';
      }
      html += '</select>';
      html += '<div style="font-size:11px;opacity:0.6;margin-top:4px;font-family:monospace;">La risoluzione si applica al prossimo reload</div>';

      html += '<label style="display:block;margin:20px 0 8px;"><input id="kbVib" type="checkbox" ' + (S.vibrate ? 'checked' : '') + ' style="width:24px;height:24px;vertical-align:middle;"> Vibrazione</label>';

      html += '<div style="display:flex;gap:8px;margin:24px 0 8px;">';
      html += '<button id="kbSaveLog" style="flex:1;padding:14px;background:#046;color:#fff;border:2px solid #0ff;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;font-family:monospace;">SALVA LOG</button>';
      html += '<button id="kbClearLog" style="flex:1;padding:14px;background:#600;color:#fff;border:2px solid #f00;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;font-family:monospace;">CANCELLA LOG</button>';
      html += '</div>';

      // GAMMA slider
      var currentGamma = parseFloat(localStorage.getItem('__kbGamma') || '1.0');
      html += '<label style="display:block;margin:20px 0 8px;">Gamma: <b id="kbGammaVal">' + currentGamma.toFixed(2) + '</b></label>';
      html += '<input id="kbGamma" type="range" min="0.5" max="2.5" step="0.05" value="' + currentGamma + '" style="width:100%;height:32px;">';
      html += '<div style="font-size:11px;opacity:0.65;margin-top:4px;font-family:monospace;text-align:center;color:#fc0;">Quick overlay fix only. For permanent brightness change, use the in-game OPTIONS menu.</div>';

      html += '<button id="kbEditLayout" style="display:block;width:100%;margin:8px 0;padding:16px;background:#a50;color:#fff;border:2px solid #fa0;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;font-family:monospace;">⚠ PERSONALIZZA LAYOUT TOUCH</button>';
      html += '<button id="kbFullscreen" style="display:block;width:100%;margin:8px 0;padding:16px;background:#046;color:#fff;border:2px solid #0ff;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer;font-family:monospace;">SCHERMO INTERO</button>';
      html += '<div style="font-size:11px;opacity:0.65;margin:2px 0 8px;font-family:monospace;text-align:center;">Use only if game exits fullscreen</div>';
      html += '<button id="kbClose" style="display:block;width:100%;margin:8px 0;padding:16px;background:#a00;color:#fff;border:2px solid #f00;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer;font-family:monospace;">CHIUDI</button>';

      html += '</div>';
      panel.innerHTML = html;
      document.documentElement.appendChild(panel);
      settingsPanel = panel;

      panel.querySelector('#kbSens').addEventListener('input', function(e){
        S.sens = parseFloat(e.target.value);
        panel.querySelector('#kbSensVal').textContent = S.sens.toFixed(2);
        saveSettings();
      });
      panel.querySelector('#kbSize').addEventListener('input', function(e){
        S.btnSize = parseFloat(e.target.value);
        panel.querySelector('#kbSizeVal').textContent = S.btnSize.toFixed(2);
        saveSettings();
        applySize();
      });
      panel.querySelector('#kbOp').addEventListener('input', function(e){
        S.btnOpacity = parseFloat(e.target.value);
        panel.querySelector('#kbOpVal').textContent = S.btnOpacity.toFixed(2);
        saveSettings();
        applyOpacity();
      });
      panel.querySelector('#kbVib').addEventListener('change', function(e){
        S.vibrate = e.target.checked;
        saveSettings();
      });
      panel.querySelector('#kbRes').addEventListener('change', function(e){
        try { localStorage.setItem('__kbMaxWidth', e.target.value); } catch(err){}
        panel.querySelector('#kbResVal').textContent = e.target.value === '0' ? 'Auto' : e.target.value + 'px';
      });
      panel.querySelector('#kbSaveLog').addEventListener('click', function(){
        if (typeof window.__kbLogSave === 'function') window.__kbLogSave();
      });
      panel.querySelector('#kbClearLog').addEventListener('click', function(){
        if (typeof window.__kbLogClear === 'function') window.__kbLogClear();
      });
      panel.querySelector('#kbGamma').addEventListener('input', function(e){
        var g = parseFloat(e.target.value);
        panel.querySelector('#kbGammaVal').textContent = g.toFixed(2);
        if (typeof window.__kbSetGamma === 'function') window.__kbSetGamma(g);
        else try { localStorage.setItem('__kbGamma', String(g)); } catch(err){}
      });
      panel.querySelector('#kbEditLayout').addEventListener('click', function(){
        // Chiudi pannello e apri editor
        panel.remove();
        settingsPanel = null;
        if (window.__kbOpenLayoutEditor) window.__kbOpenLayoutEditor();
      });
      panel.querySelector('#kbFullscreen').addEventListener('click', function(){
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
        } else {
          document.exitFullscreen && document.exitFullscreen();
        }
      });
      panel.querySelector('#kbClose').addEventListener('click', function(){
        panel.remove();
        settingsPanel = null;
      });
    }

    var allBtns = [];  // per applySize/applyOpacity
    function applySize(){
      allBtns.forEach(function(b){
        if (!b.dataset.baseSize) return;
        var size = Math.round(parseFloat(b.dataset.baseSize) * S.btnSize);
        b.style.width = size + 'px';
        b.style.height = size + 'px';
        b.style.fontSize = Math.max(9, Math.round(size / 5.5)) + 'px';
      });
    }
    function applyOpacity(){
      allBtns.forEach(function(b){ b.style.opacity = S.btnOpacity; });
    }

    function makeBtn(opts){
      var b = document.createElement('button');
      b.textContent = opts.label || '';
      var pos = [];
      if (opts.right != null) pos.push('right:' + opts.right + 'px!important');
      if (opts.left  != null) pos.push('left:'  + opts.left  + 'px!important');
      if (opts.top   != null) pos.push('top:'   + opts.top   + 'px!important');
      if (opts.bottom!= null) pos.push('bottom:'+ opts.bottom+ 'px!important');
      var baseSize = Math.round((opts.size || 60) * S.btnSize);
      b.dataset.baseSize = opts.size || 60;
      b.style.cssText = 'position:fixed!important;' + pos.join(';') + ';'
        + 'width:' + baseSize + 'px!important;height:' + baseSize + 'px!important;'
        + 'z-index:2147483646!important;background:' + (opts.color || '#333') + '!important;'
        + 'color:#fff!important;border:2px solid rgba(255,255,255,0.7)!important;'
        + 'border-radius:' + (opts.round === false ? '10px' : '50%') + '!important;'
        + 'font-size:' + Math.max(9, Math.round(baseSize / 5.5)) + 'px!important;'
        + 'font-weight:bold!important;font-family:monospace!important;'
        + 'cursor:pointer!important;pointer-events:auto!important;opacity:' + S.btnOpacity + '!important;'
        + 'touch-action:none!important;user-select:none!important;padding:0!important;line-height:1!important;';

      // CRCH: tap = crouch (Ctrl 159), long press = prone (Z 122)
      var isCrch = opts.label === 'CRCH';
      var crchTimer = null, crchProne = false;

      function down(e){
        e.preventDefault(); e.stopPropagation();
        vib(15);
        if (isCrch) {
          sendKey(K.CTRL, true);
          crchProne = false;
          crchTimer = setTimeout(function(){
            crchProne = true;
            sendKey(K.CTRL, false);
            sendKey(K.Z, true);
          }, 500);
        } else {
          sendKey(opts.key, true);
        }
      }
      function up(e){
        e.preventDefault(); e.stopPropagation();
        if (isCrch) {
          if (crchTimer) { clearTimeout(crchTimer); crchTimer = null; }
          if (crchProne) sendKey(K.Z, false);
          else sendKey(K.CTRL, false);
          crchProne = false;
        } else {
          sendKey(opts.key, false);
        }
      }
      if (opts.allowLook) {
        // PATCH v1.25.1: pointer events per FIRE + look (muovi dito = ruota visuale)
        var pId = null, pLast = null;
        b.addEventListener('pointerdown', function(e){
          e.preventDefault(); e.stopPropagation();
          vib(15);
          sendKey(opts.key, true);
          if (e.pointerId !== undefined) {
            pId = e.pointerId;
            pLast = { x: e.clientX, y: e.clientY };
            try { b.setPointerCapture(e.pointerId); } catch(err){}
          }
        }, { passive: false });
        b.addEventListener('pointermove', function(e){
          if (pId === null || e.pointerId !== pId) return;
          e.preventDefault();
          var dx = (e.clientX - pLast.x) * S.sens;
          var dy = (e.clientY - pLast.y) * S.sens;
          pLast = { x: e.clientX, y: e.clientY };
          if (dx || dy) sendMouseMove(dx, dy);
        }, { passive: false });
        b.addEventListener('pointerup', function(e){
          if (pId === null || e.pointerId !== pId) return;
          sendKey(opts.key, false);
          try { b.releasePointerCapture(e.pointerId); } catch(err){}
          pId = null;
        }, { passive: false });
        b.addEventListener('pointercancel', function(e){
          if (pId === null || e.pointerId !== pId) return;
          sendKey(opts.key, false);
          pId = null;
        }, { passive: false });
      } else {
        b.addEventListener('touchstart', down, { passive: false });
        b.addEventListener('touchend', up, { passive: false });
        b.addEventListener('touchcancel', up, { passive: false });
        b.addEventListener('mousedown', down);
        b.addEventListener('mouseup', up);
      }
      b.addEventListener('contextmenu', function(e){ e.preventDefault(); });
      document.documentElement.appendChild(b);
      allBtns.push(b);
      // LAYOUT EDITOR: registra per il layout personalizzato
      if (window.__kbRegisterBtn) window.__kbRegisterBtn(b, opts.label, { right: opts.right, left: opts.left, top: opts.top, bottom: opts.bottom, size: baseSize });
      return b;
    }

    // ============ JOYSTICK ============
    var jSize = 140, knobSize = 40;  // FIX v1.30.2: knob piu' piccolo, piu' corsa
    var joystick = document.createElement('div');
    joystick.style.cssText = 'position:fixed!important;left:20px!important;bottom:20px!important;width:' + jSize + 'px!important;height:' + jSize + 'px!important;z-index:2147483646!important;background:rgba(0,50,80,0.35)!important;border:2px solid rgba(255,255,255,0.5)!important;border-radius:50%!important;touch-action:none!important;user-select:none!important;';
    var knob = document.createElement('div');
    knob.style.cssText = 'position:absolute!important;left:' + ((jSize-knobSize)/2) + 'px!important;top:' + ((jSize-knobSize)/2) + 'px!important;width:' + knobSize + 'px!important;height:' + knobSize + 'px!important;background:rgba(255,255,255,0.55)!important;border-radius:50%!important;pointer-events:none!important;';
    joystick.appendChild(knob);
    document.documentElement.appendChild(joystick);
    if (window.__kbRegisterBtn) window.__kbRegisterBtn(joystick, 'JOYSTICK', { left: 20, bottom: 20, size: jSize }, jSize);

    var jActive = false, jId = null, jStart = null, jMove = { x:0, y:0 };
    function updateJMove(){
      var threshold = 15;
      var dist = Math.sqrt(jMove.x*jMove.x + jMove.y*jMove.y);
      if (dist < threshold) {
        sendKey(K.W, false); sendKey(K.A, false); sendKey(K.S, false); sendKey(K.D, false);
        sendKey(K.SHIFT, false);
        return;
      }
      var nx = jMove.x / dist, ny = jMove.y / dist;
      sendKey(K.W, ny < -0.3);
      sendKey(K.S, ny >  0.3);
      sendKey(K.A, nx < -0.3);
      sendKey(K.D, nx >  0.3);
      // PATCH v1.30.1: sprint in qualsiasi direzione oltre il 95% del raggio
      var maxR = (jSize - knobSize) / 2;
      var sprintThreshold = maxR * 0.95;
      sendKey(K.SHIFT, dist > sprintThreshold);
    }
    function jStartH(e){
      e.preventDefault(); e.stopPropagation();
      var t = e.changedTouches ? e.changedTouches[0] : e;
      jActive = true; jId = t.identifier != null ? t.identifier : 'mouse';
      var r = joystick.getBoundingClientRect();
      jStart = { x: r.left + r.width/2, y: r.top + r.height/2 };
      jMoveKnob(t.clientX, t.clientY);
    }
    function jMoveH(e){
      if (!jActive) return;
      e.preventDefault();
      var t;
      if (e.changedTouches) {
        for (var i = 0; i < e.changedTouches.length; i++)
          if (e.changedTouches[i].identifier === jId) { t = e.changedTouches[i]; break; }
        if (!t) return;
      } else t = e;
      jMoveKnob(t.clientX, t.clientY);
    }
    function jEndH(e){
      if (!jActive) return;
      jActive = false; jId = null;
      knob.style.left = ((jSize-knobSize)/2) + 'px';
      knob.style.top  = ((jSize-knobSize)/2) + 'px';
      jMove = { x:0, y:0 };
      updateJMove();
    }
    function jMoveKnob(cx, cy){
      var dx = cx - jStart.x, dy = cy - jStart.y;
      var maxR = (jSize - knobSize) / 2;
      var dist = Math.sqrt(dx*dx + dy*dy);
      if (dist > maxR) { dx = dx * maxR / dist; dy = dy * maxR / dist; }
      knob.style.left = ((jSize-knobSize)/2 + dx) + 'px';
      knob.style.top  = ((jSize-knobSize)/2 + dy) + 'px';
      jMove = { x:dx, y:dy };
      updateJMove();
    }
    joystick.addEventListener('touchstart',  jStartH, { passive: false });
    joystick.addEventListener('touchmove',   jMoveH,  { passive: false });
    joystick.addEventListener('touchend',    jEndH,   { passive: false });
    joystick.addEventListener('touchcancel', jEndH,   { passive: false });

    // ============ LOOK AREA con fix menu ============
    var lookArea = document.createElement('div');
    lookArea.style.cssText = 'position:fixed!important;right:0!important;top:0!important;width:50%!important;height:100%!important;z-index:2147483645!important;touch-action:none!important;user-select:none!important;pointer-events:auto!important;';
    document.documentElement.appendChild(lookArea);

    var lookActive = false, lookId = null, lookLast = null;

    function lStartH(e){
      e.preventDefault(); e.stopPropagation();
      var t = e.changedTouches ? e.changedTouches[0] : e;

      // FIX v1.3: se il menu e' aperto, invia cursor + click (non mouse move)
      if (isMenuOpen()) {
        var c = viewToCursor(t.clientX, t.clientY);
        sendCursor(c.x, c.y);
        sendMouseBtn(M.LEFT, true);
        // Auto-rilascio dopo un tick (per garantire click singolo)
        setTimeout(function(){ sendMouseBtn(M.LEFT, false); }, 50);
        return;
      }

      lookActive = true;
      lookId = t.identifier != null ? t.identifier : 'mouse';
      lookLast = { x: t.clientX, y: t.clientY };
    }
    function lMoveH(e){
      if (!lookActive) return;
      e.preventDefault();
      var t;
      if (e.changedTouches) {
        for (var i = 0; i < e.changedTouches.length; i++)
          if (e.changedTouches[i].identifier === lookId) { t = e.changedTouches[i]; break; }
        if (!t) return;
      } else t = e;
      var dx = (t.clientX - lookLast.x) * S.sens;
      var dy = (t.clientY - lookLast.y) * S.sens;
      lookLast = { x: t.clientX, y: t.clientY };
      if (dx || dy) sendMouseMove(dx, dy);
    }
    function lEndH(e){
      if (!lookActive) return;
      lookActive = false; lookId = null;
    }
    lookArea.addEventListener('touchstart',  lStartH, { passive: false });
    lookArea.addEventListener('touchmove',   lMoveH,  { passive: false });
    lookArea.addEventListener('touchend',    lEndH,   { passive: false });
    lookArea.addEventListener('touchcancel', lEndH,   { passive: false });

    // ============ BOTTONI ============
    makeBtn({ label:'FIRE',   key:M.LEFT,  right:20,  bottom:20,  size:95, color:'#a00', fs:14, allowLook:true });
    makeBtn({ label:'MIRA',   key:M.RIGHT, right:130, bottom:20,  size:75, color:'#046', fs:12 });
    makeBtn({ label:'SALTA',  key:K.SPACE, right:20,  bottom:130, size:75, color:'#444', fs:13 });
    makeBtn({ label:'RICARICA', key:K.R,   right:230, bottom:20,  size:65, color:'#666', fs:10 });
    makeBtn({ label:'COLTELLO', key:K.V,   right:120, bottom:120, size:65, color:'#802', fs:9 });
    makeBtn({ label:'USA',    key:K.F,     right:210, bottom:110, size:70, color:'#063', fs:12 });
    makeBtn({ label:'GRANATA', key:K.G,    right:20,  bottom:225, size:60, color:'#660', fs:9 });
    makeBtn({ label:'ARMA',   key:K.D1,    right:100, bottom:200, size:60, color:'#456', fs:11 });
    makeBtn({ label:'CRCH',   key:K.C,     left:175,  bottom:20,  size:60, color:'#444', fs:11 });

    makeBtn({ label:'PAUSA',  key:K.ESC,   left:20,   top:20,     size:55, color:'#333', fs:11 });

    // ============ TOGGLE MENU/GIOCO ============
    var menuMode = false;
    var overlayIds = [];

    function applyMenuMode(){
      // Raccogli TUTTI gli elementi overlay touch (bottoni, joystick, look)
      var overlays = [joystick, lookArea].concat(allBtns);
      var gear = document.querySelector('#__kbGearBtn');
      var toggle = document.querySelector('#__kbToggleMenuBtn');
      var settings = document.querySelector('#__kbSettingsPanel');
      if (gear) overlays.push(gear);
      if (toggle) overlays.push(toggle);
      // Non tocchiamo settings panel se aperto
      overlays.forEach(function(el){
        if (!el) return;
        if (menuMode) {
          el.style.display = 'none';
        } else {
          el.style.display = el.tagName === 'DIV' && el === joystick ? 'block' : (el === lookArea ? 'block' : '');
          if (el === joystick) el.style.display = 'block';
          if (el === lookArea) el.style.display = 'block';
          if (el.tagName === 'BUTTON' && el !== gear && el !== toggle) el.style.display = 'inline-block';
        }
      });
      if (gear) gear.style.display = 'inline-block';
      if (toggle) toggle.style.display = 'inline-block';
      if (settings) settings.style.display = '';

      // Cambia testo toggle
      if (toggle) {
        toggle.textContent = menuMode ? '\u25B6 GIOCO' : '\u2630 MENU';
        toggle.style.background = menuMode ? '#a00' : '#046';
      }
    }

    function installMenuToggle(){
      var toggle = document.createElement('button');
      toggle.id = '__kbToggleMenuBtn';
      toggle.textContent = '\u2630 MENU';
      toggle.style.cssText = 'position:fixed!important;left:8px!important;top:8px!important;width:auto!important;min-width:110px!important;height:55px!important;padding:0 16px!important;z-index:2147483647!important;background:#046!important;color:#fff!important;border:2px solid #0ff!important;border-radius:8px!important;font-size:14px!important;font-weight:bold!important;font-family:monospace!important;cursor:pointer!important;pointer-events:auto!important;opacity:0.95!important;touch-action:none!important;';
      toggle.addEventListener('touchstart', function(e){
        e.preventDefault(); e.stopPropagation();
        menuMode = !menuMode;
        applyMenuMode();
        console.log('[touch] menuMode = ' + menuMode);
      }, { passive: false });
      toggle.addEventListener('click', function(e){
        e.preventDefault(); e.stopPropagation();
        menuMode = !menuMode;
        applyMenuMode();
      });
      document.documentElement.appendChild(toggle);
    }

    // Pulsante GEAR impostazioni
    var gear = document.createElement('button');
    gear.id = '__kbGearBtn';
    gear.textContent = '\u2699';
    gear.style.cssText = 'position:fixed!important;left:148px!important;top:8px!important;width:55px!important;height:55px!important;z-index:2147483647!important;background:#333!important;color:#fff!important;border:2px solid #0ff!important;border-radius:50%!important;font-size:24px!important;cursor:pointer!important;pointer-events:auto!important;opacity:0.9!important;touch-action:none!important;';
    gear.addEventListener('touchstart', function(e){ e.preventDefault(); e.stopPropagation(); openSettings(); }, { passive: false });
    gear.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); openSettings(); });
    document.documentElement.appendChild(gear);

    installMenuToggle();

    console.log('[touch] Controlli v1.4 (menu toggle + crch ctrl) installati');
  }
})();
