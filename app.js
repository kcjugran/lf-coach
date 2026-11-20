// LF Coach - the phone view of the coach dashboard, talking to the PC (coach-phone/app/api.py).
// Everything it can do: see the roster, log a class, log a payment, undo one of those.
// The numbers are worked out with the same rules as the dashboard, so both agree.

const el = id => document.getElementById(id);

// ---- where the PC is -------------------------------------------------------------
// Served by the PC itself (home Wi-Fi / tunnel): same origin. Served from the permanent
// page on GitHub Pages: the PC's current tunnel address is in backend.json, which the PC
// rewrites after every restart (app/tunnel.py).
const ON_PAGES = location.hostname.endsWith('github.io');
const BACKEND_JSON = 'https://api.github.com/repos/kcjugran/lf-coach/contents/backend.json';
const TUNNEL_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;   // the token only ever goes here

const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } },
};
let base = ON_PAGES ? store.get('lfc-api') : '';
let token = store.get('lfc-session');

let lastLookup = 0;
async function findBackend() {
  // The PC's address only changes when it restarts; don't spend GitHub's 60/hour lookups
  // re-asking every minute while it's off.
  if (base && Date.now() - lastLookup < 90_000) throw new Error('looked up recently');
  lastLookup = Date.now();
  const r = await fetch(BACKEND_JSON, { headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
  if (!r.ok) throw new Error('lookup');
  const api = String((await r.json()).api || '');
  if (!TUNNEL_RE.test(api)) throw new Error('bad address');
  base = api;
  store.set('lfc-api', api);
}

// ---- working while the PC is off -------------------------------------------------
// The last roster seen is kept on the phone, so a class can still be logged at the gym.
// Changes the PC can't take right now wait in an outbox here and go out, in order, the
// next time it answers. Every change carries an id, so a resend is never counted twice.
const CACHE = 'lfc-data';
const OUTBOX = 'lfc-outbox';
const outbox = {
  list() { try { return JSON.parse(store.get(OUTBOX) || '[]'); } catch { return []; } },
  save(list) { store.set(OUTBOX, list.length ? JSON.stringify(list) : ''); },
};
let data = null;
try { data = JSON.parse(store.get(CACHE) || 'null'); } catch { data = null; }
function keep() { if (data) store.set(CACHE, JSON.stringify(data)); }

const newId = () => [...crypto.getRandomValues(new Uint8Array(8))]   // randomUUID needs https
  .map(b => b.toString(16).padStart(2, '0')).join('');

function banner(text) {
  el('banner').textContent = text || '';
  el('banner').hidden = !text;
}
const OFFLINE = "Can't reach the PC. Is it on?";
// Cloudflare answers for a PC that's gone with 502-530 (and no CORS header, so a fetch error).
const PC_GONE = s => s === 502 || s === 503 || s === 504 || (s >= 520 && s <= 530);
function showPending() {
  const n = outbox.list().length;
  if (n) banner(`PC is off. ${n} ${n === 1 ? 'entry' : 'entries'} saved here, sent when it's back.`);
}

async function send(path, body) {
  if (ON_PAGES && !base) await findBackend();
  return fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
}

/** One API call. Re-looks-up the PC's address once if it moved (PC restarted). */
async function call(path, body, { quiet = false } = {}) {
  let r;
  try {
    try { r = await send(path, body); }
    catch (e) {
      if (!ON_PAGES) throw e;
      await findBackend();
      r = await send(path, body);
    }
  } catch { r = null; }
  if (!r || PC_GONE(r.status)) {
    banner(OFFLINE);
    const err = new Error('offline');
    err.offline = true;
    throw err;
  }
  if (r.status === 401 && !quiet) { showGate('login'); throw new Error('login'); }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (!quiet) banner(json.error || `Could not save (${r.status})`);
    const err = new Error(json.error || String(r.status));
    err.status = r.status;
    throw err;
  }
  banner('');
  return json;
}

/** Send a change now, or keep it for later if the PC is off. The screen already shows it. */
async function write(path, body) {
  keep();
  if (outbox.list().length) {           // older entries are still waiting: stay behind them
    outbox.save([...outbox.list(), { path, body }]);
    showPending();
    flush().then(afterFlush);
    return;
  }
  try {
    data = await call(path, body);
    keep();
    render();
  } catch (e) {
    if (e.offline) { outbox.save([{ path, body }]); showPending(); }
    else if (e.message !== 'login') load();   // the PC refused it: show what it really has
  }
}

let flushing = null;
/** Send the waiting entries, oldest first. Stops at the first one the PC can't take yet. */
function flush() {
  if (!flushing) {
    flushing = (async () => {
      while (outbox.list().length) {
        const [op] = outbox.list();
        try {
          await call(op.path, op.body, { quiet: true });
        } catch (e) {
          if (e.status === 401) { showGate('login'); break; }
          if (e.offline || e.status === 429 || e.status >= 500) break;   // keep it for next time
          // any other 4xx: the PC refused this one for good; drop it so the rest can go
        }
        const rest = outbox.list();
        rest.shift();
        outbox.save(rest);
      }
    })().finally(() => { flushing = null; });
  }
  return flushing;
}
async function afterFlush() {
  if (outbox.list().length) { showPending(); return; }
  await load();
}

// ---- the same arithmetic as the dashboard ----------------------------------------
const COUNTERS = ['classesDone', 'classesPaid', 'cycleDone', 'cycleKey', 'nextPayDue'];
const ymd = d => { const z = new Date(d); z.setMinutes(z.getMinutes() - z.getTimezoneOffset()); return z.toISOString().slice(0, 10); };
const addMonthISO = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setMonth(d.getMonth() + n); return ymd(d); };
const daysTo = iso => { if (!iso) return null; const d = new Date(iso + 'T00:00:00'); if (isNaN(d)) return null; return Math.ceil((d - new Date().setHours(0, 0, 0, 0)) / 864e5); };
const isSessions = c => c.program === 'sessions';
const isMonthly = c => isSessions(c) && c.billingType === 'Monthly';
const remaining = c => (isSessions(c) && !isMonthly(c) ? (c.classesPaid || 0) - (c.classesDone || 0) : null);
const monthCycle = c => {
  let due = c.nextPayDue || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || isNaN(new Date(due + 'T00:00:00'))) return 'open';
  const today = ymd(new Date());
  for (let i = 0; i < 240 && due <= today; i++) due = addMonthISO(due, 1);
  return due;
};
const monthDone = c => (c.cycleKey === monthCycle(c) ? (c.cycleDone || 0) : 0);
const isPayDue = c => {
  if (!isSessions(c)) return false;
  if (isMonthly(c) || daysTo(c.nextPayDue) != null) { const d = daysTo(c.nextPayDue); return d != null && d < 0; }
  return (c.classesDone || 0) > (c.classesPaid || 0);
};
const money = (c, n) => (c.currency === 'INR' ? '₹' : '$') + Math.round(n).toLocaleString(c.currency === 'INR' ? 'en-IN' : 'en-US');
const shortDate = iso => { const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };

