// Engine key codes (win_wndproc.cpp MapKey, ui/keycodes.h), by physical US key; text characters are sent separately.
const CODE_TO_KEY: Record<string, number> = {
  Backquote: 126, Backspace: 127, Tab: 9, Enter: 13, Escape: 27, Space: 32,
  ShiftLeft: 160, ShiftRight: 160, ControlLeft: 159, ControlRight: 159,
  AltLeft: 158, AltRight: 158, CapsLock: 151, Pause: 153,
  ArrowUp: 154, ArrowDown: 155, ArrowLeft: 156, ArrowRight: 157,
  Insert: 161, Delete: 162, PageDown: 163, PageUp: 164, Home: 165, End: 166,
  Numpad0: 192, Numpad1: 188, Numpad2: 189, Numpad3: 190, Numpad4: 185,
  Numpad5: 186, Numpad6: 187, Numpad7: 182, Numpad8: 183, Numpad9: 184,
  NumpadEnter: 191, NumpadDecimal: 193, NumpadDivide: 194,
  NumpadSubtract: 195, NumpadAdd: 196, NumLock: 197, NumpadMultiply: 198, NumpadEqual: 199,
  Semicolon: 59, Equal: 61, Comma: 44, Minus: 45, Period: 46, Slash: 47,
  BracketLeft: 91, Backslash: 92, BracketRight: 93, Quote: 39,
};
for (let i = 0; i < 26; i++) CODE_TO_KEY[`Key${String.fromCharCode(65 + i)}`] = 97 + i;
for (let i = 0; i < 10; i++) CODE_TO_KEY[`Digit${i}`] = 48 + i;
for (let i = 1; i <= 15; i++) CODE_TO_KEY[`F${i}`] = 166 + i;
const ESCAPE = 27;
// Browser: left, middle, right, back, forward; engine: left, right, middle, back, forward.
const MOUSE_KEYS = [200, 202, 201, 203, 204];
// Chrome on Windows sometimes reports one huge move right after a lock or refocus: the aim jumped.
const LOCK_WARMUP_MS = 120;
const MAX_MOTION = 300;

export type InputEvent =
  | { kind: 'key'; key: number; down: boolean }
  | { kind: 'char'; char: number }
  | { kind: 'mouse'; dx: number; dy: number }
  | { kind: 'cursor'; x: number; y: number }
  | { kind: 'pointer-lock'; locked: boolean };

type Hooks = { menuOpen: () => boolean; size: () => { width: number; height: number }; relock: () => void };

