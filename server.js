'use strict';
/* Servidor de Auralis: sirve el juego (public/index.html) y guarda el ranking global.
   Sin DATABASE_URL guarda en un archivo JSON (solo para probar en local).
   Con DATABASE_URL (Postgres de Render) los datos persisten entre reinicios. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_AURAS = Number(process.env.MAX_AURAS) || 80;                // sube este valor si añades auras
const MAX_PTS_PER_AURA = Number(process.env.MAX_PTS_PER_AURA) || 1200; // puntos máximos que puede dar una sola aura
const MIN_POST_GAP_MS = Number(process.env.MIN_POST_GAP_MS) || 8000;   // mínimo entre envíos del mismo jugador
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};

/* ---------- Validación de lo que envía el cliente ---------- */
const text = (v, max, def = '') => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || def;
const int = (v, max) => { v = Number(v); return Number.isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : null; };
function validate(b) {
  if (!b || typeof b !== 'object') return {error: 'cuerpo inválido'};
  const pid = String(b.pid || '');
  if (!/^[a-f0-9]{16,64}$/.test(pid)) return {error: 'id inválido'};
  const p = {pid, name: text(b.name, 16, 'Jugador'), title: text(b.title, 30, 'Novato'), rar: text(b.rar, 30, '—'),
    pts: int(b.pts, 1e7), rolls: int(b.rolls, 1e10), disc: int(b.disc, 1000), play: int(b.play, 1e10), rarO: int(b.rarO, 1e12)};
  if ([p.pts, p.rolls, p.disc, p.play, p.rarO].some(v => v === null)) return {error: 'números inválidos'};
  // Comprobaciones de plausibilidad (el juego corre en el navegador, así que esto solo frena lo más burdo)
  if (p.disc > MAX_AURAS) return {error: 'demasiadas auras'};
  if (p.pts > p.disc * MAX_PTS_PER_AURA + Math.floor(p.rolls / 10) + 50) return {error: 'puntos imposibles'};
  if (p.rolls > p.play * 6 + 100) return {error: 'tiradas imposibles'};
  if (p.rarO > Math.max(50, p.rolls * 50000)) return {error: 'rareza imposible'};
  return p;
}
// Una fila por jugador: se conserva la mejor partida (por puntos) y el aura más rara de todas
function merge(old, inc, now) {
  if (!old) return {...inc, updated: now};
  const best = inc.pts >= old.pts ? inc : old;
  return {pid: inc.pid, name: inc.name, title: inc.title, pts: best.pts, rolls: best.rolls, disc: best.disc, play: best.play,
    rar: inc.rarO > old.rarO ? inc.rar : old.rar, rarO: Math.max(inc.rarO, old.rarO), updated: now};
}
const pub = (r, i, pid) => ({rank: i + 1, name: r.name, title: r.title, pts: r.pts, rolls: r.rolls, disc: r.disc, rar: r.rar, rarO: r.rarO, play: r.play, me: r.pid === pid});

