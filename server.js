'use strict';
// Dashboard tiket IT: menggabungkan Watun (API), OpenProject (API v3) dan ETOffice (Google Sheet CSV).
const http = require('http');
require('dns').setDefaultResultOrder('ipv4first'); // container Docker biasanya tidak punya rute IPv6
try { require('net').setDefaultAutoSelectFamilyAttemptTimeout(3000); } catch (e) { /* Node lama */ }
const fs = require('fs');
const path = require('path');

const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const cfg = {
  port: +env('PORT', 8080),
  mock: env('MOCK') === 'true',
  debug: env('DEBUG') === 'true',
  refreshMin: Math.max(1, +env('REFRESH_MINUTES', 15)),
  authUser: env('BASIC_AUTH_USER'),
  authPass: env('BASIC_AUTH_PASS'),
  watun: {
    base: env('WATUN_BASE_URL').replace(/\/+$/, ''),
    path: env('WATUN_TICKETS_PATH', '/api/tickets'),
    key: env('WATUN_API_KEY'),
    header: env('WATUN_AUTH_HEADER', 'api'),
    scheme: env('WATUN_AUTH_SCHEME', ''),
    secret: env('WATUN_API_SECRET'),
    secretHeader: env('WATUN_SECRET_HEADER', 'api-secret'),
    paged: env('WATUN_PAGED') === 'true',
    pageParam: env('WATUN_PAGE_PARAM', 'page'),
    ticketUrl: env('WATUN_TICKET_URL', 'https://wa.farmedia.co.id/ticketing'),
  },
  op: {
    base: env('OPENPROJECT_URL').replace(/\/+$/, ''),
    key: env('OPENPROJECT_API_KEY'),
    project: env('OPENPROJECT_PROJECT'),
  },
  eto: {
    csv: env('ETO_SHEET_CSV_URL'),
    category: env('ETO_DEFAULT_CATEGORY', 'Hardware'),
  },
};

// ---------- pemetaan status (ubah di sini bila ada status baru) ----------
const STATUS_MAP = {
  WTN: { open: 'Baru', pending: 'Menunggu', proses: 'Dikerjakan', 'in progress': 'Dikerjakan', resolved: 'Selesai', closed: 'Ditutup' },
  ETO: { '': 'Baru', open: 'Baru', 'need confirmation': 'Menunggu', 'need konfirmation': 'Menunggu', 'on handle': 'Dikerjakan', resolved: 'Selesai', closed: 'Ditutup', cancelled: 'Batal', canceled: 'Batal' },
  OP: { new: 'Baru', 'in progress': 'Dikerjakan', 'on hold': 'Menunggu', closed: 'Ditutup', rejected: 'Batal', resolved: 'Selesai' },
};
const unify = (src, s) => STATUS_MAP[src][String(s || '').trim().toLowerCase()] || 'Lainnya';

// ---------- util ----------
const pick = (o, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((a, p) => (a == null ? undefined : a[p]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};
const validDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && +d.slice(0, 4) >= 2000 && +d.slice(0, 4) <= 2100 && !isNaN(Date.parse(d));
const isoDate = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  let out = null;
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/); // dd/mm/yyyy
  if (m) out = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  else if (/^\d{5}(\.\d+)?$/.test(s) && +s > 30000 && +s < 70000) {
    // nomor seri tanggal Google Sheets (sel angka yang belum berformat tanggal), mis. 45930
    out = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 864e5).toISOString().slice(0, 10);
  } else if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s) || /[A-Za-z]/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) { try { out = d.toISOString().slice(0, 10); } catch (e) { out = null; } }
  }
  return out && validDay(out) ? out : null; // di luar 2000-2100 dianggap data salah
};
const daysBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 864e5));
function finish(t) {
  const today = new Date().toISOString().slice(0, 10);
  const finished = ['Selesai', 'Ditutup', 'Batal'].includes(t.status);
  t.done = t.done || null;
  if (t.done && t.created && t.done < t.created) t.done = null; // data tidak masuk akal
  t.kode = t.kode || t.id;
  // tiket yang sudah selesai tanpa tanggal selesai: durasi tidak diketahui (jangan dihitung sampai hari ini)
  t.days = !t.created || (finished && !t.done) ? null : daysBetween(t.created, t.done || today);
  t.finished = finished;
  return t;
}

