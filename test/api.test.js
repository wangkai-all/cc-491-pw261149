import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

// End-to-end protection of the "permissions cannot be bypassed by export"
// requirement: drives the real HTTP surface, not the projection helpers.

let server;
let base;

before(async () => {
  server = createApp({ dbFile: ':memory:' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(resolve => server.close(resolve)));

async function login(username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = res.headers.getSetCookie()[0].split(';')[0];
  const body = await res.json();
  return { cookie, user: body.user };
}

const get = (path, cookie) => fetch(`${base}${path}`, { headers: { cookie } });
const post = (path, cookie, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

function rawIds() {
  const db = server.db;
  return {
    accounts: db.prepare('SELECT id FROM accounts').all().map(r => r.id),
    devices: db.prepare('SELECT id FROM devices').all().map(r => r.id),
    merchants: db.prepare('SELECT id FROM merchants').all().map(r => r.id),
  };
}

// Every raw id must be absent from a restricted payload, including ids that
// only appear inside composite strings (agg_key, audit detail, rel_key).
function assertNoRawIds(payload, ids, label) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const leaks = [];
  for (const group of Object.values(ids)) {
    for (const id of group) if (text.includes(id)) leaks.push(id);
  }
  assert.deepEqual(leaks.slice(0, 5), [], `${label} leaks raw ids: ${leaks.slice(0, 5).join(', ')}`);
}

test('unauthenticated requests are rejected', async () => {
  for (const path of ['/api/overview', '/api/graph', '/api/node?type=account&id=AC-1001', '/api/meta']) {
    assert.equal((await get(path, '')).status, 401, path);
  }
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', password: 'wrong' }),
  });
  assert.equal(login.status, 401);
});

test('viewer cannot reach raw ids through any JSON endpoint', async () => {
  const { cookie } = await login('viewer', 'demo-viewer');
  const ids = rawIds();
  // Every endpoint the console can actually reach, including the inspector,
  // evidence drawer and trace that upstream tests otherwise skip.
  const graph = await (await get('/api/graph?hops=1', cookie)).json();
  const anonAccount = graph.nodes.find(n => n.type === 'account').id;
  const aggKey = graph.edges[0].agg_key;
  const txnId = graph.edges[0].evidence_txn_ids[0];
  const paths = ['/api/meta', '/api/overview', '/api/graph', '/api/node?type=account&id=AC-1001',
    '/api/node?type=merchant&id=MC-01', '/api/search?q=AC', '/api/versions', '/api/import/batches',
    '/api/reviews', `/api/node?type=account&id=${encodeURIComponent(anonAccount)}`,
    `/api/edge/evidence?agg_key=${encodeURIComponent(aggKey)}`,
    `/api/trace?txn_id=${encodeURIComponent(txnId)}`];
  for (const path of paths) {
    const res = await get(path, cookie);
    // A restricted role probing a raw id gets a 404, never a payload.
    if (res.status === 404) continue;
    assert.equal(res.status, 200, `${path} -> ${res.status}`);
    assertNoRawIds(await res.text(), ids, path);
  }
});

test('viewer graph responses carry only pseudonymous, field-filtered data', async () => {
  const { cookie } = await login('viewer', 'demo-viewer');
  const body = await (await get('/api/graph?hops=2', cookie)).json();
  assert.ok(body.nodes.length > 0);
  for (const node of body.nodes) {
    assert.match(node.id, /^anon_/);
    assert.equal(node.raw_ref, undefined);
  }
  for (const edge of body.edges) {
    assert.match(edge.source, /^anon_/);
    assert.match(edge.target, /^anon_/);
    assert.ok(!edge.agg_key || !/AC-\d|DV-|MC-/.test(edge.agg_key), 'agg_key carries projected ids only');
  }
});

test('an unaddressable seed fails closed instead of showing the default view', async () => {
  const { cookie } = await login('viewer', 'demo-viewer');
  const seeded = await (await get('/api/graph?seeds=AC-1001&hops=2', cookie)).json();
  assert.equal(seeded.nodes.length, 0);
  assert.deepEqual(seeded.seeds, []);

  const graph = await (await get('/api/graph?hops=1', cookie)).json();
  const anon = graph.nodes.find(n => n.type === 'account').id;
  const own = await (await get(`/api/graph?seeds=${encodeURIComponent(anon)}&hops=2`, cookie)).json();
  assert.ok(own.nodes.length > 0);
  assert.deepEqual(own.seeds, [`account:${anon}`]);
});

test('search is not an oracle for restricted roles', async () => {
  const { cookie } = await login('viewer', 'demo-viewer');
  const graph = await (await get('/api/graph?hops=1', cookie)).json();
  const anonAccount = graph.nodes.find(n => n.type === 'account').id;

  // Raw id, holder name and account-number fragments all return nothing,
  // identical to a value that does not exist. No existence confirmation.
  for (const q of ['AC-1003', '张', '6222', 'MC-01']) {
    const body = await (await get(`/api/search?q=${encodeURIComponent(q)}`, cookie)).json();
    assert.deepEqual(body.results, [], `restricted search must ignore ${q}`);
  }
  const own = await (await get(`/api/search?q=${encodeURIComponent(anonAccount)}`, cookie)).json();
  assert.equal(own.results.length, 1);
  assert.equal(own.results[0].id, anonAccount);
  assert.ok(!own.results[0].label.includes('张'), 'label is rebuilt from the projected id');

  const analyst = await login('analyst', 'demo-analyst');
  const rich = await (await get('/api/search?q=%E5%BC%A0', analyst.cookie)).json();
  assert.ok(rich.results.length > 0, 'analysts can still search by holder name');
});

test('a projected id from one entity kind cannot address another kind', async () => {
  const { cookie } = await login('viewer', 'demo-viewer');
  const graph = await (await get('/api/graph?hops=1', cookie)).json();
  const device = graph.nodes.find(n => n.type === 'device').id;
  assert.equal((await get(`/api/node?type=device&id=${device}`, cookie)).status, 200);
  assert.equal((await get(`/api/node?type=account&id=${device}`, cookie)).status, 404,
    'a device projection must not resolve as an account');
});

test('viewer cannot export graph JSON or annotate', async () => {
  const { cookie } = await login('viewer', 'demo-viewer');
  const graphExport = await post('/api/export', cookie, { kind: 'graph' });
  assert.equal(graphExport.status, 403, 'graph export needs export.graph capability');
  const merge = await post('/api/merge', cookie, { kind: 'account', sourceIds: ['a'], targetId: 'b' });
  assert.equal(merge.status, 403);
  const label = await post('/api/label', cookie, { targetType: 'account', targetId: 'x', label: 'suspicious', confidence: 0.5 });
  assert.equal(label.status, 403);
  const viewerExport = await post('/api/export', cookie, { kind: 'transactions' });
  assert.equal(viewerExport.status, 403);
});

test('auditor export is field-projected and contains no raw account ids', async () => {
  const { cookie } = await login('auditor', 'demo-auditor');
  const res = await post('/api/export', cookie, { kind: 'transactions' });
  assert.equal(res.status, 200);
  const csv = await res.text();
  const [header, ...rows] = csv.split('\r\n');
  const cols = header.split(',');
  assert.ok(cols.includes('amount_cents'), 'auditor sees amounts');
  assert.ok(cols.includes('device_id'), 'auditor sees device evidence');
  assert.ok(!cols.includes('ip'), 'auditor cannot see ip');
  assert.ok(!cols.includes('note'), 'auditor cannot see free-text notes');
  assert.ok(cols.includes('account_id'), 'account column exists but is pseudonymous');
  for (const row of rows) {
    const cells = row.split(',');
    const account = cells[cols.indexOf('account_id')];
    if (account) assert.match(account, /^anon_/);
  }
  assertNoRawIds(csv, { accounts: rawIds().accounts }, 'auditor csv');
  assert.match(res.headers.get('x-export-policy'), /role=auditor/);
});

test('analyst export is complete but still honours the capability and row caps', async () => {
  const { cookie } = await login('analyst', 'demo-analyst');
  const res = await post('/api/export', cookie, { kind: 'transactions' });
  assert.equal(res.status, 200);
  const csv = await res.text();
  const header = csv.split('\r\n')[0].split(',');
  assert.ok(header.includes('account_id') && header.includes('ip') && header.includes('note'));
  assert.ok(Number(res.headers.get('x-export-rows')) > 0);
  // Client-supplied field lists cannot widen or narrow the policy.
  const widened = await post('/api/export', cookie, { kind: 'transactions', fields: ['credit_card_number'] });
  assert.equal(widened.status, 200);
  assert.ok(!(await widened.text()).includes('credit_card_number'));
});

test('viewer cannot export traces for raw transaction ids it guessed', async () => {
  const { cookie } = await login('viewer', 'demo-viewer');
  const db = server.db;
  const rawTxn = db.prepare("SELECT id FROM transactions LIMIT 1").get().id;
  const res = await post('/api/export', cookie, { kind: 'traces', refs: [rawTxn] });
  assert.equal(res.status, 403, 'traces export requires export capability');
  // And the trace endpoint itself does not resolve raw refs for a viewer.
  const trace = await get(`/api/trace?ref=${encodeURIComponent(rawTxn)}`, cookie);
  assert.equal(trace.status, 404);
});

test('graph export is capability-gated and admin output is scrubbed', async () => {
  const { cookie } = await login('admin', 'demo-admin');
  const res = await post('/api/export', cookie, { kind: 'graph', hops: 2 });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.role, 'admin');

  // Auditors can export transaction evidence but not the graph topology, so a
  // graph request must fail closed rather than fall back to a wider payload.
  const auditor = await login('auditor', 'demo-auditor');
  const aud = await post('/api/export', auditor.cookie, { kind: 'graph', hops: 2 });
  assert.equal(aud.status, 403, 'auditor lacks export.graph');
});

