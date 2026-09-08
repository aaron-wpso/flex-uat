// FLEX Phase 1 UAT - local check-off server.
// Zero dependencies: node:http + node:sqlite (Node 22.5+). Run: node server.mjs
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { networkInterfaces } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4180);
const DB_PATH = join(HERE, 'uat.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS results (
    module TEXT NOT NULL, case_id TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (module, case_id));
  CREATE TABLE IF NOT EXISTS remarks (
    module TEXT NOT NULL, section TEXT NOT NULL, text TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (module, section));
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

const q = {
  allResults: db.prepare('SELECT module, case_id, value FROM results'),
  allRemarks: db.prepare('SELECT module, section, text FROM remarks'),
  allMeta:    db.prepare('SELECT key, value FROM meta'),
  setResult:  db.prepare(`INSERT INTO results (module, case_id, value) VALUES (?, ?, ?)
                          ON CONFLICT(module, case_id) DO UPDATE SET value = excluded.value,
                          updated_at = datetime('now')`),
  delResult:  db.prepare('DELETE FROM results WHERE module = ? AND case_id = ?'),
  clrModule:  db.prepare('DELETE FROM results WHERE module = ?'),
  clrRemarks: db.prepare('DELETE FROM remarks WHERE module = ?'),
  setRemark:  db.prepare(`INSERT INTO remarks (module, section, text) VALUES (?, ?, ?)
                          ON CONFLICT(module, section) DO UPDATE SET text = excluded.text,
                          updated_at = datetime('now')`),
  setMeta:    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
                          ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                          updated_at = datetime('now')`),
};

// Bumped on every write; clients poll it and only refetch when it moves.
let revision = 1;

function readState() {
  const res = {}, rem = {}, meta = {};
  for (const r of q.allResults.all()) (res[r.module] ??= {})[r.case_id] = r.value;
  for (const r of q.allRemarks.all()) (rem[r.module] ??= {})[r.section] = r.text;
  for (const r of q.allMeta.all()) meta[r.key] = r.value;
  return { revision, res, rem, meta };
}

const body = req => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

const json = (res, code, obj) => {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (path === '/api/state' && req.method === 'GET') return json(res, 200, readState());

    if (path === '/api/revision' && req.method === 'GET') return json(res, 200, { revision });

    // { module, cases: {id: "P"/"F"/"N"}, remarks: {caseId: text} } - full module replace
    if (path === '/api/module' && req.method === 'PUT') {
      const b = await body(req);
      if (!b.module) return json(res, 400, { error: 'module required' });
      db.exec('BEGIN');
      try {
        q.clrModule.run(b.module);
        q.clrRemarks.run(b.module);   // remarks are per case now: replace, don't accumulate
        for (const [id, v] of Object.entries(b.cases || {})) {
          if (v === 'P' || v === 'F' || v === 'N') q.setResult.run(b.module, id, v);
        }
        for (const [caseId, text] of Object.entries(b.remarks || {})) {
          if (String(text ?? '').trim()) q.setRemark.run(b.module, String(caseId), String(text));
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      revision++;
      return json(res, 200, { ok: true, revision });
    }

    if (path === '/api/meta' && req.method === 'PUT') {
      const b = await body(req);
      for (const [k, v] of Object.entries(b || {})) q.setMeta.run(k, String(v ?? ''));
      revision++;
      return json(res, 200, { ok: true, revision });
    }

    if (path === '/api/reset' && req.method === 'POST') {
      db.exec('DELETE FROM results; DELETE FROM remarks; DELETE FROM meta;');
      revision++;
      return json(res, 200, { ok: true });
    }

    // static
    const file = path === '/' ? '/index.html' : path;
    if (file.includes('..')) return json(res, 400, { error: 'bad path' });
    const data = await readFile(join(HERE, 'docs', file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream',
                         'cache-control': 'no-store' });
    res.end(data);
  } catch (err) {
    if (err && err.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    console.error(err);
    json(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces()).flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log('\n  FLEX Phase 1 UAT - check-off server');
  console.log('  ----------------------------------');
  console.log(`  This machine   http://localhost:${PORT}`);
  lan.forEach(a => console.log(`  Same network   http://${a}:${PORT}`));
  console.log(`  Database       ${DB_PATH}`);
  console.log('  Ctrl+C to stop. Results are saved as you tick.\n');
});