// ---- rendering --------------------------------------------------------------------
const GROUPS = [
  ['Needs a payment', c => isPayDue(c)],
  ['Active', c => !isPayDue(c) && isSessions(c) && c.status === 'Active'],
  ['Paused & onboarding', c => !isPayDue(c) && isSessions(c) && c.status !== 'Active'],
  ['Diet plans', c => !isSessions(c)],
];

function statusChip(c) {
  if (isPayDue(c)) return ['due', isMonthly(c) ? 'month due' : 'unpaid'];
  if (c.status === 'Active') return ['ok', 'active'];
  if (c.status === 'Paused') return ['hold', 'paused'];
  return ['', String(c.status || '').toLowerCase()];
}

function figureOf(c) {
  if (!isSessions(c)) return null;
  if (isMonthly(c)) {
    const n = monthDone(c);
    return [String(n), n === 1 ? 'class this month' : 'classes this month'];
  }
  const left = remaining(c);
  if (left < 0) return [String(-left), -left === 1 ? 'class unpaid' : 'classes unpaid'];
  return [String(left), left === 1 ? 'class left' : 'classes left'];
}

function termsOf(c) {
  if (!isSessions(c)) return `Diet plan · ${c.tier || ''}`.trim();
  const rate = +c.rate || 0;
  const per = isMonthly(c) ? '/month' : '/class';
  const bits = [rate ? money(c, rate) + per : 'no rate set'];
  if (isMonthly(c)) {
    const due = monthCycle(c);
    const d = daysTo(c.nextPayDue);
    bits.push(due === 'open' ? 'no payment date' : d != null && d < 0
      ? `overdue since ${shortDate(c.nextPayDue)}` : `next due ${shortDate(due)}`);
  } else {
    bits.push(`${c.classesDone || 0} done · ${c.classesPaid || 0} paid`);
  }
  return bits.join(' · ');
}

