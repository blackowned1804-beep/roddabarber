/*
 * Charrod the Barber — queue server (Phase 1: live link, no SMS)
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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BARBER_PIN = process.env.BARBER_PIN || '1234';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// ---------------------------------------------------------------------------
// Persistence (tiny JSON store — plenty for this scale)
// ---------------------------------------------------------------------------
let db = {
  entries: [],          // every client ever, across all days
  state: {
    open: true,         // accepting new clients?
    cutoffMin: null,    // last-call time as minutes-since-midnight ET (null = none)
  },
};

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db.entries = db.entries || [];
      db.state = db.state || { open: true, cutoffMin: null };
    }
  } catch (e) {
    console.error('Could not read data.json, starting fresh:', e.message);
  }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
    catch (e) { console.error('save failed:', e.message); }
  }, 50);
}
load();

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
    apptLabel: e.apptMin != null ? minToLabel(e.apptMin) : null,
    status: e.status,
    createdMin: e.createdMin,
    createdLabel: minToLabel(e.createdMin),
    addedByBarber: !!e.addedByBarber,
  };
}

function doneToday() {
  return todaysEntries().filter(e => e.status === 'done');
}

// ---------------------------------------------------------------------------
// Client API
// ---------------------------------------------------------------------------
app.post('/api/join', (req, res) => {
  const { name, phone, partySize, service, kind, apptTime } = req.body || {};

  if (!db.state.open) {
    return res.status(403).json({ error: 'closed', message: 'Charrod is not taking new clients right now. Please check back soon!' });
  }
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'phone required' });
  if (!SERVICES[service]) return res.status(400).json({ error: 'pick a service' });

  const ps = Math.max(1, Math.min(10, parseInt(partySize, 10) || 1));
  const nowMin = etMinutesNow();

  let entryKind = kind === 'appt' ? 'appt' : 'walkin';
  let apptMin = null;
  if (entryKind === 'appt') {
    apptMin = parseApptTime(apptTime);
    if (apptMin == null) return res.status(400).json({ error: 'bad appt time', message: 'Please enter a valid appointment time.' });
  }

  // Cut-off applies to new walk-ins joining after last call.
  if (db.state.cutoffMin != null && nowMin > db.state.cutoffMin && entryKind === 'walkin') {
    return res.status(403).json({ error: 'past_cutoff', message: `Last call for walk-ins today was ${minToLabel(db.state.cutoffMin)}. See you next time!` });
  }

  const entry = makeEntry({ name, phone, partySize: ps, service, kind: entryKind, apptMin, addedByBarber: false });
  db.entries.push(entry);
  save();

  const ahead = peopleAhead(entry.id);
  res.json({
    ok: true,
    id: entry.id,
    ahead,
    positive: pick(POSITIVE, seedFrom(entry.id)),
    healthy: pick(HEALTHY, seedFrom(entry.id) + 1),
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

function makeEntry({ name, phone, partySize, service, kind, apptMin, addedByBarber }) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(name).trim().slice(0, 60),
    phone: String(phone).trim().slice(0, 30),
    partySize,
    service,
    kind,
    apptMin: apptMin ?? null,
    status: 'waiting',
    date: etDateStr(),
    createdMin: etMinutesNow(),
    createdAtMs: Date.now(),
    startedAtMs: null,
    finishedAtMs: null,
    addedByBarber: !!addedByBarber,
  };
}

// A client's live status
app.get('/api/status', (req, res) => {
  const e = db.entries.find(x => x.id === req.query.id);
  if (!e) return res.status(404).json({ error: 'not_found' });
  const ahead = (e.status === 'waiting' || e.status === 'in_chair') ? peopleAhead(e.id) : 0;
  res.json({
    entry: publicEntry(e),
    ahead,
    nowLabel: nowLabel(),
    positive: pick(POSITIVE, seedFrom(e.id)),
    healthy: pick(HEALTHY, seedFrom(e.id) + (ahead || 0)),
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

// Barber removes someone (cancel on their behalf)
app.post('/api/barber/remove', checkPin, (req, res) => {
  const target = activeEntries().find(e => e.id === (req.body && req.body.id));
  if (!target) return res.status(404).json({ error: 'not_found' });
  target.status = 'cancelled';
  target.finishedAtMs = Date.now();
  save();
  res.json({ ok: true });
});

// Open / close for the day
app.post('/api/barber/open', checkPin, (req, res) => {
  db.state.open = !!(req.body && req.body.open);
  save();
  res.json({ ok: true, open: db.state.open });
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
    return { sessions: list.length, cuts, byService };
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

// Pretty routes
app.get('/status', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));
app.get('/barber', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'barber.html')));
app.get('/qr', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'qr.html')));

app.listen(PORT, () => {
  console.log(`Charrod the Barber queue running on http://localhost:${PORT}`);
  console.log(`Barber PIN: ${BARBER_PIN}`);
});
