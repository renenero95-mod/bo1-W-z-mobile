(function(){
  var ctx = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined' ? window : null);
  if (!ctx) return;
  var nav = ctx.navigator;
  var which = (ctx === self && typeof window === 'undefined') ? 'worker' : 'window';

  function log(msg){
    try { console.log('[polyfill/' + which + '] ' + msg); } catch(e){}
  }

  if (!nav || !nav.gpu) {
    log('navigator.gpu non disponibile, salto');
    return;
  }

  var FAKE = 'float32-filterable';

  // 1) Wrap del prototipo GPUAdapter.features: cattura TUTTI gli accessi,
  // anche quelli da adapter cachati o creati prima del polyfill.
  if (typeof GPUAdapter !== 'undefined' && GPUAdapter.prototype) {
    try {
      var protoDesc = Object.getOwnPropertyDescriptor(GPUAdapter.prototype, 'features');
      if (protoDesc && protoDesc.get) {
        var origGet = protoDesc.get;
        Object.defineProperty(GPUAdapter.prototype, 'features', {
          configurable: true,
          get: function(){
            var real = origGet.call(this);
            if (!real || real.__wrapped) return real;
            var wrapper = {
              has: function(f){ return f === FAKE ? true : real.has(f); },
              forEach: function(cb, t){
                real.forEach(cb, t);
                try { cb.call(t, FAKE, FAKE, wrapper); } catch(e){}
              },
              __real: real,
              __wrapped: true
            };
            Object.defineProperty(wrapper, 'size', { get: function(){ return real.size + 1; } });
            wrapper[Symbol.iterator] = function*(){ yield* real; yield FAKE; };
            return wrapper;
          }
        });
        log('GPUAdapter.prototype.features wrappato');
      } else {
        log('GPUAdapter.prototype.features non è un getter configurabile, salto');
      }
    } catch(e) {
      log('errore wrap prototipo: ' + (e && e.message ? e.message : e));
    }
  } else {
    log('GPUAdapter non definito, salto');
  }

  // 2) Mantieni ANCHE il wrap di requestAdapter (fallback, non nuoce)
  if (nav.gpu.requestAdapter && !nav.gpu.__polyfilled) {
    var orig = nav.gpu.requestAdapter.bind(nav.gpu);
    nav.gpu.requestAdapter = function(){
      log('requestAdapter chiamato');
      var p = orig.apply(null, arguments);
      if (p && typeof p.then === 'function') {
        return p.then(function(adapter){
          if (adapter) log('adapter ottenuto, features.has(float32-filterable)=' + adapter.features.has(FAKE));
          return adapter;
        });
      }
      return p;
    };
    try { nav.gpu.__polyfilled = true; } catch(e){}
    log('requestAdapter wrappato');
  }

  log('installazione completata');
})();