function card(c) {
  const li = el('card-tpl').content.firstElementChild.cloneNode(true);
  const [chipClass, chipText] = statusChip(c);
  li.classList.toggle('is-due', isPayDue(c));
  li.querySelector('.name').textContent = c.name || c.id;
  const chip = li.querySelector('.chip');
  chip.textContent = chipText;
  if (chipClass) chip.classList.add(chipClass);
  li.querySelector('.terms').textContent = termsOf(c);
  const fig = figureOf(c);
  if (fig) {
    li.querySelector('.big').textContent = fig[0];
    li.querySelector('.unit').textContent = fig[1];
  } else {
    li.classList.add('flat');
  }
  if (isSessions(c)) {
    li.querySelector('.act.class').addEventListener('click', () => logClass(c.id));
    li.querySelector('.act.pay').addEventListener('click', () => openPay(c.id));
  } else {
    li.querySelector('.acts').remove();
  }
  return li;
}

function render() {
  const clients = (data && data.clients) || [];
  const due = clients.filter(isPayDue).length;
  const active = clients.filter(c => c.status === 'Active').length;
  el('count').textContent = clients.length ? `${active} active · ${clients.length} total` : '';
  el('sub').textContent = !clients.length ? '' : due
    ? `${due} ${due === 1 ? 'payment' : 'payments'} to collect` : 'Everyone is paid up';

  const host = el('groups');
  host.replaceChildren();
  if (!clients.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = token ? 'No clients yet.' : '';
    host.append(p);
  }
  for (const [title, test] of GROUPS) {
    const list = clients.filter(test).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!list.length) continue;
    const section = document.createElement('section');
    section.className = 'group';
    const h = document.createElement('h2');
    h.className = 'group-title';
    h.textContent = title;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = `  ${list.length}`;
    h.append(n);
    const ul = document.createElement('ul');
    ul.className = 'list';
    for (const c of list) ul.append(card(c));
    section.append(h, ul);
    host.append(section);
  }
  renderRecent();
}

function renderRecent() {
  const events = ((data && data.events) || []).slice(0, 6);
  el('recent-wrap').hidden = !events.length;
  const ul = el('recent');
  ul.replaceChildren();
  for (const ev of events) {
    const li = el('recent-tpl').content.firstElementChild.cloneNode(true);
    li.classList.toggle('undone', !!ev.undone);
    li.querySelector('.rwho').textContent = ev.clientName || ev.client;
    li.querySelector('.rwhat').textContent = ev.text || '';
    const btn = li.querySelector('.undo');
    if (ev.undone) btn.remove();
    else btn.addEventListener('click', () => undo(ev));
    ul.append(li);
  }
}

// ---- actions ----------------------------------------------------------------------
const clientById = id => ((data && data.clients) || []).find(c => c.id === id);

function pushEvent(c, kind, text, before) {
  data.events = [{
    id: newId(), at: Date.now(), kind, client: c.id, clientName: c.name || c.id,
    text, undone: false, before, after: Object.fromEntries(COUNTERS.map(k => [k, c[k]])),
  }, ...((data.events) || [])].slice(0, 25);
  return data.events[0];
}

