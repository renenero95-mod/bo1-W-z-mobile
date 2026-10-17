// Sized once, before the transfer to the engine thread: it keeps its render targets at this resolution,
// so a resize only changes the CSS rectangle.
export function sizeGameCanvas(canvas: HTMLCanvasElement) {
  const width = Math.max(1, innerWidth), height = Math.max(1, innerHeight);
  const density = Math.min(devicePixelRatio || 1, 1920 / width, 1440 / height);
  const scale = Math.max(density, 800 / width, 600 / height);
  let cw = Math.round(width * scale);
  let ch = Math.round(height * scale);
  // PATCH v1.27.1: limita la risoluzione mantenendo minimo 800x600
  try {
    const maxW = parseInt(localStorage.getItem('__kbMaxWidth') || '0', 10);
    if (maxW > 0 && cw > maxW) {
      const ratio = maxW / cw;
      let nw = maxW;
      let nh = Math.round(ch * ratio);
      // Se scende sotto 800x600, riporta a 800x600 (minimo motore)
      if (nw < 800) { nw = 800; }
      if (nh < 600) { nh = 600; }
      cw = nw;
      ch = nh;
    }
  } catch(e) {}
  canvas.width = cw;
  canvas.height = ch;
  console.log('[canvas] sizeGameCanvas ->', canvas.width, 'x', canvas.height, 'innerWH:', innerWidth, innerHeight, 'dpr:', devicePixelRatio, 'maxW:', localStorage.getItem('__kbMaxWidth') || 'unlimited');
  const size = { width: canvas.width, height: canvas.height };
  function fit() {
    const fitScale = Math.min(innerWidth / size.width, innerHeight / size.height);
    canvas.style.width = `${size.width * fitScale}px`;
    canvas.style.height = `${size.height * fitScale}px`;
  }
  fit();
  addEventListener('resize', fit);
  return size;
}
