'use strict';
// Uji cepat: sumber palsu untuk Watun, OpenProject dan Google Sheet CSV, lalu cek hasil gabungan.
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const csv = [
  ',,,,,,,',
  'Link permohonan,Deskripsi permohonan,Tanggal Pengajuan,Penanggung jawab,Status,note / PR,tangal selesai,Whatsapp User',
  'etoffice.ethos.co.id/ticket-detail/830,"Service Laptop Axioo type hype 1",26/05/2026,Subhan aji,closed,PR/S/2026/07/13/1478,12/06/2026,',
  'https://etoffice.ethos.co.id/ticket-detail/849,"Pengajuan Akses CCTV Kantor Laban 1, ke handphone",30/05/2026,Subhan aji,On Handle,,,',
  'bukan baris tiket,,,,,,,',
].join('\n');

const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/sheet.csv') { res.setHeader('Content-Type', 'text/csv'); return res.end(csv); }
  if (u.pathname === '/api/tickets') {
    if (req.headers.authorization !== 'Bearer WK') { res.statusCode = 401; return res.end('no'); }
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ data: [
      { kode_tiket: 'TCK20261020FZTS', subjek: 'Error Office dan Printer Brother Laban 1', kategori: 'Hardware', penugasan: 'Teknisi Cilacap', status: 'Closed', created_at: '2026-10-20T10:23:00Z', closed_at: '2026-10-20T15:00:00Z' },
      { kode_tiket: 'TCK20261015AAAA', subjek: 'Menunggu sparepart', kategori: 'Hardware', penugasan: 'Teknisi Cilacap', status: 'Pending', created_at: '2026-10-15T08:00:00Z' },
    ] }));
  }
  if (u.pathname === '/api/v3/work_packages') {
    const want = 'Basic ' + Buffer.from('apikey:OPK').toString('base64');
    if (req.headers.authorization !== want) { res.statusCode = 401; return res.end('no'); }
    if (!decodeURIComponent(u.search).includes('"operator":"*"')) { res.statusCode = 400; return res.end('filter semua status wajib'); }
    const page = +u.searchParams.get('offset');
    const els = page === 1 ? [
      { id: 3019, subject: 'Penambahan kabel lan 3 titik', createdAt: '2026-10-15T01:00:00Z', updatedAt: '2026-10-16T01:00:00Z', _links: { status: { title: 'New' }, type: { title: 'TASK' }, assignee: { title: 'Y-' } } },
      { id: 1582, subject: 'rubah PR ram pc ke ram laptop', createdAt: '2026-06-01T01:00:00Z', updatedAt: '2026-06-10T01:00:00Z', _links: { status: { title: 'Closed' }, type: { title: 'TASK' } } },
    ] : [];
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ total: 2, count: els.length, pageSize: 100, _embedded: { elements: els } }));
  }
  res.statusCode = 404; res.end('nf');
});

fake.listen(0, '127.0.0.1', async () => {
  const fp = fake.address().port;
  const base = `http://127.0.0.1:${fp}`;
  const app = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '18080', MOCK: 'false', WATUN_BASE_URL: base, WATUN_API_KEY: 'WK', OPENPROJECT_URL: base, OPENPROJECT_API_KEY: 'OPK', ETO_SHEET_CSV_URL: base + '/sheet.csv', BASIC_AUTH_USER: 'u', BASIC_AUTH_PASS: 'p' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const fail = (m) => { console.error('GAGAL:', m); app.kill(); fake.close(); process.exit(1); };
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const noAuth = await fetch('http://127.0.0.1:18080/api/tickets');
    if (noAuth.status !== 401) fail('basic auth tidak aktif');
    const h = { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };
    const j = await (await fetch('http://127.0.0.1:18080/api/tickets', { headers: h })).json();
    console.log(JSON.stringify(j.sources));
    const by = (id) => j.tickets.find((t) => t.id === id);
    const chk = (c, m) => { if (!c) fail(m); };
    chk(j.tickets.length === 6, 'jumlah tiket ' + j.tickets.length + ', seharusnya 6');
    chk(by('ETO-830').status === 'Ditutup' && by('ETO-830').created === '2026-05-26' && by('ETO-830').done === '2026-06-12', 'ETO-830');
    chk(by('ETO-849').status === 'Dikerjakan' && by('ETO-849').title.startsWith('Pengajuan Akses CCTV') && by('ETO-849').link.startsWith('https://'), 'ETO-849');
    chk(by('WTN-TCK20261020FZTS').status === 'Ditutup' && by('WTN-TCK20261020FZTS').done === '2026-10-20', 'WTN closed');
    chk(by('WTN-TCK20261015AAAA').status === 'Menunggu' && !by('WTN-TCK20261015AAAA').finished, 'WTN pending');
    chk(by('OP-3019').status === 'Baru' && by('OP-3019').pic === 'Y-' && by('OP-3019').link.endsWith('/work_packages/3019'), 'OP-3019');
    chk(by('OP-1582').status === 'Ditutup' && by('OP-1582').done === '2026-06-10', 'OP-1582');
    chk(j.tickets.every((t) => t.status !== 'Lainnya'), 'ada status tak terpetakan');
    const page = await fetch('http://127.0.0.1:18080/', { headers: h });
    chk(page.status === 200 && (await page.text()).includes('Monitoring tiket IT'), 'halaman utama');
    const trav = await fetch('http://127.0.0.1:18080/..%2fserver.js', { headers: h });
    chk(trav.status !== 200 || !(await trav.text()).includes('createServer'), 'path traversal');
    console.log('SEMUA UJI LULUS');
  } catch (e) { fail(e.stack); }
  app.kill(); fake.close();
});