/** Log a class: shown at once, sent straight after (or queued if the PC is off). */
async function logClass(id) {
  const c = clientById(id);
  if (!c) return;
  const before = Object.fromEntries(COUNTERS.map(k => [k, c[k]]));
  c.classesDone = (+c.classesDone || 0) + 1;
  let text;
  if (isMonthly(c)) {
    const key = monthCycle(c);
    c.cycleDone = (c.cycleKey === key ? (+c.cycleDone || 0) : 0) + 1;
    c.cycleKey = key;
    text = `Attendance logged · ${c.cycleDone} this month`;
  } else {
    text = `Class logged · ${remaining(c)} left of the pack`;
  }
  const ev = pushEvent(c, 'class', text, before);
  render();
  await write('/api/class', { clientId: c.id, eventId: ev.id });
}

async function logPayment(id, amount) {
  const c = clientById(id);
  if (!c) return;
  const before = Object.fromEntries(COUNTERS.map(k => [k, c[k]]));
  let text;
  if (isMonthly(c)) {
    c.nextPayDue = addMonthISO(ymd(new Date()), 1);
    text = `${money(c, amount)} · month paid, next due ${shortDate(c.nextPayDue)}`;
  } else {
    const n = Math.round(amount / (+c.rate || 0));
    c.classesPaid = (+c.classesPaid || 0) + n;
    text = `${money(c, amount)} · +${n} class${n === 1 ? '' : 'es'} paid · ${remaining(c)} left`;
  }
  const ev = pushEvent(c, 'pay', text, before);
  render();
  await write('/api/pay', { clientId: c.id, eventId: ev.id, amount });
}

/** Undo exactly what that entry did - but only while nothing newer has touched the client. */
async function undo(ev) {
  const c = clientById(ev.client);
  if (!c) return;
  const now = JSON.stringify(COUNTERS.map(k => c[k] ?? null));
  const after = JSON.stringify(COUNTERS.map(k => (ev.after || {})[k] ?? null));
  if (now !== after) {
    banner(`${ev.clientName || 'That client'} has changed since — undo it on the PC.`);
    return;
  }
  for (const k of COUNTERS) c[k] = (ev.before || {})[k];
  ev.undone = true;
  render();
  // Never reached the PC? Then there is nothing to undo there: drop it from the queue.
  const queue = outbox.list();
  const i = queue.findIndex(o => o.body && o.body.eventId === ev.id);
  if (i >= 0) {
    queue.splice(i, 1);
    outbox.save(queue);
    keep();
    if (!queue.length) banner('');
    else showPending();
    return;
  }
  await write('/api/undo', { eventId: ev.id });
}