// Locked: relative motion for gameplay. Free under a game menu: canvas coordinates, which the engine scales to 640x480.
// Free in gameplay: the next canvas click locks it again.
export function captureInput(canvas: HTMLCanvasElement, send: (event: InputEvent) => void, hooks: Hooks) {
  // PATCH v0.31: su touch non esiste pointer lock; non simulare eventi che mettono in pausa il motore
  const touchDevice = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);
  const held = new Map<string, number>(), listeners: (() => void)[] = [];
  let wheelRemainder = 0, enabled = false, escapeAt = -1e9, injectedAt = -1e9, blurAt = -1e9, lockChangeAt = -1e9, selfRelease = false;
  function on<K extends keyof DocumentEventMap>(target: Document | Window | HTMLElement, name: K, callback: (event: DocumentEventMap[K]) => void, options?: AddEventListenerOptions) {
    target.addEventListener(name, callback as EventListener, options);
    listeners.push(() => target.removeEventListener(name, callback as EventListener, options));
  }
  const locked = () => document.pointerLockElement === canvas;
  const active = () => enabled && (locked() || hooks.menuOpen());
  const spurious = (event: MouseEvent) => performance.now() - lockChangeAt < LOCK_WARMUP_MS
    || Math.abs(event.movementX) > MAX_MOTION || Math.abs(event.movementY) > MAX_MOTION;
  function cursor(event: MouseEvent) {
    const rect = canvas.getBoundingClientRect(), size = hooks.size();
    send({ kind: 'cursor', x: Math.round((event.clientX - rect.left) * size.width / rect.width),
      y: Math.round((event.clientY - rect.top) * size.height / rect.height) });
  }
  function release() {
    for (const key of new Set(held.values())) send({ kind: 'key', key, down: false });
    held.clear();
    wheelRemainder = 0;
  }
  // Capture phase: Escape must be taken before the browser releases the mouse.
  on(document, 'keydown', event => {
    const key = CODE_TO_KEY[event.code];
    // The Escape that cost the lock was already forwarded once.
    if (key === ESCAPE && enabled && performance.now() - injectedAt < 500) return event.preventDefault();
    if (!active() || key === undefined) return;
    // Taking Cmd+V here blocked the paste event.
    if ((event.metaKey || event.ctrlKey) && event.code === 'KeyV') return;
    event.preventDefault();
    if (key === ESCAPE) escapeAt = performance.now();
    if (!held.has(event.code)) {
      if (![...held.values()].includes(key)) send({ kind: 'key', key, down: true });
      held.set(event.code, key);
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) send({ kind: 'char', char: event.key.codePointAt(0)! });
    // The engine console expects character 8 to erase, like WM_CHAR on Windows.
    else if (event.key === 'Backspace') send({ kind: 'char', char: 8 });
  }, { capture: true });
  on(document, 'paste', event => {
    if (!active()) return;
    event.preventDefault();
    for (const char of event.clipboardData?.getData('text') ?? '') if (char >= ' ') send({ kind: 'char', char: char.codePointAt(0)! });
  });
  on(document, 'keyup', event => {
    const key = held.get(event.code);
    if (key === undefined) return;
    event.preventDefault();
    held.delete(event.code);
    if (![...held.values()].includes(key)) send({ kind: 'key', key, down: false });
  });
  on(document, 'mousemove', event => {
    if (!enabled) return;
    if (locked()) {
      if (!spurious(event)) send({ kind: 'mouse', dx: event.movementX, dy: event.movementY });
    } else if (hooks.menuOpen() && event.target === canvas) cursor(event);
  });
  for (const name of ['mousedown', 'mouseup'] as const) on(document, name, event => {
    if (!enabled) return;
    const down = name === 'mousedown';
    if (!locked() && !hooks.menuOpen()) {
      if (down && event.button === 0 && event.target === canvas) {
        event.preventDefault();
        hooks.relock();
      }
      return;
    }
    if (!locked() && event.target !== canvas) return;
    const key = MOUSE_KEYS[event.button];
    if (key === undefined) return;
    event.preventDefault();
    canvas.focus();
    if (!locked()) cursor(event);
    const code = `mouse${event.button}`;
    if (down) {
      if (held.has(code)) return;
      held.set(code, key);
    } else if (!held.delete(code)) return;
    send({ kind: 'key', key, down });
  });
  on(document, 'wheel', event => {
    if (!active()) return;
    event.preventDefault();
    // One wheel detent is one key pulse; a trackpad's remainder accumulates.
    wheelRemainder += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.height : 1);
    while (Math.abs(wheelRemainder) >= 100) {
      const key = wheelRemainder > 0 ? 205 : 206;
      send({ kind: 'key', key, down: true });
      send({ kind: 'key', key, down: false });
      wheelRemainder -= Math.sign(wheelRemainder) * 100;
    }
  }, { passive: false });
  on(canvas, 'contextmenu', event => event.preventDefault());
  on(window, 'blur', () => { blurAt = performance.now(); release(); });
  on(window, 'focus', () => { lockChangeAt = performance.now(); });
  on(document, 'pointerlockchange', () => {
    lockChangeAt = performance.now();
    const nowLocked = locked();
    release();
    // PATCH v0.31: su touch, mai inviare pointer-lock=false (metterebbe in pausa il motore)
    if (touchDevice) {
      if (enabled) send({ kind: 'pointer-lock', locked: true });
      return;
    }
    send({ kind: 'pointer-lock', locked: nowLocked || (enabled && hooks.menuOpen()) });
    if (nowLocked) escapeAt = -1e9;
    if (nowLocked || !enabled) {
      selfRelease = false;
      return;
    }
    // Chrome takes Escape to release the mouse without always delivering the key: hand it to the game, unless the page saw it,
    // released the mouse itself for a menu, or the tab lost focus (Alt+Tab, whose blur arrives just after).
    const lostAt = performance.now(), byPage = selfRelease;
    selfRelease = false;
    if (byPage || lostAt - escapeAt < 500 || hooks.menuOpen()) return;
    setTimeout(() => {
      if (!enabled || locked() || blurAt >= lostAt || escapeAt >= lostAt || hooks.menuOpen()) return;
      send({ kind: 'key', key: ESCAPE, down: true });
      send({ kind: 'key', key: ESCAPE, down: false });
      injectedAt = performance.now();
    }, 60);
  });
  return {
    dispose() {
      release();
      listeners.forEach(remove => remove());
    },
    enable(value: boolean) {
      enabled = value;
      if (!value) release();
    },
    // Frees the cursor for a game menu without sending the game an Escape.
    unlock() {
      if (!locked()) return;
      selfRelease = true;
      document.exitPointerLock();
    },
    // PATCH v0.33: su touch, invia subito pointer-lock=true al motore (senza browser lock)
    lock: () => {
      if (touchDevice || !canvas.requestPointerLock) {
        console.log('[input] touch-lock: invio pointer-lock=true al motore');
        send({ kind: 'pointer-lock', locked: true });
        return Promise.resolve();
      }
      return canvas.requestPointerLock().catch(() => {});
    },
  };
}