/* ---------- Almacenamiento ---------- */
function createFileStore(file) {
  let db = {players: {}}, timer = null;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* archivo nuevo */ }
  if (!db.players) db.players = {};
  const flush = () => { timer = null; try { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); } catch (e) { console.error('No se pudo guardar:', e.message); } };
  process.on('SIGTERM', () => { if (timer) flush(); process.exit(0); });
  return {
    kind: 'archivo JSON (' + file + ')',
    async get(pid) { return db.players[pid] || null; },
    async put(p) { db.players[p.pid] = p; if (!timer) timer = setTimeout(flush, 2000); },
    async boards(limit, pid) {
      const all = Object.values(db.players);
      const byPts = [...all].sort((a, b) => b.pts - a.pts || a.updated - b.updated);
      const byRare = [...all].sort((a, b) => b.rarO - a.rarO || a.updated - b.updated);
      const mi = byPts.findIndex(r => r.pid === pid);
      return {total: all.length, byPts: byPts.slice(0, limit).map((r, i) => pub(r, i, pid)), byRare: byRare.slice(0, limit).map((r, i) => pub(r, i, pid)),
        me: mi >= 0 ? {rank: mi + 1, pts: byPts[mi].pts} : null};
    }
  };
}
async function createPgStore(url) {
  let Pool;
  try { ({Pool} = require('pg')); } catch (e) { throw new Error('Falta el módulo "pg". Ejecuta npm install.'); }
  const ssl = process.env.PGSSL === 'disable' || /localhost|127\.0\.0\.1/.test(url) ? false : {rejectUnauthorized: false};
  const pool = new Pool({connectionString: url, ssl, max: 5});
  await pool.query(`CREATE TABLE IF NOT EXISTS players (
    pid TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, pts INTEGER NOT NULL, rolls BIGINT NOT NULL,
    disc INTEGER NOT NULL, play BIGINT NOT NULL, rar TEXT NOT NULL, rar_o DOUBLE PRECISION NOT NULL, updated BIGINT NOT NULL)`);
  await pool.query('CREATE INDEX IF NOT EXISTS players_pts_idx ON players (pts DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS players_rar_idx ON players (rar_o DESC)');
  const row = r => ({pid: r.pid, name: r.name, title: r.title, pts: r.pts, rolls: Number(r.rolls), disc: r.disc, play: Number(r.play), rar: r.rar, rarO: r.rar_o, updated: Number(r.updated)});
  return {
    kind: 'PostgreSQL',
    async get(pid) { const r = await pool.query('SELECT * FROM players WHERE pid=$1', [pid]); return r.rows[0] ? row(r.rows[0]) : null; },
    async put(p) {
      await pool.query(`INSERT INTO players (pid,name,title,pts,rolls,disc,play,rar,rar_o,updated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (pid) DO UPDATE SET name=$2,title=$3,pts=$4,rolls=$5,disc=$6,play=$7,rar=$8,rar_o=$9,updated=$10`,
        [p.pid, p.name, p.title, p.pts, p.rolls, p.disc, p.play, p.rar, p.rarO, p.updated]);
    },
    async boards(limit, pid) {
      const [a, b, t, m] = await Promise.all([
        pool.query('SELECT * FROM players ORDER BY pts DESC, updated ASC LIMIT $1', [limit]),
        pool.query('SELECT * FROM players ORDER BY rar_o DESC, updated ASC LIMIT $1', [limit]),
        pool.query('SELECT count(*)::int AS n FROM players'),
        pid ? pool.query('SELECT pts, (SELECT count(*)::int + 1 FROM players WHERE pts > p.pts) AS rank FROM players p WHERE pid=$1', [pid]) : Promise.resolve({rows: []})
      ]);
      return {total: t.rows[0].n, byPts: a.rows.map((r, i) => pub(row(r), i, pid)), byRare: b.rows.map((r, i) => pub(row(r), i, pid)),
        me: m.rows[0] ? {rank: m.rows[0].rank, pts: m.rows[0].pts} : null};
    }
  };
}

/* ---------- HTTP ---------- */
const lastPost = new Map(), ipHits = new Map(), cache = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of lastPost) if (t - v > 3600e3) lastPost.delete(k); for (const [k, v] of ipHits) if (!v.some(x => t - x < 60e3)) ipHits.delete(k); }, 600e3).unref();
const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'};
function send(res, code, obj, extra = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...CORS, ...extra});
  res.end(body);
}
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { if (n - c.length <= limit) reject(Object.assign(new Error('demasiado grande'), {status: 413})); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }

function makeApp(store) {
  async function api(req, res, url) {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (url.pathname === '/api/health') return send(res, 200, {ok: true, storage: store.kind});
    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit')) || 50));
      const pid = /^[a-f0-9]{16,64}$/.test(url.searchParams.get('pid') || '') ? url.searchParams.get('pid') : '';
      const key = limit + ':' + pid, hit = cache.get(key);
      if (hit && Date.now() - hit.t < 5000) return send(res, 200, hit.v);
      const v = await store.boards(limit, pid); cache.set(key, {t: Date.now(), v}); if (cache.size > 500) cache.clear();
      return send(res, 200, v);
    }
    if (url.pathname === '/api/score' && req.method === 'POST') {
      const ip = clientIp(req), now = Date.now(), hits = (ipHits.get(ip) || []).filter(x => now - x < 60e3);
      if (hits.length >= 40) return send(res, 429, {error: 'demasiadas peticiones'});
      hits.push(now); ipHits.set(ip, hits);
      let body; try { body = await readBody(req); } catch (e) { return send(res, e.status || 400, {error: e.message}, e.status ? {Connection: 'close'} : {}); }
      const p = validate(body); if (p.error) return send(res, 422, {error: p.error});
      if (now - (lastPost.get(p.pid) || 0) < MIN_POST_GAP_MS) return send(res, 429, {error: 'espera unos segundos'});
      lastPost.set(p.pid, now);
      const merged = merge(await store.get(p.pid), p, now); await store.put(merged); cache.clear();
      return send(res, 200, {ok: true, pts: merged.pts});
    }
    return send(res, 404, {error: 'no existe'});
  }
  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'}); return res.end('No encontrado'); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'});
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(req, res, url);
    } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, {error: 'error del servidor'}); }
  };
}

async function main() {
  const store = process.env.DATABASE_URL ? await createPgStore(process.env.DATABASE_URL)
    : createFileStore(process.env.DATA_FILE || path.join(__dirname, 'data', 'players.json'));
  http.createServer(makeApp(store)).listen(PORT, '0.0.0.0', () => console.log(`Auralis en el puerto ${PORT} · almacenamiento: ${store.kind}`));
}
main().catch(e => { console.error(e); process.exit(1); });