// ---- payment sheet ----------------------------------------------------------------
let paying = null;
function closePay() {
  paying = null;
  el('pay').hidden = true;
  el('pay-back').hidden = true;
}
function payMath() {
  const c = paying && clientById(paying);
  if (!c) return;
  const amount = +el('pay-amount').value || 0;
  const rate = +c.rate || 0;
  const out = el('pay-math');
  const go = el('pay-go');
  for (const b of el('pay-chips').children) b.classList.toggle('on', +b.dataset.amount === amount);
  if (isMonthly(c)) {
    out.textContent = `Marks this month paid · next due ${shortDate(addMonthISO(ymd(new Date()), 1))}`;
    go.disabled = false;
    return;
  }
  if (!rate) {
    out.textContent = 'No per-class rate set — set one on the PC first.';
    go.disabled = true;
    return;
  }
  const n = Math.round(amount / rate);
  go.disabled = !(amount > 0 && n >= 1);
  out.textContent = amount <= 0 ? ''
    : n < 1 ? `${money(c, amount)} is less than half a class at ${money(c, rate)}.`
      : `${money(c, amount)} ÷ ${money(c, rate)} = ${n} class${n === 1 ? '' : 'es'}`;
}
function openPay(id) {
  const c = clientById(id);
  if (!c) return;
  paying = id;
  const rate = +c.rate || 0;
  el('pay-name').textContent = c.name || c.id;
  el('pay-sub').textContent = isMonthly(c)
    ? `Monthly · ${rate ? money(c, rate) + '/month' : 'no rate set'}`
    : `${rate ? money(c, rate) + '/class' : 'no rate set'} · ${c.classesPaid || 0} paid so far`;
  el('pay-sym').textContent = c.currency === 'INR' ? '₹' : '$';
  el('pay-go').textContent = isMonthly(c) ? 'Mark month paid' : 'Log payment';
  const chips = el('pay-chips');
  chips.replaceChildren();
  if (rate) {
    for (const mult of (isMonthly(c) ? [1] : [1, 2, 4, 8, 12])) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.amount = String(rate * mult);
      b.textContent = isMonthly(c) ? money(c, rate) : `${mult} × ${money(c, rate)}`;
      b.addEventListener('click', () => { el('pay-amount').value = String(rate * mult); payMath(); });
      chips.append(b);
    }
  }
  el('pay-amount').value = rate ? String(rate) : '';
  el('pay').hidden = false;
  el('pay-back').hidden = false;
  payMath();
}
el('pay-amount').addEventListener('input', payMath);
el('pay-cancel').addEventListener('click', closePay);
el('pay-back').addEventListener('click', closePay);
el('pay').addEventListener('submit', e => {
  e.preventDefault();
  const id = paying;
  const amount = +el('pay-amount').value || 0;
  const c = clientById(id);
  if (!c) return closePay();
  if (!isMonthly(c) && !(amount > 0)) return;
  closePay();
  logPayment(id, amount || (+c.rate || 0));
});

// ---- login (ID + password, remembered on this phone) -----------------------------
let gateMode = 'login';
function showGate(mode) {
  gateMode = mode;
  const setup = mode === 'setup';
  el('gate-title').textContent = setup ? 'Create login' : 'Log in';
  el('gate-btn').textContent = setup ? 'Create' : 'Log in';
  el('gate-switch').textContent = setup ? 'Have a login? Log in' : 'First time? Create login';
  el('g-pass').autocomplete = setup ? 'new-password' : 'current-password';
  el('setup-only').hidden = !setup;
  el('g-key').required = setup;
  el('gate-msg').textContent = '';
  el('gate').hidden = false;
  el('logout').hidden = true;
}
el('gate-switch').addEventListener('click', () => showGate(gateMode === 'setup' ? 'login' : 'setup'));
el('gate').addEventListener('submit', async e => {
  e.preventDefault();
  const setup = gateMode === 'setup';
  const body = { user: el('g-user').value.trim(), password: el('g-pass').value };
  if (setup) body.key = el('g-key').value.trim();
  el('gate-btn').disabled = true;
  el('gate-msg').textContent = '';
  try {
    const r = await call(setup ? '/api/setup' : '/api/login', body, { quiet: true });
    token = r.token;
    store.set('lfc-session', token);
    el('g-pass').value = '';
    el('g-key').value = '';
    el('gate').hidden = true;
    el('logout').hidden = false;
    await load();
  } catch (err) {
    el('gate-msg').textContent = err.message === 'offline' ? OFFLINE : err.message;
  }
  el('gate-btn').disabled = false;
});
el('logout').addEventListener('click', async () => {
  try { await call('/api/logout', {}, { quiet: true }); } catch { /* logged out here anyway */ }
  token = '';
  store.set('lfc-session', '');
  store.set(CACHE, '');
  data = null;
  showGate('login');
});

// ---- boot --------------------------------------------------------------------------
async function load() {
  if (!token) return;
  await flush();
  if (outbox.list().length) { render(); showPending(); return; }   // PC still off: keep ours
  try { data = await call('/api/data'); }
  catch { render(); return; }
  keep();
  el('logout').hidden = false;
  render();
}

if (data) render();
if (token) { el('logout').hidden = false; load(); } else showGate('login');

// Come back to the page (or the app) -> catch up, and send anything that waited.
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) load(); });
window.addEventListener('focus', () => { if (token) load(); });
setInterval(() => { if (!document.hidden && token) load(); }, 60_000);
