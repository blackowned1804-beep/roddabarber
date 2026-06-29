/*
 * Rod da Barber — queue server (Phase 1: live link, no SMS)
 *
 * One small Express app with three doors:
 *   /          client join form (the QR code points here)
 *   /status    a client's personal live status page (?id=...)
 *   /barber    the barber's dashboard (PIN gated)
 *   /qr        printable QR code for the station
 *
 * Live updates are done by simple polling (fine for ~20-30 people/day).
 * State is persisted to data.json so a restart doesn't lose the line.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const webpush = require('web-push');

const app = express();
app.set('trust proxy', true);   // Render terminates TLS at a proxy; honor x-forwarded-proto so QR uses https
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BARBER_PIN = process.env.BARBER_PIN || '1234';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// ---------------------------------------------------------------------------
// Persistence
//   - If DATABASE_URL is set (Render + Neon Postgres), the whole app state is
//     stored as one JSONB row, so it survives restarts/redeploys forever.
//   - Otherwise it falls back to a local JSON file (handy for development).
//   All queue logic still runs against the in-memory `db` object below; only
//   loading and saving change.
// ---------------------------------------------------------------------------
let db = {
  entries: [],          // every client ever, across all days
  state: {
    open: true,         // accepting new clients?
    cutoffMin: null,    // last-call time as minutes-since-midnight ET (null = none)
  },
  pushSubs: [],         // web-push subscriptions (clients who want "Rod is open" alerts)
  barberSubs: [],       // Rod's own push subscriptions ("new client joined" alerts)
  vapid: null,          // {publicKey, privateKey} — generated once, persisted
  healthTipIdx: 0,      // rotation pointer for Rod's "stay healthy" tip on each Open
};

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 12000,
    max: 4,
  });
  pool.on('error', (e) => console.error('pg pool error:', e.message));
}

async function load() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS app_state (id int PRIMARY KEY, data jsonb)');
    const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
    if (r.rows.length && r.rows[0].data) {
      const d = r.rows[0].data;
      db.entries = d.entries || [];
      db.state = d.state || { open: true, cutoffMin: null };
      db.pushSubs = d.pushSubs || [];
      db.barberSubs = d.barberSubs || [];
      db.vapid = d.vapid || null;
      db.healthTipIdx = d.healthTipIdx || 0;
    }
    console.log(`Loaded ${db.entries.length} entries from Postgres.`);
  } else {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        db.entries = d.entries || [];
        db.state = d.state || { open: true, cutoffMin: null };
        db.pushSubs = d.pushSubs || [];
        db.barberSubs = d.barberSubs || [];
        db.vapid = d.vapid || null;
        db.healthTipIdx = d.healthTipIdx || 0;
      }
    } catch (e) {
      console.error('Could not read data.json, starting fresh:', e.message);
    }
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 200);
}
async function doSave() {
  const payload = JSON.stringify({ entries: db.entries, state: db.state, pushSubs: db.pushSubs, barberSubs: db.barberSubs, vapid: db.vapid, healthTipIdx: db.healthTipIdx });
  if (pool) {
    try {
      await pool.query(
        'INSERT INTO app_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = $1::jsonb',
        [payload],
      );
    } catch (e) {
      console.error('db save failed:', e.message);
    }
  } else {
    try { fs.writeFileSync(DATA_FILE, payload); }
    catch (e) { console.error('save failed:', e.message); }
  }
}

// ---------------------------------------------------------------------------
// Web push ("Rod is open" alerts). VAPID keys come from env if set, otherwise
// they're generated once and persisted so they survive restarts.
// ---------------------------------------------------------------------------
let pushReady = false;
function ensureVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    db.vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else if (!db.vapid || !db.vapid.publicKey) {
    db.vapid = webpush.generateVAPIDKeys();
    save();
    console.log('Generated new VAPID keys.');
  }
  try {
    webpush.setVapidDetails('mailto:eisaaclegal1804@gmail.com', db.vapid.publicKey, db.vapid.privateKey);
    pushReady = true;
  } catch (e) {
    console.error('VAPID setup failed:', e.message);
  }
}

async function sendOpenPush() {
  if (!pushReady || !db.pushSubs.length) return;
  const payload = JSON.stringify({
    title: '💈 Rod da Barber is now open for business',
    body: "Come on through — Rod's ready for you!",
    url: '/',
  });
  const dead = [];
  await Promise.all(db.pushSubs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint); // gone — drop it
    }
  }));
  if (dead.length) {
    db.pushSubs = db.pushSubs.filter((s) => !dead.includes(s.endpoint));
    save();
  }
  console.log(`Sent "open" push to ${db.pushSubs.length} subscriber(s), dropped ${dead.length}.`);
}

async function sendBarberPush(title, body) {
  if (!pushReady || !db.barberSubs.length) return;
  const payload = JSON.stringify({ title, body, url: '/barber' });
  const dead = [];
  await Promise.all(db.barberSubs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
    }
  }));
  if (dead.length) {
    db.barberSubs = db.barberSubs.filter((s) => !dead.includes(s.endpoint));
    save();
  }
}

// "Stay healthy, Rod" tips — one fires to Rod each time he opens the shop.
// Kept in order and rotated via db.healthTipIdx so he sees a different one
// every open and the cycle survives restarts.
const HEALTH_TIPS = [
  // Hydration & Nutrition
  '💧 Drink a glass of water',
  '🍎 Eat a healthy snack — fruit, nuts, or yogurt',
  '🍵 Have some green tea',
  '🍌 Eat a piece of fruit',
  '🥥 Drink some coconut water',
  // Movement & Exercise
  '🚶 Go for a short walk',
  '💆 Stretch your neck and shoulders',
  '🏋️ Do 10 standing squats',
  '🪜 Walk up and down the stairs',
  '💪 Do some arm circles and wrist stretches',
  '🌳 Take a 5-minute walk outside',
  '🦵 Do some calf raises',
  // Relaxation & Mental Health
  '😮‍💨 Take 3 deep breaths',
  '🧘 Practice a 2-minute meditation',
  '😌 Close your eyes and relax for a minute',
  '🎶 Listen to calming music for 3 minutes',
  '🌬️ Step outside for some fresh air',
  // Self-Care & Posture
  '🧍 Fix your posture and stand up straight',
  '👐 Massage your temples',
  '🔄 Roll your shoulders back 10 times',
  '🧼 Wash your hands and face',
  '🧴 Apply lotion or sunscreen to exposed skin',
  // General Wellness
  '🥗 Have a healthy lunch if you haven\'t yet',
  '📱 Text a friend or family member',
  '✨ Set an intention for the rest of your day',
];

async function sendHealthTipPush() {
  if (!pushReady || !db.barberSubs.length) return;
  const idx = ((db.healthTipIdx || 0) % HEALTH_TIPS.length + HEALTH_TIPS.length) % HEALTH_TIPS.length;
  const tip = HEALTH_TIPS[idx];
  db.healthTipIdx = (idx + 1) % HEALTH_TIPS.length; // advance for next open
  save();
  await sendBarberPush('🌿 Take care of yourself, Rod', tip);
}

// ---------------------------------------------------------------------------
// Eastern-time helpers (DST-safe via Intl)
// ---------------------------------------------------------------------------
const ET = 'America/New_York';

function etParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = {};
  for (const { type, value } of f.formatToParts(d)) p[type] = value;
  return p; // {year, month, day, hour('00'-'23'), minute, second}
}
function etDateStr(d = new Date()) {
  const p = etParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}
function etMinutesNow(d = new Date()) {
  const p = etParts(d);
  let h = parseInt(p.hour, 10);
  if (h === 24) h = 0; // some platforms emit '24' at midnight
  return h * 60 + parseInt(p.minute, 10);
}
function minToLabel(min) {
  if (min == null) return '';
  let h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
function nowLabel() { return minToLabel(etMinutesNow()); }

// ---------------------------------------------------------------------------
// Friendly messages (positive + healthy) — Phase 1 shows these on screen
// ---------------------------------------------------------------------------
const POSITIVE = [
  "You're going to look sharp today. ✂️",
  "Good things come to those who book. You're all set!",
  "Fresh cut, fresh start. Glad you're here.",
  "Looking good is feeling good — almost your turn!",
  "A new look is a new mood. Worth the wait.",
  "Confidence starts at the chair. See you soon!",
  "Treat yourself — you earned this cut.",
  "Sharp lines ahead. Thanks for your patience!",
];
const HEALTHY = [
  "While you wait: take a slow breath and sip some water. 💧",
  "Tip: roll your shoulders back and relax your neck.",
  "Stand up, stretch your legs for a minute — your body will thank you.",
  "Drink some water while you wait — hydration is a free glow-up. 💧",
  "Unclench your jaw, drop your shoulders. You're doing great.",
  "A short walk now keeps you loose. Stay close though — you're moving up!",
  "Deep breath in… and out. Good things take a moment.",
];
const BARBER_BREAK = [
  "3 cuts done 🔥 Grab some water and roll your shoulders before the next one.",
  "Nice work — that's 3! Take 2 minutes: stretch your hands and wrists. 💪",
  "3 fresh cuts! Step outside for a breath of air if you can.",
  "Hat trick of cuts done. Hydrate and reset your posture. 💧",
  "3 down. Quick break: stretch your back, shake out your arms.",
];
// Motivational graphics shown on the client confirmation / live-spot screen.
// Note: 'love-*' live in /messages/ and knicks in /img/messages/ (matches how
// the files were uploaded). Paths are explicit so the rotation works as-is.
const MESSAGE_IMAGES = [
  '/img/messages/knicks.png',
  '/messages/love-1.png',
  '/messages/love-2.png',
  '/messages/love-3.png',
  '/messages/love-4.png',
  '/messages/love-5.png',
];

function pick(arr, seed) {
  const i = seed == null
    ? Math.floor((Date.now() / 1000) % arr.length)
    : Math.abs(seed) % arr.length;
  return arr[i];
}
function seedFrom(str) {
  let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}

// ---------------------------------------------------------------------------
// Queue logic
// ---------------------------------------------------------------------------
const SERVICES = {
  haircut: 'Haircut',
  beard: 'Beard',
  haircut_beard: 'Haircut & Beard',
  lineup: 'Line-up',
};

function todaysEntries() {
  const today = etDateStr();
  return db.entries.filter(e => e.date === today);
}
function activeEntries() {
  return todaysEntries().filter(e => e.status === 'waiting' || e.status === 'in_chair');
}

// "effective minute" = walk-in by when they joined, appointment by booked time.
function effectiveMin(e) {
  return e.kind === 'appt' && e.apptMin != null ? e.apptMin : e.createdMin;
}
// Order the active line: in-chair first, then by effective minute, then arrival.
function orderedActive() {
  return activeEntries().sort((a, b) => {
    const ac = a.status === 'in_chair' ? 0 : 1;
    const bc = b.status === 'in_chair' ? 0 : 1;
    if (ac !== bc) return ac - bc;
    const ae = effectiveMin(a), be = effectiveMin(b);
    if (ae !== be) return ae - be;
    return a.createdAtMs - b.createdAtMs;
  });
}
// People (cuts) ahead of a given entry — counts party sizes, walk-ins + appts.
function peopleAhead(entryId) {
  const ordered = orderedActive();
  let count = 0;
  for (const e of ordered) {
    if (e.id === entryId) return count;
    count += e.partySize;
  }
  return count;
}
function totalCutsWaiting() {
  return activeEntries().reduce((s, e) => s + e.partySize, 0);
}

// Walk-in cuts ahead of a given entry (excludes appointments).
function walkInsAheadCuts(entry) {
  const ordered = orderedActive();
  let cuts = 0;
  for (const e of ordered) {
    if (e.id === entry.id) break;
    if (e.kind === 'walkin') cuts += e.partySize;
  }
  return cuts;
}
// The day's still-pending appointments, earliest first (so walk-ins can see what's coming).
function pendingApptList() {
  return activeEntries()
    .filter(e => e.kind === 'appt' && e.apptMin != null)
    .sort((a, b) => a.apptMin - b.apptMin)
    .map(e => ({ label: minToLabel(e.apptMin), apptMin: e.apptMin, partySize: e.partySize }));
}

function publicEntry(e) {
  return {
    id: e.id,
    name: e.name,
    phone: e.phone,
    partySize: e.partySize,
    service: e.service,
    serviceLabel: SERVICES[e.service] || e.service,
    kind: e.kind,
    apptMin: e.apptMin,
    apptDate: e.apptDate || null,
    apptLabel: e.apptMin != null ? minToLabel(e.apptMin) : null,
    apptDateLabel: e.apptDate ? dateLabel(e.apptDate) : null,
    status: e.status,
    createdMin: e.createdMin,
    createdLabel: minToLabel(e.createdMin),
    addedByBarber: !!e.addedByBarber,
  };
}

function doneToday() {
  return todaysEntries().filter(e => e.status === 'done');
}

// Future-dated appointments still pending — so Rod can see what's booked ahead.
function upcomingAppts() {
  const today = etDateStr();
  return db.entries
    .filter(e => e.kind === 'appt' && e.status === 'waiting' && e.apptDate && e.apptDate > today)
    .sort((a, b) => (a.apptDate + String(a.apptMin).padStart(4, '0')).localeCompare(b.apptDate + String(b.apptMin).padStart(4, '0')))
    .map(e => ({ id: e.id, name: e.name, dateLabel: dateLabel(e.apptDate), apptLabel: minToLabel(e.apptMin), serviceLabel: SERVICES[e.service] || e.service, partySize: e.partySize }));
}

// ---------------------------------------------------------------------------
// Client API
// ---------------------------------------------------------------------------
app.post('/api/join', (req, res) => {
  const { name, phone, partySize, service, kind, apptTime, apptDate: apptDateRaw } = req.body || {};

  if (!db.state.open) {
    return res.status(403).json({ error: 'closed', message: "Rod's not in right now — turn on alerts and we'll let you know when he opens!" });
  }
  ensureStandingAppt(); // so walk-ins on Thursdays see Jason's 4:15 in their count
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  if (!SERVICES[service]) return res.status(400).json({ error: 'pick a service' });
  // Phone is optional for now (no SMS yet) — kept for Phase 2 texting.
  const cleanPhone = phone ? String(phone).trim() : '';

  const ps = Math.max(1, Math.min(10, parseInt(partySize, 10) || 1));
  const nowMin = etMinutesNow();

  let entryKind = kind === 'appt' ? 'appt' : 'walkin';
  let apptMin = null;
  let apptDate = null;
  if (entryKind === 'appt') {
    apptDate = parseApptDate(apptDateRaw);
    if (!apptDate) return res.status(400).json({ error: 'bad_date', message: 'Please pick a valid appointment date (today or later).' });
    apptMin = parseApptTime(apptTime);
    if (apptMin == null) return res.status(400).json({ error: 'bad appt time', message: 'Please enter a valid appointment time.' });
    if (blockedByMyThursday(apptDate, apptMin)) {
      return res.status(400).json({ error: 'rod_blocked', message: "Rod has a standing 4:15 PM appointment with Jason on Thursdays — please pick a time before 4:00 PM or after 4:45 PM." });
    }
  }

  // Cut-off applies to new walk-ins joining after last call.
  if (db.state.cutoffMin != null && nowMin > db.state.cutoffMin && entryKind === 'walkin') {
    return res.status(403).json({ error: 'past_cutoff', message: `Last call for walk-ins today was ${minToLabel(db.state.cutoffMin)}. See you next time!` });
  }

  const entry = makeEntry({ name, phone: cleanPhone, partySize: ps, service, kind: entryKind, apptMin, apptDate, addedByBarber: false });
  db.entries.push(entry);
  save();

  // Buzz Rod's phone (if he opted in) — works even with the dashboard closed.
  const who = entry.partySize > 1 ? `${entry.name} (+${entry.partySize - 1})` : entry.name;
  const how = entry.kind === 'appt' ? `appt ${minToLabel(entry.apptMin)}` : 'walk-in';
  sendBarberPush('💈 New client joined', `${who} · ${SERVICES[entry.service]} · ${how}`);

  res.json({
    ok: true,
    id: entry.id,
    kind: entry.kind,
    walkAhead: entry.kind === 'walkin' ? walkInsAheadCuts(entry) : 0,
    apptsAhead: entry.kind === 'walkin' ? pendingApptList() : [],
    apptLabel: entry.kind === 'appt' ? apptWhenStr(entry) : null,
    positiveImg: pick(MESSAGE_IMAGES, seedFrom(entry.id)),
    nowLabel: nowLabel(),
  });
});

function parseApptTime(t) {
  if (t == null) return null;
  // Accept "14:30" (HTML time input) or "2:30 PM"
  const s = String(t).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) return h * 60 + mm;
  }
  m = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (m) {
    let h = parseInt(m[1], 10); const mm = parseInt(m[2], 10);
    const pm = /p/i.test(m[3]);
    if (h === 12) h = 0;
    if (pm) h += 12;
    return h * 60 + mm;
  }
  return null;
}

// Appointment date "YYYY-MM-DD" — must be valid, today-or-future, within ~120 days.
function parseApptDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (m[0] < etDateStr()) return null;                                    // no past dates
  if (m[0] > etDateStr(new Date(Date.now() + 120 * 86400000))) return null; // not too far out
  return m[0];
}
function weekdayOf(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=Sun .. 6=Sat
}
function dateLabel(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function apptWhenStr(e) {
  if (e.apptMin == null) return null;
  const t = minToLabel(e.apptMin);
  return e.apptDate ? `${dateLabel(e.apptDate)} at ${t}` : t;
}
// Rod's standing weekly appointment with Jason: Thursday 4:15 PM. Block client
// appointments from 15 min before to 30 min after it (4:00–4:45 PM).
const MY_THURSDAY = { weekday: 4, fromMin: 16 * 60, toMin: 16 * 60 + 45 };
const STANDING_JASON = { name: 'Jason', service: 'haircut', apptMin: 16 * 60 + 15 }; // Thursday 4:15 PM
function blockedByMyThursday(dateStr, apptMin) {
  return weekdayOf(dateStr) === MY_THURSDAY.weekday && apptMin >= MY_THURSDAY.fromMin && apptMin <= MY_THURSDAY.toMin;
}
// On Thursdays, make sure Jason's standing 4:15 appointment exists for today, so
// Rod sees it in his line (created once per Thursday; not recreated if removed).
function ensureStandingAppt() {
  const today = etDateStr();
  if (weekdayOf(today) !== MY_THURSDAY.weekday) return;
  if (db.entries.some(e => e.standing && e.date === today)) return;
  const e = makeEntry({ name: STANDING_JASON.name, phone: '', partySize: 1, service: STANDING_JASON.service, kind: 'appt', apptMin: STANDING_JASON.apptMin, apptDate: today, addedByBarber: false });
  e.standing = true;
  db.entries.push(e);
  save();
}

function makeEntry({ name, phone, partySize, service, kind, apptMin, apptDate, addedByBarber }) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(name).trim().slice(0, 60),
    phone: String(phone).trim().slice(0, 30),
    partySize,
    service,
    kind,
    apptMin: apptMin ?? null,
    apptDate: apptDate ?? null,
    status: 'waiting',
    date: apptDate || etDateStr(),   // appointments file under their date; walk-ins under today
    createdMin: etMinutesNow(),
    createdAtMs: Date.now(),
    startedAtMs: null,
    finishedAtMs: null,
    addedByBarber: !!addedByBarber,
  };
}

// Public open/closed state — so the join page can greet appropriately on load.
app.get('/api/state', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ open: db.state.open, nowLabel: nowLabel() });
});

// A client's live status
app.get('/api/status', (req, res) => {
  const e = db.entries.find(x => x.id === req.query.id);
  if (!e) return res.status(404).json({ error: 'not_found' });
  const active = e.status === 'waiting' || e.status === 'in_chair';
  res.json({
    entry: publicEntry(e),
    kind: e.kind,
    walkAhead: active && e.kind === 'walkin' ? walkInsAheadCuts(e) : 0,
    apptsAhead: active && e.kind === 'walkin' ? pendingApptList() : [],
    apptLabel: e.kind === 'appt' ? apptWhenStr(e) : null,
    nowLabel: nowLabel(),
    positiveImg: pick(MESSAGE_IMAGES, seedFrom(e.id)),
  });
});

// Client cancels themselves
app.post('/api/cancel', (req, res) => {
  const e = db.entries.find(x => x.id === (req.body && req.body.id));
  if (!e) return res.status(404).json({ error: 'not_found' });
  if (e.status === 'done') return res.status(400).json({ error: 'already done' });
  e.status = 'cancelled';
  e.finishedAtMs = Date.now();
  e.cancelledByClient = true; // so the barber dashboard can flag it
  save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Barber API (PIN gated)
// ---------------------------------------------------------------------------
function checkPin(req, res, next) {
  const pin = (req.headers['x-barber-pin'] || (req.body && req.body.pin) || req.query.pin || '').toString();
  if (pin !== BARBER_PIN) return res.status(401).json({ error: 'bad_pin' });
  next();
}
app.post('/api/barber/login', (req, res) => {
  if (((req.body && req.body.pin) || '').toString() === BARBER_PIN) return res.json({ ok: true });
  res.status(401).json({ error: 'bad_pin' });
});

app.get('/api/barber/queue', checkPin, (req, res) => {
  ensureStandingAppt();
  const ordered = orderedActive().map(publicEntry);
  // attach running "people ahead" for display
  let ahead = 0;
  for (const e of ordered) { e.ahead = ahead; ahead += e.partySize; }
  const done = doneToday();
  res.json({
    queue: ordered,
    state: { open: db.state.open, cutoffMin: db.state.cutoffMin, cutoffLabel: minToLabel(db.state.cutoffMin) },
    stats: {
      waitingParties: activeEntries().length,
      waitingCuts: totalCutsWaiting(),
      doneToday: done.reduce((s, e) => s + e.partySize, 0),
      doneSessions: done.length,
    },
    cancelledRecently: todaysEntries()
      .filter(e => e.status === 'cancelled' && e.cancelledByClient && !e.barberSawCancel)
      .map(publicEntry),
    upcoming: upcomingAppts(),
    nowLabel: nowLabel(),
  });
});

// Barber marks the cancellation seen (so the alert clears)
app.post('/api/barber/ack-cancel', checkPin, (req, res) => {
  const e = db.entries.find(x => x.id === (req.body && req.body.id));
  if (e) { e.barberSawCancel = true; save(); }
  res.json({ ok: true });
});

// Manually add a client (no smartphone)
app.post('/api/barber/add', checkPin, (req, res) => {
  const { name, phone, partySize, service, kind, apptTime } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  if (!SERVICES[service]) return res.status(400).json({ error: 'pick a service' });
  const ps = Math.max(1, Math.min(10, parseInt(partySize, 10) || 1));
  let apptMin = null;
  const entryKind = kind === 'appt' ? 'appt' : 'walkin';
  if (entryKind === 'appt') {
    apptMin = parseApptTime(apptTime);
    if (apptMin == null) return res.status(400).json({ error: 'bad appt time' });
  }
  const entry = makeEntry({ name, phone: phone || '—', partySize: ps, service, kind: entryKind, apptMin, addedByBarber: true });
  db.entries.push(entry);
  save();
  res.json({ ok: true, id: entry.id });
});

// Start the next person (or a specific one) — puts them in the chair
app.post('/api/barber/start', checkPin, (req, res) => {
  // free any current in_chair? No — only one chair, so require none in chair.
  const inChair = activeEntries().find(e => e.status === 'in_chair');
  if (inChair) return res.status(400).json({ error: 'busy', message: 'Finish the current cut first.' });
  let target;
  if (req.body && req.body.id) target = activeEntries().find(e => e.id === req.body.id);
  else target = orderedActive().find(e => e.status === 'waiting');
  if (!target) return res.status(404).json({ error: 'empty' });
  target.status = 'in_chair';
  target.startedAtMs = Date.now();
  save();
  res.json({ ok: true });
});

// Finish the current cut (or a specific one)
app.post('/api/barber/done', checkPin, (req, res) => {
  let target;
  if (req.body && req.body.id) target = activeEntries().find(e => e.id === req.body.id);
  else target = activeEntries().find(e => e.status === 'in_chair') || orderedActive().find(e => e.status === 'waiting');
  if (!target) return res.status(404).json({ error: 'empty' });
  target.status = 'done';
  target.finishedAtMs = Date.now();
  save();

  // Break nudge after every 3 completed cuts (by party size) today
  const doneCuts = doneToday().reduce((s, e) => s + e.partySize, 0);
  const breakMsg = doneCuts > 0 && doneCuts % 3 === 0 ? pick(BARBER_BREAK, doneCuts) : null;

  res.json({ ok: true, doneCuts, breakMsg });
});

// "Not here" — an appointment/walk-in didn't show; send to no_show
app.post('/api/barber/noshow', checkPin, (req, res) => {
  const target = activeEntries().find(e => e.id === (req.body && req.body.id));
  if (!target) return res.status(404).json({ error: 'not_found' });
  target.status = 'no_show';
  target.finishedAtMs = Date.now();
  save();
  res.json({ ok: true });
});

// Barber removes someone (cancel on their behalf) — works for today's line AND
// future-dated upcoming appointments.
app.post('/api/barber/remove', checkPin, (req, res) => {
  const id = req.body && req.body.id;
  const target = db.entries.find(e => e.id === id && (e.status === 'waiting' || e.status === 'in_chair'));
  if (!target) return res.status(404).json({ error: 'not_found' });
  target.status = 'cancelled';
  target.finishedAtMs = Date.now();
  save();
  res.json({ ok: true });
});

// Open / close for the day
app.post('/api/barber/open', checkPin, (req, res) => {
  const wasOpen = db.state.open;
  db.state.open = !!(req.body && req.body.open);
  save();
  res.json({ ok: true, open: db.state.open });
  if (!wasOpen && db.state.open) {
    sendOpenPush();        // closed -> open: notify waiting customers
    sendHealthTipPush();   // and nudge Rod with a rotating health tip
  }
});

// --- Web push: client gets the public key, then registers a subscription ---
app.get('/api/push/key', (_req, res) => res.type('text/plain').send((db.vapid && db.vapid.publicKey) || ''));
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad_subscription' });
  if (!db.pushSubs.some((s) => s.endpoint === sub.endpoint)) {
    db.pushSubs.push(sub);
    save();
  }
  res.json({ ok: true });
});

// Rod's own "new client joined" alerts (PIN-gated — only the barber subscribes).
app.post('/api/barber/push-subscribe', checkPin, (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad_subscription' });
  if (!db.barberSubs.some((s) => s.endpoint === sub.endpoint)) {
    db.barberSubs.push(sub);
    save();
  }
  res.json({ ok: true });
});

// Set / clear the daily cut-off (last call) in ET
app.post('/api/barber/cutoff', checkPin, (req, res) => {
  const t = req.body && req.body.cutoff;
  if (t == null || t === '') { db.state.cutoffMin = null; }
  else {
    const min = parseApptTime(t);
    if (min == null) return res.status(400).json({ error: 'bad time' });
    db.state.cutoffMin = min;
  }
  save();
  res.json({ ok: true, cutoffMin: db.state.cutoffMin });
});

// Stats: day / week / month / year, by service type
app.get('/api/barber/stats', checkPin, (req, res) => {
  const done = db.entries.filter(e => e.status === 'done' && e.finishedAtMs);
  const now = new Date();
  const today = etDateStr(now);
  const startOfWeek = etDateStr(new Date(now.getTime() - 6 * 86400000)); // rolling 7 days
  const ym = today.slice(0, 7);
  const year = today.slice(0, 4);

  function bucket(filterFn) {
    const list = done.filter(filterFn);
    const cuts = list.reduce((s, e) => s + e.partySize, 0);
    const byService = {};
    for (const k of Object.keys(SERVICES)) byService[k] = 0;
    for (const e of list) byService[e.service] = (byService[e.service] || 0) + e.partySize;
    // Day-of-week breakdown: total cuts per weekday (Sun..Sat) and the number of
    // distinct dates he was open on each weekday (for a per-open-day average).
    const byWeekday = [0, 0, 0, 0, 0, 0, 0];
    const wdDates = [new Set(), new Set(), new Set(), new Set(), new Set(), new Set(), new Set()];
    for (const e of list) {
      const [y, m, d] = e.date.split('-').map(Number);
      const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun .. 6=Sat
      byWeekday[wd] += e.partySize;
      wdDates[wd].add(e.date);
    }
    const weekdayDays = wdDates.map((s) => s.size);
    return { sessions: list.length, cuts, byService, byWeekday, weekdayDays };
  }

  res.json({
    today: bucket(e => e.date === today),
    week: bucket(e => e.date >= startOfWeek),
    month: bucket(e => e.date.slice(0, 7) === ym),
    year: bucket(e => e.date.slice(0, 4) === year),
    services: SERVICES,
    // last 14 days for a tiny trend
    daily: lastNDays(14, done),
  });
});

function lastNDays(n, done) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = etDateStr(new Date(Date.now() - i * 86400000));
    const cuts = done.filter(e => e.date === d).reduce((s, e) => s + e.partySize, 0);
    out.push({ date: d, cuts });
  }
  return out;
}

// ---------------------------------------------------------------------------
// QR code for the station
// ---------------------------------------------------------------------------
app.get('/api/qr', async (req, res) => {
  const base = (req.query.url || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const joinUrl = `${base}/`;
  try {
    const dataUrl = await QRCode.toDataURL(joinUrl, { width: 600, margin: 2 });
    res.json({ url: joinUrl, dataUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lightweight health check (used by the self-ping below)
app.get('/healthz', (_req, res) => res.json({ ok: true, t: nowLabel() }));

// Pretty routes
app.get('/status', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));
app.get('/barber', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'barber.html')));
app.get('/qr', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'qr.html')));

// Load persisted state first, then start serving.
(async () => {
  try {
    await load();
  } catch (e) {
    console.error('Initial load failed (starting with empty state):', e.message);
  }
  ensureVapid();
  ensureStandingAppt();
  app.listen(PORT, () => {
    console.log(`Rod da Barber queue running on http://localhost:${PORT}`);
    console.log(`Storage: ${pool ? 'Postgres (persistent)' : 'local file'}`);
    console.log(`Barber PIN: ${BARBER_PIN}`);
  });
})();

// Keep-warm self-ping: on Render, hit our own public URL every 10 min so the
// free instance never spins down (no cold starts, no external service needed).
// Render provides RENDER_EXTERNAL_URL automatically; locally this is unset so
// the pinger stays off.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(`${SELF_URL}/healthz`).catch(() => {});
  }, 10 * 60 * 1000);
  console.log(`Keep-warm self-ping enabled → ${SELF_URL}/healthz every 10 min`);
}