// ---------- CSV (RFC 4180 sederhana) ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- adapter Watun ----------
// Nama field API Watun belum diketahui, jadi beberapa kemungkinan dicoba berurutan.
// Setelah melihat respons asli (lihat /api/debug/raw/watun saat DEBUG=true), sesuaikan daftar di bawah.
function mapWatun(t) {
  const code = String(pick(t, 'kode_tiket', 'ticket_code', 'code', 'kode', 'ticket_id', 'id') || '');
  const status = pick(t, 'status', 'status_name', 'status.name') || '';
  return finish({
    source: 'WTN',
    id: 'WTN-' + code,
    kode: code,
    title: String(pick(t, 'subjek', 'subject', 'title', 'judul') || '(tanpa judul)'),
    category: String(pick(t, 'kategori', 'category.name', 'category_name', 'category') || ''),
    pic: String(pick(t, 'penugasan', 'assigned_to', 'assignee.name', 'cs_name', 'cs', 'divisi', 'division') || ''),
    requester: String(pick(t, 'nama', 'customer_name', 'pelanggan.nama', 'customer.name') || ''),
    status_asli: String(status),
    status: unify('WTN', status),
    created: isoDate(pick(t, 'created_at', 'dibuat', 'createdAt', 'created')),
    done: isoDate(pick(t, 'resolved_at', 'closed_at', 'completed_at', 'resolvedAt', 'closedAt')),
    link: cfg.watun.ticketUrl.includes('{id}') ? cfg.watun.ticketUrl.replace('{id}', encodeURIComponent(code)) : cfg.watun.ticketUrl,
  });
}
const listFrom = (j) => (Array.isArray(j) ? j : pick(j, 'data', 'tickets', 'items', 'results', 'rows') || []);
async function rawWatun(page) {
  const h = { Accept: 'application/json' };
  if (cfg.watun.key) h[cfg.watun.header] = cfg.watun.scheme ? `${cfg.watun.scheme} ${cfg.watun.key}` : cfg.watun.key;
  if (cfg.watun.secret) h[cfg.watun.secretHeader] = cfg.watun.secret;
  const sep = cfg.watun.path.includes('?') ? '&' : '?';
  const url = cfg.watun.base + cfg.watun.path + (page ? `${sep}${cfg.watun.pageParam}=${page}` : '');
  const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Watun HTTP ${r.status}`);
  return r.json();
}
async function fetchWatun() {
  if (!cfg.watun.base) throw new Error('WATUN_BASE_URL belum diisi');
  let all = [];
  if (!cfg.watun.paged) all = listFrom(await rawWatun());
  else {
    let first = null;
    for (let p = 1; p <= 100; p++) {
      const list = listFrom(await rawWatun(p));
      if (!list.length) break;
      const sig = JSON.stringify(list[0]);
      if (sig === first) break; // server mengulang halaman yang sama
      if (p === 1) first = sig;
      all = all.concat(list);
    }
  }
  return all.map(mapWatun);
}

// ---------- adapter OpenProject (API v3) ----------
const OP_DONE = ['closed', 'rejected', 'resolved'];
function mapOP(w) {
  const status = pick(w, '_links.status.title') || '';
  const closed = OP_DONE.includes(String(status).toLowerCase());
  return finish({
    source: 'OP',
    id: 'OP-' + w.id,
    kode: '#' + w.id,
    title: String(w.subject || '(tanpa judul)'),
    category: String(pick(w, '_links.type.title') || ''),
    pic: String(pick(w, '_links.assignee.title') || ''),
    requester: String(pick(w, '_links.author.title') || ''),
    status_asli: String(status),
    status: unify('OP', status),
    created: isoDate(w.createdAt),
    done: closed ? isoDate(w.updatedAt) : null, // perkiraan: waktu pembaruan terakhir tiket yang sudah ditutup
    link: `${cfg.op.base}/work_packages/${w.id}`,
  });
}
async function fetchOP() {
  if (!cfg.op.base || !cfg.op.key) throw new Error('OPENPROJECT_URL / OPENPROJECT_API_KEY belum diisi');
  const auth = 'Basic ' + Buffer.from('apikey:' + cfg.op.key).toString('base64');
  const root = cfg.op.project ? `/api/v3/projects/${encodeURIComponent(cfg.op.project)}/work_packages` : '/api/v3/work_packages';
  const filters = encodeURIComponent('[{"status":{"operator":"*","values":[]}}]'); // semua status, bukan hanya yang terbuka
  let all = [];
  for (let page = 1; page <= 200; page++) {
    const r = await fetch(`${cfg.op.base}${root}?pageSize=100&offset=${page}&filters=${filters}`, {
      headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`OpenProject HTTP ${r.status}`);
    const j = await r.json();
    const els = (j._embedded && j._embedded.elements) || [];
    all = all.concat(els);
    if (!els.length || all.length >= (j.total || 0)) break;
  }
  return all.map(mapOP);
}

// ---------- adapter ETOffice (Google Sheet dipublikasikan sebagai CSV) ----------
let etoMeta = null;
function mapEto(csvText) {
  const rows = parseCsv(csvText);
  const hi = rows.findIndex((r) => r.some((c) => /^status$/i.test(c.trim()) || /kode pengajuan/i.test(c.trim())));
  if (hi < 0) throw new Error('Baris header (kolom "Status" atau "Kode Pengajuan") tidak ditemukan di CSV');
  const head = rows[hi].map((c) => c.trim().toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const c = {
    desc: col(/deskripsi/), ts: col(/^timestamp$/), sched: col(/tanggal pen|tgl pen/),
    pic: col(/pic teknis/) >= 0 ? col(/pic teknis/) : col(/penanggung/), jenis: col(/jenis layanan/), dept: col(/departemen/), status: col(/^status$/),
    done: col(/selesai/), pr: col(/note|^pr/), wa: col(/whatsapp/),
    kode: col(/kode pengajuan/) >= 0 ? col(/kode pengajuan/) : col(/^kode/),
  };
  etoMeta = { kodeCol: c.kode >= 0, statusCol: c.status >= 0, linkRows: 0, header: head.filter(Boolean).slice(0, 12).join(' | ') };
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const g = (i) => (i >= 0 ? (r[i] || '').trim() : '');
    const linkCell = r.find((x) => /ticket-detail\/\d+/.test(x));
    const kodeVal = g(c.kode);
    // tanggal dibuat: diambil dari kode (IT-YYYYMMDD-nnnnn) karena formatnya pasti; cadangan: Timestamp, lalu Tanggal Penjadwalan
    const km = kodeVal.match(/^IT-(\d{4})(\d{2})(\d{2})-/i);
    const kodeDate = km ? `${km[1]}-${km[2]}-${km[3]}` : null;
    if (!linkCell && !/^IT-\d{8}-\d+/i.test(kodeVal)) continue;
    const num = linkCell ? linkCell.match(/ticket-detail\/(\d+)/)[1] : kodeVal;
    const status = g(c.status);
    out.push(finish({
      source: 'ETO',
      id: 'ETO-' + num,
      kode: g(c.kode),
      title: (g(c.desc).split('\n')[0] || '(tanpa judul)').slice(0, 120),
      category: g(c.jenis) || cfg.eto.category,
      pic: g(c.pic),
      requester: g(c.dept),
      status_asli: status,
      status: unify('ETO', status),
      created: kodeDate || isoDate(g(c.ts)) || isoDate(g(c.sched)),
      done: isoDate(g(c.done)),
      pr: g(c.pr),
      link: !linkCell ? '' : /^https?:\/\//.test(linkCell.trim()) ? linkCell.trim() : 'https://' + linkCell.trim(),
    }));
  }
  return out;
}
async function fetchEto() {
  if (!cfg.eto.csv) throw new Error('ETO_SHEET_CSV_URL belum diisi');
  const r = await fetch(cfg.eto.csv, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
  if (!r.ok) throw new Error(`Google Sheet HTTP ${r.status}`);
  return mapEto(await r.text());
}

// ---------- cache & penarikan ----------
const state = { updated: null, tickets: [], sources: { WTN: {}, ETO: {}, OP: {} } };
const adapters = { WTN: fetchWatun, ETO: fetchEto, OP: fetchOP };
const keep = {};
async function refresh() {
  if (cfg.mock) {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sample.json'), 'utf8')).map(finish);
    state.tickets = s;
    for (const k of Object.keys(adapters)) state.sources[k] = { ok: true, count: s.filter((t) => t.source === k).length, at: new Date().toISOString(), mock: true };
    state.updated = new Date().toISOString();
    return;
  }
  await Promise.all(Object.entries(adapters).map(async ([k, fn]) => {
    try {
      keep[k] = await withRetry(fn);
      state.sources[k] = { ok: true, count: keep[k].length, at: new Date().toISOString() };
      if (k === 'ETO' && etoMeta) {
        const n = [];
        if (!etoMeta.kodeCol) n.push('Kolom "Kode Pengajuan" tidak ada di tab yang dipublikasikan');
        if (!etoMeta.statusCol) n.push('Kolom "Status" tidak ada di tab ini');
        state.sources[k].note = n.join('. ');
        state.sources[k].header = etoMeta.header;
      }
    } catch (e) {
      // gagal pada satu sumber tidak mematikan yang lain; data terakhir yang berhasil tetap dipakai
      state.sources[k] = { ok: false, error: String(e.message || e) + (e.cause ? ' (' + (e.cause.code || e.cause.message) + ')' : ''), count: (keep[k] || []).length, at: new Date().toISOString() };
      console.error(`[${k}]`, e.message || e);
    }
  }));
  state.tickets = [].concat(keep.WTN || [], keep.ETO || [], keep.OP || []);
  state.updated = new Date().toISOString();
  afterRefresh();
}
const RETRY_MS = env('RETRY_DELAYS_MS', '3000,10000').split(',').map(Number).filter(Boolean);
async function withRetry(fn) {
  let err;
  for (let i = 0; i <= RETRY_MS.length; i++) {
    try { return await fn(); } catch (e) {
      err = e;
      if (/belum diisi/.test(String(e.message))) throw e; // salah pengaturan: tidak perlu mengulang
      if (i < RETRY_MS.length) await new Promise((r) => setTimeout(r, RETRY_MS[i]));
    }
  }
  throw err;
}
let quickRetry = null;
function afterRefresh() {
  const bad = Object.values(state.sources).some((x) => x && x.ok === false && !/belum diisi/.test(String(x.error)));
  if (bad && !cfg.mock && !quickRetry) quickRetry = setTimeout(() => { quickRetry = null; refreshOnce().catch(() => {}); }, 60000);
}
let running = null;
const refreshOnce = () => (running = running || refresh().finally(() => { running = null; }));

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
function authorized(req) {
  if (!cfg.authUser) return true;
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  return !!m && Buffer.from(m[1], 'base64').toString() === `${cfg.authUser}:${cfg.authPass}`;
}
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Dashboard tiket IT"' }); return res.end('Login diperlukan'); }
  try {
    if (url.pathname === '/api/tickets') return send(res, 200, state);
    if (url.pathname === '/api/refresh' && req.method === 'POST') { await refreshOnce(); return send(res, 200, { ok: true, updated: state.updated }); }
    if (cfg.debug && url.pathname === '/api/debug/raw/watun') return send(res, 200, await rawWatun(cfg.watun.paged ? 1 : 0));
    let f = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.join(__dirname, 'public', path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(full, (e, buf) => {
      if (e) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, buf, MIME[path.extname(full)] || 'application/octet-stream');
    });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
});

if (require.main === module) {
  refreshOnce().then(() => console.log(`Data awal dimuat: ${state.tickets.length} tiket`));
  setInterval(() => refreshOnce().catch((e) => console.error(e)), cfg.refreshMin * 60 * 1000);
  server.listen(cfg.port, '0.0.0.0', () => console.log(`Dashboard berjalan di port ${cfg.port}${cfg.mock ? ' (MODE CONTOH)' : ''}`));
}
module.exports = { parseCsv, mapEto, mapOP, mapWatun, cfg, unify };