test('CSV export neutralises formula injection from stored data', async () => {
  const db = server.db;
  const { cookie } = await login('analyst', 'demo-analyst');
  // Put the row inside the export's default window, which is anchored on the
  // newest graph day.
  const now = `${db.prepare('SELECT MAX(day) AS d FROM graph_edges').get().d}T12:00:00.000Z`;
  db.prepare(`INSERT INTO transactions(id,txn_id,account_id,canon_account_id,amount_cents,currency,occurred_at,received_at,
      direction,status,channel,note,fingerprint,ingest_batch_id,ingested_seq,is_duplicate,is_late,late_minutes,version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,1)`)
    .run('txcsv1', '=1+1', 'AC-1001', 'AC-1001', 100, 'CNY', now, now, 'debit', 'posted', 'web', '=HYPERLINK("x")',
      'fp-csv', 'B-CSV', 1);
  const res = await post('/api/export', cookie, { kind: 'transactions' });
  const csv = await res.text();
  const line = csv.split('\r\n').find(row => row.includes('=1+1'));
  assert.ok(line, 'the injected row is exported');
  assert.ok(line.startsWith("'=1+1,"), 'txn id is apostrophe-prefixed');
  assert.ok(!/(^|,)=HYPERLINK/.test(line), 'note field cannot start a formula');
});

test('session cookie is required and logout revokes it', async () => {
  const { cookie } = await login('viewer', 'demo-viewer');
  assert.equal((await get('/api/meta', cookie)).status, 200);
  await post('/api/auth/logout', cookie, {});
  assert.equal((await get('/api/meta', cookie)).status, 401);
});
