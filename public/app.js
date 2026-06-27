// Register the service worker so the site is installable as a home-screen app.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Shared tiny helpers
function toast(text, kind) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.textContent = text;
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 3200);
  setTimeout(() => t.remove(), 3700);
}
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 660;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.start(); o.stop(ctx.currentTime + 0.36);
  } catch (e) {}
}
