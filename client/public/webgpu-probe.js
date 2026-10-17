(async function(){
  if (!navigator.gpu) { console.log('[probe] WebGPU non esposto da navigator'); return; }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) { console.log('[probe] nessun adapter'); return; }
    const feats = [...adapter.features].sort();
    console.log('[probe] TUTTE le feature WebGPU disponibili (' + feats.length + '):');
    for (const f of feats) console.log('[probe]  - ' + f);
    const required = ['depth32float-stencil8', 'float32-filterable', 'float32-blendable', 'texture-compression-bc'];
    console.log('[probe] CHECK delle feature richieste dal gioco:');
    for (const r of required) console.log('[probe]  ' + r + ': ' + (adapter.features.has(r) ? 'OK' : 'MANCANTE'));
    const info = adapter.info || {};
    console.log('[probe] adapter info:', JSON.stringify(info));
  } catch (e) {
    console.log('[probe] errore: ' + e.message);
  }
})();
