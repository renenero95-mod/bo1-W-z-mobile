(function(){
  if (typeof OffscreenCanvas === 'undefined') return;
  if (self.__kbMirrorInstalled) return;
  self.__kbMirrorInstalled = true;

  var webgpuCanvas = null;
  var framePending = false;
  var frameSent = 0;

  try {
    var origGetContext = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function(type, opts){
      var ctx = origGetContext.call(this, type, opts);
      if (type === 'webgpu' && ctx) {
        webgpuCanvas = this;
        try { self.postMessage({type:'kb_log', msg:'[mirror-worker] canvas captured'}); } catch(e){}
      }
      return ctx;
    };
  } catch(e){}

  try {
    if (typeof GPUQueue !== 'undefined') {
      var origSubmit = GPUQueue.prototype.submit;
      GPUQueue.prototype.submit = function(commandBuffers){
        var result = origSubmit.call(this, commandBuffers);
        framePending = true;
        return result;
      };
    }
  } catch(e){}

  try {
    if (typeof globalThis.KisakWebGPUExecutor !== 'undefined') {
      var origBlit = globalThis.KisakWebGPUExecutor.prototype.blitColor;
      if (origBlit && !origBlit.__kbWrapped) {
        var wrapped = function(src, dst, sr, dr, filter){
          globalThis.__kbExecutor = this;
          return origBlit.call(this, src, dst, sr, dr, filter);
        };
        wrapped.__kbWrapped = true;
        globalThis.KisakWebGPUExecutor.prototype.blitColor = wrapped;
      }
      var OrigCtor = globalThis.KisakWebGPUExecutor;
      var WrappedCtor = function(){
        var inst = new OrigCtor(...arguments);
        globalThis.__kbExecutor = inst;
        return inst;
      };
      WrappedCtor.prototype = OrigCtor.prototype;
      Object.assign(WrappedCtor, OrigCtor);
      globalThis.KisakWebGPUExecutor = WrappedCtor;
    }
  } catch(e){}

  function kbBlobHook(){
    if (self.__kbBlobHook) return;
    self.__kbBlobHook = true;
    var sent = 0, last = 0;
    function log(m){ try{ self.postMessage({type:'kb_log', msg:'[mirror-blob] '+m}); }catch(e){} }

    globalThis.__kbF16 = {rgba32float:'rgba16float', rg32float:'rg16float', r32float:'r16float'};
    var f2hB = new Uint16Array(512), f2hS = new Uint8Array(512), convN = 0;
    (function(){
      for (var i = 0; i < 256; i++) {
        var e = i - 127, b, sh;
        if (e < -24)      { b = 0;                       sh = 24; }
        else if (e < -14) { b = 0x0400 >> (-e - 14);     sh = -e - 1; }
        else if (e <= 15) { b = (e + 15) << 10;          sh = 13; }
        else if (e < 128) { b = 0x7c00;                  sh = 24; }
        else              { b = 0x7c00;                  sh = 13; }
        f2hB[i] = b; f2hB[i | 0x100] = b | 0x8000;
        f2hS[i] = sh; f2hS[i | 0x100] = sh;
      }
    })();
    globalThis.__kbF32to16 = function(bytes, n){
      var u32 = new Uint32Array(n);
      var src = new Uint8Array(bytes.buffer, bytes.byteOffset, n * 4);
      new Uint8Array(u32.buffer).set(src);
      var out = new Uint16Array(n);
      for (var i = 0; i < n; i++) {
        var f = u32[i], x = (f >>> 23) & 0x1ff;
        out[i] = f2hB[x] + ((f & 0x7fffff) >> f2hS[x]);
      }
      if (++convN <= 8 || convN % 500 === 0) log('f32->f16 upload #' + convN + ' texel-components=' + n);
      return out;
    };

    var errIdx = 0, seenGrp = {};
    function digest(ctx){
      var e = ctx && ctx.errors;
      if (!e || e.length <= errIdx) return;
      var g = {}, order = [];
      for (var i = errIdx; i < e.length; i++) {
        var m = String(e[i]);
        var k = m.replace(/0x[0-9a-f]+|\d+/gi, 'N').slice(0, 240);
        if (!g[k]) { g[k] = {n:0, s:m}; order.push(k); }
        g[k].n++;
      }
      errIdx = e.length;
      var shown = 0;
      for (var j = 0; j < order.length && shown < 6; j++) {
        var key = order[j];
        if (seenGrp[key]) continue;
        seenGrp[key] = 1; shown++;
        log('ERR(' + e.length + ' tot) x' + g[key].n + ' ' + g[key].s.slice(0, 800));
      }
    }

    var F32 = /^(r32float|rg32float|rgba32float)$/, dummies = new WeakMap(), subst = 0, ocv = null;
    function dummyView(dev, dim){
      var m = dummies.get(dev); if (!m) { m = {}; dummies.set(dev, m); }
      if (m[dim]) return m[dim];
      var t = dev.createTexture({
        size: dim === '3d' ? [1,1,1] : [1,1, dim === 'cube' ? 6 : 1],
        dimension: dim === '3d' ? '3d' : '2d',
        format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
      return (m[dim] = ocv.call(t, {dimension: dim}));
    }
    try {
      ocv = GPUTexture.prototype.createView;
      GPUTexture.prototype.createView = function(d){
        var v = ocv.call(this, d);
        try {
          if (F32.test(this.format))
            v.__kbF32 = (d && d.dimension) || (this.dimension === '3d' ? '3d' : (this.depthOrArrayLayers > 1 ? '2d-array' : '2d'));
        } catch(e){}
        return v;
      };
      var ocb = GPUDevice.prototype.createBindGroup;
      GPUDevice.prototype.createBindGroup = function(desc){
        try {
          var ents = desc && desc.entries, out = null;
          for (var i = 0; ents && i < ents.length; i++) {
            var r = ents[i].resource;
            if (r && r.__kbF32) {
              if (!out) out = ents.slice();
              out[i] = {binding: ents[i].binding, resource: dummyView(this, r.__kbF32)};
              subst++;
            }
          }
          if (out) {
            desc = Object.assign({}, desc, {entries: out});
            if (subst <= 3 || subst % 2000 === 0) log('f32 view -> dummy (#' + subst + ')');
          }
        } catch(e){ log('f32 fix fail: ' + e.message); }
        return ocb.call(this, desc);
      };
    } catch(e){ log('f32 fix non installato: ' + e.message); }

    // ===== KB PERF v5 =====
    // MIN_FRAME_MS: prima era 30 -> con frame del motore tra 15 e 30 ms scartava un frame su due (aliasing).
    var MIN_FRAME_MS = 6, CW = 0, CH = 0;
    var PERF = globalThis.__kbPerf = { enabled: true, dedup: true, shadowSkip: true, stats: true };
    try {
      if (typeof GPURenderPassEncoder !== 'undefined' && typeof GPUCommandEncoder !== 'undefined') {
        // memorizza la texture di ogni vista (serve per classificare le pass)
        var ocv2 = GPUTexture.prototype.createView;
        GPUTexture.prototype.createView = function(d){
          var v = ocv2.call(this, d);
          try { v.__kbTex = this; } catch(e){}
          return v;
        };

        var RP = GPURenderPassEncoder.prototype, CE = GPUCommandEncoder.prototype;
        var NOOP_FN = function(){};
        var NOOP_PASS = new Proxy({}, { get: function(){ return NOOP_FN; } });
        var clearedViews = new WeakSet(), cls = {}, noopPasses = 0, subN = 0, gpuLatSum = 0, gpuLatN = 0, cpuSubSum = 0;
        function C(n){ return cls[n] || (cls[n] = {p:0, d:0}); }
        function sameOff(a, b){
          var la = a ? a.length : 0, lb = b ? b.length : 0;
          if (la !== lb) return false;
          for (var i = 0; i < la; i++) if (a[i] !== b[i]) return false;
          return true;
        }

        var oBegin = CE.beginRenderPass;
        CE.beginRenderPass = function(desc){
          if (!PERF.enabled) return oBegin.call(this, desc);
          var cname = 'other', skip = false, dv = null, ds = null;
          try {
            var ca = desc.colorAttachments, nc = 0, first = null;
            for (var i = 0; ca && i < ca.length; i++) if (ca[i] && ca[i].view) { nc++; if (!first) first = ca[i].view; }
            ds = desc.depthStencilAttachment; dv = ds && ds.view;
            var dt = dv && dv.__kbTex;
            if (nc === 0 && dt) {
              var screen = (dt.width === CW && dt.height === CH);
              cname = screen ? 'depthScreen' : 'depthSmall';
              // depth-only su texture NON a schermo = shadow map (ipotesi, verificabile dal log [perf])
              if (!screen && CW && PERF.shadowSkip && String(dt.format).indexOf('depth') === 0 &&
                  String(dt.format).indexOf('stencil') < 0 && !desc.occlusionQuerySet && !desc.timestampWrites &&
                  ds.depthLoadOp === 'clear' && ds.depthStoreOp === 'store') skip = true;
            } else if (nc > 0) {
              var t0 = first.__kbTex;
              cname = (t0 && t0.width === CW && t0.height === CH) ? 'colorFull' : 'colorOther';
            }
            // già pulita una volta: la shadow map resta "vuota", niente pass
            if (skip && clearedViews.has(dv)) { noopPasses++; C(cname).p++; return NOOP_PASS; }
          } catch(e){}
          var enc = oBegin.call(this, desc);
          try {
            enc.__kbS = { c: C(cname), skip: skip, p: null, bg: {}, vb: {}, ib: null };
            enc.__kbS.c.p++;
            if (skip) clearedViews.add(dv);
          } catch(e){}
          return enc;
        };

        var oSP = RP.setPipeline;
        RP.setPipeline = function(p){
          var s = this.__kbS;
          if (s && PERF.dedup) { if (s.p === p) return; s.p = p; }
          return oSP.call(this, p);
        };
        var oBG = RP.setBindGroup;
        RP.setBindGroup = function(i, g, o){
          var s = this.__kbS;
          if (s && PERF.dedup) {
            if (arguments.length <= 3 && (o == null || Array.isArray(o))) {
              var prev = s.bg[i];
              if (prev && prev.g === g && sameOff(prev.o, o)) return;
              s.bg[i] = { g: g, o: o ? o.slice() : null };
            } else s.bg[i] = null;
          }
          return oBG.apply(this, arguments);
        };
        var oVB = RP.setVertexBuffer;
        RP.setVertexBuffer = function(slot, b, off, size){
          var s = this.__kbS;
          if (s && PERF.dedup) {
            var o2 = off || 0, pv = s.vb[slot];
            if (pv && pv.b === b && pv.o === o2 && pv.z === size) return;
            s.vb[slot] = { b: b, o: o2, z: size };
          }
          return oVB.apply(this, arguments);
        };
        var oIB = RP.setIndexBuffer;
        RP.setIndexBuffer = function(b, fmt, off, size){
          var s = this.__kbS;
          if (s && PERF.dedup) {
            var o2 = off || 0, pv = s.ib;
            if (pv && pv.b === b && pv.f === fmt && pv.o === o2 && pv.z === size) return;
            s.ib = { b: b, f: fmt, o: o2, z: size };
          }
          return oIB.apply(this, arguments);
        };
        var oEB = RP.executeBundles;
        if (oEB) RP.executeBundles = function(){
          var s = this.__kbS;
          if (s) { s.p = null; s.bg = {}; s.vb = {}; s.ib = null; }
          return oEB.apply(this, arguments);
        };
        ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'].forEach(function(n){
          var o = RP[n]; if (!o) return;
          RP[n] = function(){
            var s = this.__kbS;
            if (s) { if (s.skip) return; s.c.d++; }
            return o.apply(this, arguments);
          };
        });

        // statistiche + latenza GPU campionata (CPU-bound o GPU-bound?)
        var oSub = GPUQueue.prototype.submit;
        GPUQueue.prototype.submit = function(cbs){
          var t0 = performance.now(), r = oSub.call(this, cbs), t1 = performance.now();
          if (!PERF.stats) return r;
          cpuSubSum += t1 - t0; subN++;
          if (subN % 20 === 0) {
            try { this.onSubmittedWorkDone().then(function(){ gpuLatSum += performance.now() - t1; gpuLatN++; }); } catch(e){}
          }
          if (subN % 300 === 0) {
            var parts = [];
            for (var k in cls) { parts.push(k + ' p=' + (cls[k].p / 300).toFixed(1) + ' d=' + (cls[k].d / 300).toFixed(0)); cls[k].p = 0; cls[k].d = 0; }
            log('[perf] /frame: ' + parts.join(' | ') + ' | noopPass=' + noopPasses + ' | submitCPU=' + (cpuSubSum / 300).toFixed(2) + 'ms gpuLat=' + (gpuLatN ? (gpuLatSum / gpuLatN).toFixed(1) : '?') + 'ms');
            cpuSubSum = 0; gpuLatSum = 0; gpuLatN = 0; noopPasses = 0;
          }
          return r;
        };
        log('perf v5 attivo (dedup=' + PERF.dedup + ' shadowSkip=' + PERF.shadowSkip + ')');
      }
    } catch(e){ log('perf v5 NON installato: ' + e.message); }
    // ===== fine KB PERF =====

    self.__kbPresent = function(ctx, canvas, touched){
      digest(ctx);
      if (canvas) { CW = canvas.width; CH = canvas.height; }
      if (!touched || !canvas) return;
      var now = performance.now();
      if (now - last < MIN_FRAME_MS) return;
      try { if (ctx && ctx.submit) ctx.submit(); } catch(e){ log('submit fail: '+e.message); }
      try {
        var bmp = canvas.transferToImageBitmap();
        last = now; sent++;
        if (sent <= 3 || sent % 300 === 0)
          log('taskEnd frame #'+sent+' '+bmp.width+'x'+bmp.height+' errs='+(ctx&&ctx.errors?ctx.errors.length:'?')+' draws='+(ctx&&ctx.stats?ctx.stats.draws:'?')+' f32up='+convN+' dummyBind='+subst);
        self.postMessage({type:'kb_frame', bitmap:bmp}, [bmp]);
      } catch(e){ if (sent < 3) log('transfer fail: '+e.message); }
    };
    log('hook v5 pronto (digest errori + f32->f16 reale + fallback dummy + perf)');
  }
  var HAS = '(globalThis.__kbF16&&globalThis.__kbF16[entry[0]])';
  var F32_GROUPS = {
    tex: [
      ['format:entry[0],bytesPerBlock:entry[1]',
       'format:' + HAS + '||entry[0],kbSrcF32:!!' + HAS + ',bytesPerBlock:entry[1]'],
      ['this.device.queue.writeTexture({texture:texture.gpu,mipLevel:level,origin:[x,y,z]},bytes,{bytesPerRow,rowsPerImage:bh},',
       'this.device.queue.writeTexture({texture:texture.gpu,mipLevel:level,origin:[x,y,z]},' +
       'texture.kbSrcF32?globalThis.__kbF32to16(bytes,bw*bh*depth*(texture.bytesPerBlock>>2)):bytes,' +
       '{bytesPerRow:texture.kbSrcF32?bytesPerRow>>1:bytesPerRow,rowsPerImage:bh},'],
      ['const bytes=source.texture.bytesPerBlock,rowBytes=width*bytes',
       'const bytes=source.texture.kbSrcF32?source.texture.bytesPerBlock>>1:source.texture.bytesPerBlock,rowBytes=width*bytes']
    ],
    depth: [
      ['format:"r32float",mipLevelCount:texture.levels', 'format:"rg16float",mipLevelCount:texture.levels'],
      ['targets:[{format:"r32float"}]', 'targets:[{format:"rg16float"}]'],
      ['return vec4f(textureLoad(image,vec2i(pos.xy),0),0,0,1);',
       'let d=textureLoad(image,vec2i(pos.xy),0);let hi=unpack2x16float(pack2x16float(vec2f(d,0.0))).x;return vec4f(hi,d-hi,0,1);'],
      ['let g=textureGather(0,ps_s${n}_texture,ps_s${n}_sampler,(floor(p)+vec2<f32>(1.0))/size);',
       'let g=textureGather(0,ps_s${n}_texture,ps_s${n}_sampler,(floor(p)+vec2<f32>(1.0))/size)+textureGather(1,ps_s${n}_texture,ps_s${n}_sampler,(floor(p)+vec2<f32>(1.0))/size);'],
      ['<=textureLoad(ps_s${n}_texture,i,0).x)',
       '<=(textureLoad(ps_s${n}_texture,i,0).x+textureLoad(ps_s${n}_texture,i,0).y))']
    ]
  };
  function applyF32Patches(s){
    var res = [];
    Object.keys(F32_GROUPS).forEach(function(g){
      var list = F32_GROUPS[g], ok = true;
      for (var i = 0; i < list.length; i++) {
        var at = s.indexOf(list[i][0]);
        if (at < 0 || s.indexOf(list[i][0], at + 1) >= 0) { ok = false; break; }
      }
      if (ok) {
        for (var j = 0; j < list.length; j++) {
          var p = s.indexOf(list[j][0]);
          s = s.slice(0, p) + list[j][1] + s.slice(p + list[j][0].length);
        }
      }
      res.push(g + '=' + (ok ? 'OK' : 'MISS'));
    });
    return {s: s, res: res.join(' ')};
  }
  var MINIMAL_HOOK = '(' + kbBlobHook.toString() + ')();';
  var TASKEND = 'case"taskEnd":return true;';
  var TASKEND_NEW = 'case"taskEnd":try{self.__kbPresent&&self.__kbPresent(ctx,canvas,frame)}catch(_e){}return true;';

  try {
    var OrigBlob = self.Blob;
    if (OrigBlob) {
      var NewBlob = function(parts, opts){
        try {
          if (opts && opts.type === 'text/javascript' && Array.isArray(parts) && parts.length === 1 && typeof parts[0] === 'string') {
            var s = parts[0];
            if (s.indexOf('WEB_GPU_PIPE') !== -1 || s.indexOf('getCurrentTexture') !== -1) {
              var patched = s.indexOf(TASKEND) !== -1;
              if (patched) s = s.replace(TASKEND, TASKEND_NEW);
              var fx = applyF32Patches(s); s = fx.s;
              parts = [MINIMAL_HOOK + '\n' + s];
              try { self.postMessage({type:'kb_log', msg:'[mirror-worker] Blob hook v4 injected ('+parts[0].length+' char) taskEnd patch='+patched+' f32patch: '+fx.res}); } catch(e){}
            }
          }
        } catch(e){}
        return new OrigBlob(parts, opts);
      };
      NewBlob.prototype = OrigBlob.prototype;
      self.Blob = NewBlob;
    }
  } catch(e){}

  try {
    if (typeof Worker !== 'undefined') {
      var OrigWorker = Worker;
      var WrappedWorker = function(url, opts){
        var w = new OrigWorker(url, opts);
        w.addEventListener('message', function(e){
          if (!e.data) return;
          if (e.data.type === 'kb_frame' && e.data.bitmap) {
            e.stopImmediatePropagation();
            try { self.postMessage({ type: 'kb_frame', bitmap: e.data.bitmap }, [e.data.bitmap]); } catch(err){}
          } else if (e.data.type === 'kb_log') {
            e.stopImmediatePropagation();
            self.postMessage(e.data);
          }
        }, true);
        return w;
      };
      WrappedWorker.prototype = OrigWorker.prototype;
      self.Worker = WrappedWorker;
    }
  } catch(e){}

  try { self.postMessage({type:'kb_log', msg:'[mirror-worker] installed'}); } catch(e){}
})();
