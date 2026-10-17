(function(){
  if (window.__kbLogInstalled) return;
  window.__kbLogInstalled = true;

  var KEEP = [
    /\[renderer\]/, /\[engine\]/, /\[session\]/, /\[canvas\]/,
    /\[polyfill/, /\[probe\]/, /\[boot\]/, /\[enter\]/,
    /\[mirror-/, /\[mirror-blob\]/, /\[input\]/, /\[touch\]/, /\[pipeline-debug\]/, /\[conCmd\]/, /cl_stanceHoldTime/, /toggleprone/, /togglecrouch/, /cmdlist/, /Unknown command/, /\bstance\b/i, /\bprone\b/i, /\bcrouch\b/i,
    /CHOSEN/, /R_Init/, /Pixel shader/, /Vertex shader/,
    /WEB_GPU/, /KISAK_HEADLESS/,
    /KISAK_BROWSER view.*paused=/, /KISAK_BROWSER view.*input=/,
    /Com_ERROR/, /Sys_Error/,
    /\[err\]/, /\[warn\]/, /\[uncaught\]/, /\[rejection\]/,
    /InvalidStateError/, /SyntaxError/, /RuntimeError/, /TypeError/,
    /Failed to execute/, /Cannot read|Cannot pass|non-string/
  ];

  function normalize(line) {
    return line.replace(/\d+/g, 'N').replace(/0x[0-9a-f]+/gi, '0xX').slice(0, 150);
  }

  var logs = [];
  var MAX = 500;

  function appendLine(line) {
    var norm = normalize(line);
    var last = logs[logs.length - 1];
    if (last && last.norm === norm) {
      last.count = (last.count || 1) + 1;
      last.lastTs = Date.now();
    } else {
      logs.push({ line: line, norm: norm, ts: Date.now(), count: 1 });
      if (logs.length > MAX) logs.shift();
    }
    updateCounter();
  }

  function shouldKeep(line) {
    for (var i = 0; i < KEEP.length; i++) if (KEEP[i].test(line)) return true;
    return false;
  }

  ['log', 'error', 'warn', 'info'].forEach(function(level){
    var orig = console[level];
    console[level] = function(){
      var args = Array.prototype.slice.call(arguments);
      var parts = args.map(function(a){
        if (a instanceof Error) return a.message + ' @ ' + (a.stack || '').split('\n')[0];
        if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch(e){ return String(a); } }
        return String(a);
      });
      var line = '[' + level + '] ' + parts.join(' ');
      if (shouldKeep(line)) appendLine(line);
      return orig.apply(console, arguments);
    };
  });

  window.addEventListener('error', function(e){
    appendLine('[uncaught] ' + e.message + ' @ ' + e.filename + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', function(e){
    appendLine('[rejection] ' + String(e.reason));
  });

  function makeBtn(text, bg, onclick, bottom) {
    var b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'position:fixed!important;right:16px!important;top:' + bottom + '!important;z-index:2147483647!important;background:' + bg + '!important;color:#fff!important;border:2px solid #0ff!important;border-radius:8px!important;padding:12px 16px!important;font-size:14px!important;font-weight:bold!important;font-family:monospace!important;cursor:pointer!important;pointer-events:auto!important;opacity:0.9!important;';
    b.onclick = function(e){ e.stopPropagation(); e.preventDefault(); onclick(); };
    return b;
  }

  var counterEl = null;
  function updateCounter() {
    if (!counterEl) return;
    var expanded = logs.reduce(function(acc, l){ return acc + (l.count || 1); }, 0);
    counterEl.textContent = 'LOG ' + logs.length + '/' + expanded;
  }

  function buildText() {
    var header = '=== KB-LOG ' + new Date().toISOString() + ' ===\n';
    header += 'URL: ' + location.href + '\n';
    header += 'UA: ' + navigator.userAgent + '\n';
    header += 'Entries: ' + logs.length + '\n\n';
    var body = logs.map(function(l){
      return l.line + (l.count > 1 ? '   [x' + l.count + ']' : '');
    }).join('\n');
    return header + body + '\n';
  }

  function installUI() {
    if (window.__kbLogUIInstalled) return;
    window.__kbLogUIInstalled = true;

    counterEl = document.createElement('div');
    counterEl.style.cssText = 'display:none!important;position:fixed!important;right:16px!important;top:16px!important;z-index:2147483647!important;color:#0f0!important;background:rgba(0,0,0,0.75)!important;padding:6px 10px!important;font-family:monospace!important;font-size:12px!important;pointer-events:none!important;border-radius:6px!important;';
    document.documentElement.appendChild(counterEl);
    updateCounter();

    var saveBtn = makeBtn('SAVE', '#046', function(){
      var text = buildText();
      var blob = new Blob([text], { type: 'text/plain' });
      var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'kb-log-' + ts + '.txt';
      document.documentElement.appendChild(a);
      a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      saveBtn.textContent = 'SAVED';
      setTimeout(function(){ saveBtn.textContent = 'SAVE'; }, 1500);
    }, '60px');
    document.documentElement.appendChild(saveBtn);

    var clearBtn = makeBtn('CLEAR', '#600', function(){
      logs = [];
      updateCounter();
      clearBtn.textContent = 'CLEARED';
      setTimeout(function(){ clearBtn.textContent = 'CLEAR'; }, 1500);
    }, '16px');
    document.documentElement.appendChild(clearBtn);
    // NASCONDI i pulsanti (ora sono dentro impostazioni)
    saveBtn.style.display = 'none';
    clearBtn.style.display = 'none';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installUI);
  } else {
    installUI();
  }

  // Esponi funzioni globali per il pannello impostazioni
  window.__kbLogSave = function(){
    var text = buildText();
    var blob = new Blob([text], { type: 'text/plain' });
    var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kb-log-' + ts + '.txt';
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  window.__kbLogClear = function(){
    logs = [];
    updateCounter();
  };

  appendLine('[boot] log-capture installed');
})();
