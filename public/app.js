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

// "Notify me when Rod opens" — web push opt-in (only on pages with #openAlertsBtn).
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s); const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function markAlertsOn(btn) {
  btn.textContent = "🔔 Alerts on — we'll tell you when Rod opens";
  btn.disabled = true; btn.classList.remove('secondary'); btn.classList.add('green');
  btn.style.display = 'block';
}
async function initOpenAlerts() {
  const btn = document.getElementById('openAlertsBtn');
  if (!btn) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (await reg.pushManager.getSubscription()) { markAlertsOn(btn); return; }
  } catch (_) {}
  if (Notification.permission === 'denied') {
    btn.textContent = '🔔 Alerts blocked — enable in phone settings';
    btn.disabled = true; btn.style.display = 'block'; return;
  }
  btn.textContent = '🔔 Notify me when Rod opens';
  btn.style.display = 'block';
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Setting up…';
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { btn.disabled = false; btn.textContent = '🔔 Notify me when Rod opens'; return; }
      const reg = await navigator.serviceWorker.ready;
      const key = await fetch('/api/push/key').then(r => r.text());
      if (!key) throw new Error('no key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
      markAlertsOn(btn);
      toast("You're set! We'll alert you when Rod opens 🔔", 'good');
    } catch (e) {
      btn.disabled = false; btn.textContent = '🔔 Notify me when Rod opens';
      toast('Couldn\'t turn on alerts. On iPhone, add the app to your home screen first.', 'bad');
    }
  };
}
if (document.readyState !== 'loading') initOpenAlerts();
else document.addEventListener('DOMContentLoaded', initOpenAlerts);
