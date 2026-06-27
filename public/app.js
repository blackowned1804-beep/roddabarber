// Register the service worker so the site is installable as a home-screen app.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// "Add to Home Screen" nudge. Captures Android's install prompt early; falls
// back to an instruction for iPhone (Safari has no install API). Only shows on
// pages that include #installBanner (the customer pages), never when already
// installed, and remembers a dismissal for 30 days.
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  maybeShowInstallBanner('android');
});
function initInstallBanner() {
  const banner = document.getElementById('installBanner');
  if (!banner) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) return;                                   // already installed
  const dismissedAt = +localStorage.getItem('charrod_install_dismissed') || 0;
  if (Date.now() - dismissedAt < 30 * 86400000) return;     // dismissed < 30 days ago

  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);

  document.getElementById('installClose').onclick = () => {
    banner.classList.remove('show');
    localStorage.setItem('charrod_install_dismissed', String(Date.now()));
  };
  document.getElementById('installBtn').onclick = async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    banner.classList.remove('show');
  };

  if (deferredInstall) maybeShowInstallBanner('android');
  else if (isIOS && isSafari) setTimeout(() => maybeShowInstallBanner('ios'), 1800);
}
function maybeShowInstallBanner(mode) {
  const banner = document.getElementById('installBanner');
  if (!banner) return;
  const text = document.getElementById('installText');
  const btn = document.getElementById('installBtn');
  if (mode === 'ios') {
    text.innerHTML = '<b>Add Rod da Barber to your phone</b>Tap the Share button, then “Add to Home Screen.”';
    btn.style.display = 'none';
  } else {
    text.innerHTML = '<b>Add Rod da Barber to your phone</b>Get in line in one tap, anytime.';
    btn.style.display = 'inline-block';
  }
  banner.classList.add('show');
}
if (document.readyState !== 'loading') initInstallBanner();
else document.addEventListener('DOMContentLoaded', initInstallBanner);

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
