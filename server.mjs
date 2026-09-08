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
    round TEXT NOT NULL, module TEXT NOT NULL, case_id TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (round, module, case_id));
  CREATE TABLE IF NOT EXISTS remarks (
    round TEXT NOT NULL, module TEXT NOT NULL, case_id TEXT NOT NULL, text TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (round, module, case_id));
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

/* A database written before rounds existed has no `round` column, and SQLite
   cannot add one to a primary key - the table has to be rebuilt. Everything
   already recorded belongs to the first round. Remarks also carried a `section`
   column back when a remark belonged to a section rather than a case. */
const lacksRound = t => !db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'round');
function migrate() {
  const old = ['results', 'remarks'].filter(lacksRound);
  if (!old.length) return;
  db.exec('BEGIN');
  try {
    if (old.includes('results')) db.exec(`
      CREATE TABLE results_new (
        round TEXT NOT NULL, module TEXT NOT NULL, case_id TEXT NOT NULL, value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (round, module, case_id));
      INSERT INTO results_new (round, module, case_id, value, updated_at)
        SELECT 'R1', module, case_id, value, updated_at FROM results;
      DROP TABLE results;
      ALTER TABLE results_new RENAME TO results;`);
    if (old.includes('remarks')) {
      const col = db.prepare('PRAGMA table_info(remarks)').all().some(c => c.name === 'case_id')
        ? 'case_id' : 'section';
      db.exec(`
        CREATE TABLE remarks_new (
          round TEXT NOT NULL, module TEXT NOT NULL, case_id TEXT NOT NULL, text TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (round, module, case_id));
        INSERT INTO remarks_new (round, module, case_id, text, updated_at)
          SELECT 'R1', module, ${col}, text, updated_at FROM remarks;
        DROP TABLE remarks;
        ALTER TABLE remarks_new RENAME TO remarks;`);
    }
    // Session details were global before rounds; they described that one session,
    // which is now round 1. Leave already-scoped and internal keys alone.
    for (const { key } of db.prepare('SELECT key FROM meta').all()) {
      if (key.startsWith('__') || /^R\d+\./.test(key)) continue;
      db.prepare('UPDATE meta SET key = ? WHERE key = ?').run('R1.' + key, key);
    }
    db.exec('COMMIT');
    console.log(`  Migrated ${old.join(' and ')} into round R1.`);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
migrate();

const q = {
  allResults: db.prepare('SELECT round, module, case_id, value FROM results'),
  allRemarks: db.prepare('SELECT round, module, case_id, text FROM remarks'),
  allMeta:    db.prepare('SELECT key, value FROM meta'),
  setResult:  db.prepare(`INSERT INTO results (round, module, case_id, value) VALUES (?, ?, ?, ?)
                          ON CONFLICT(round, module, case_id) DO UPDATE SET value = excluded.value,
                          updated_at = datetime('now')`),
  clrModule:  db.prepare('DELETE FROM results WHERE round = ? AND module = ?'),
  clrRemarks: db.prepare('DELETE FROM remarks WHERE round = ? AND module = ?'),
  setRemark:  db.prepare(`INSERT INTO remarks (round, module, case_id, text) VALUES (?, ?, ?, ?)
                          ON CONFLICT(round, module, case_id) DO UPDATE SET text = excluded.text,
                          updated_at = datetime('now')`),
  setMeta:    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
                          ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                          updated_at = datetime('now')`),
  dropRound:  db.prepare('DELETE FROM results WHERE round = ?'),
  dropRoundR: db.prepare('DELETE FROM remarks WHERE round = ?'),
  dropRoundM: db.prepare("DELETE FROM meta WHERE key LIKE ? || '.%'"),
};

// Bumped on every write; clients poll it and only refetch when it moves.
let revision = 1;

// res and rem are keyed round -> module -> case id.
function readState() {
  const res = {}, rem = {}, meta = {};
  for (const r of q.allResults.all()) ((res[r.round] ??= {})[r.module] ??= {})[r.case_id] = r.value;
  for (const r of q.allRemarks.all()) ((rem[r.round] ??= {})[r.module] ??= {})[r.case_id] = r.text;
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

    // { round, module, cases: {id: "P"/"F"/"N"}, remarks: {caseId: text} }
    // - replaces that module within that round only
    if (path === '/api/module' && req.method === 'PUT') {
      const b = await body(req);
      if (!b.module) return json(res, 400, { error: 'module required' });
      if (!b.round)  return json(res, 400, { error: 'round required' });
      db.exec('BEGIN');
      try {
        q.clrModule.run(b.round, b.module);
        q.clrRemarks.run(b.round, b.module);
        for (const [id, v] of Object.entries(b.cases || {})) {
          if (v === 'P' || v === 'F' || v === 'N') q.setResult.run(b.round, b.module, id, v);
        }
        for (const [caseId, text] of Object.entries(b.remarks || {})) {
          if (String(text ?? '').trim()) q.setRemark.run(b.round, b.module, String(caseId), String(text));
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      revision++;
      return json(res, 200, { ok: true, revision });
    }

    // { round } - discards a round and everything recorded under it
    if (path === '/api/round' && req.method === 'DELETE') {
      const b = await body(req);
      if (!b.round) return json(res, 400, { error: 'round required' });
      db.exec('BEGIN');
      try {
        q.dropRound.run(b.round);
        q.dropRoundR.run(b.round);
        q.dropRoundM.run(b.round);   // R2.date, R2.sig_client, ...
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
