import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { ingestBatch, fingerprintOf } from '../server/ingest.js';
import { rebuildAll, resolveCanon } from '../server/engine.js';
import { mergeEntities, undoMerge, addLabel, revokeLabel, reviewObject, HttpError } from '../server/mutations.js';
import { windowEdges, edgeEvidence, shortestPath, windowSummary } from '../server/graph.js';
import { createIdMapper, projectNode, toCsv, csvCell, policyFor } from '../server/redact.js';
import { windowOf } from './helpers.js';

const ANALYST = { actor: 'analyst', role: 'analyst' };
const ADMIN = { actor: 'admin', role: 'admin' };

function fresh() {
  const db = openDb(':memory:');
  seedDatabase(db);
  return db;
}

function edgeSnapshot(db) {
  return db.prepare(`SELECT rel_key, day, txn_count, amount_cents, late_count, duplicate_count,
      distinct_counterparties, strength, first_seen, last_seen
    FROM graph_edges ORDER BY rel_key, day`).all().map(r => ({ ...r }));
}

function compareWithRebuild(db, label) {
  const incremental = edgeSnapshot(db);
  const nodesInc = db.prepare('SELECT * FROM node_stats ORDER BY node_type, node_id').all()
    .map(r => ({ ...r, risk: Math.round(r.risk * 1e4), risk_factors: JSON.parse(r.risk_factors) }));
  rebuildAll(db, { actor: 'test', trigger: 'test:rebuild' });
  const rebuilt = edgeSnapshot(db);
  const nodesReb = db.prepare('SELECT * FROM node_stats ORDER BY node_type, node_id').all()
    .map(r => ({ ...r, risk: Math.round(r.risk * 1e4), risk_factors: JSON.parse(r.risk_factors) }));
  assert.deepEqual(incremental, rebuilt, `${label}: incremental edges must equal a full rebuild`);
  for (let i = 0; i < nodesInc.length; i++) {
    assert.equal(nodesInc[i].node_type, nodesReb[i].node_type, `${label}: node set`);
    assert.equal(nodesInc[i].node_id, nodesReb[i].node_id, `${label}: node set`);
    assert.equal(nodesInc[i].degree, nodesReb[i].degree, `${label}: degree for ${nodesInc[i].node_id}`);
    assert.equal(nodesInc[i].risk, nodesReb[i].risk, `${label}: risk for ${nodesInc[i].node_id}`);
  }
}

// ---------------------------------------------------------------------------
// Seed integrity
// ---------------------------------------------------------------------------

test('seed builds a graph whose edges reconcile to live transactions', () => {
  const db = fresh();
  const txnCount = db.prepare('SELECT COUNT(*) c FROM transactions WHERE superseded_by_id IS NULL AND is_duplicate=0').get().c;
  assert.ok(txnCount > 80, 'seeded enough live transactions');

  for (const edge of db.prepare('SELECT * FROM graph_edges').all()) {
    const evidence = db.prepare('SELECT txn_ref FROM edge_transactions WHERE edge_id=?').all(edge.id);
    assert.ok(evidence.length >= 1, `edge ${edge.rel_key}@${edge.day} has evidence`);
    const rows = evidence.map(e => db.prepare('SELECT * FROM transactions WHERE id=?').get(e.txn_ref));
    for (const row of rows) {
      assert.ok(row, 'evidence row exists');
      assert.equal(row.superseded_by_id, null, 'evidence never cites a superseded version');
      assert.equal(row.is_duplicate, 0, 'duplicate copies never support edges');
      assert.equal(row.occurred_at.slice(0, 10), edge.day, 'evidence is in the edge day bucket');
    }
    const live = rows.filter(r => !r.is_duplicate);
    assert.equal(live.length, edge.txn_count, 'txn_count equals number of distinct live evidence rows');
    assert.equal(live.reduce((a, r) => a + r.amount_cents, 0), edge.amount_cents, 'edge amount sums its evidence');
  }
});

test('duplicate delivery is recorded but excluded from aggregates', () => {
  const db = fresh();
  const before = edgeSnapshot(db);
  const replay = db.prepare("SELECT * FROM transactions WHERE txn_id='T-1000' AND is_duplicate=0").all();
  assert.equal(replay.length, 1);
  const r = replay[0];
  const res = ingestBatch(db, [{
    txn_id: r.txn_id, account_id: r.account_id, device_id: r.device_id, merchant_id: r.merchant_id,
    counterparty_account_id: r.counterparty_account_id, amount_cents: r.amount_cents,
    occurred_at: r.occurred_at, ip: r.ip, channel: r.channel,
  }], { actor: 'analyst', role: 'analyst' });
  assert.equal(res.duplicates, 1);
  assert.equal(res.accepted, 0);
  // A replay publishes a version so the duplicate tally is auditable, but it
  // must not change any economic figure.
  assert.ok(res.graph, 'replay records a graph version');
  const after = new Map(edgeSnapshot(db).map(r => [`${r.rel_key}@${r.day}`, r]));
  for (const row of before) {
    const now = after.get(`${row.rel_key}@${row.day}`);
    if (!now) continue;
    assert.equal(now.txn_count, row.txn_count, 'replay does not inflate counts');
    assert.equal(now.amount_cents, row.amount_cents, 'replay does not inflate amounts');
    assert.equal(now.strength, row.strength, 'replay does not change strength');
    assert.ok(now.duplicate_count >= row.duplicate_count);
  }
  assert.equal(db.prepare('SELECT is_late FROM transactions WHERE duplicate_of IS NOT NULL ORDER BY ingested_seq DESC LIMIT 1').get().is_late, 0,
    'a replay is not a late business event');
});

test('an upstream revision supersedes the old version and keeps it out of the graph', () => {
  const db = fresh();
  const before = db.prepare("SELECT * FROM transactions WHERE txn_id='T-2112' AND superseded_by_id IS NULL").get();
  const res = ingestBatch(db, [{
    txn_id: 'T-2112', account_id: before.account_id, device_id: before.device_id,
    merchant_id: 'MC-02', counterparty_account_id: before.counterparty_account_id,
    amount_cents: before.amount_cents, occurred_at: before.occurred_at, ip: before.ip, channel: before.channel,
  }], { actor: 'analyst', role: 'analyst' });
  assert.equal(res.revisions, 1, 'reported as a revision, not a duplicate');
  const chain = db.prepare("SELECT * FROM transactions WHERE txn_id='T-2112' ORDER BY version").all();
  // The seed already applied one correction to this record, so this is v3.
  assert.equal(chain.length, 3);
  const [prev, latest] = chain.slice(-2);
  assert.equal(prev.superseded_by_id, latest.id);
  assert.equal(latest.supersedes_id, prev.id);
  // Old merchant relation is gone, new merchant relation exists for that day.
  const day = prev.occurred_at.slice(0, 10);
  // AC-2004 also trades with MC-09 on other days, so scope the check to the
  // corrected transaction's own day bucket: only that bucket may change.
  const otherDays = db.prepare("SELECT COUNT(*) c FROM graph_edges WHERE rel_key LIKE '%AC-2004|merchant:MC-09' AND day<>?").get(day).c;
  assert.ok(otherDays > 0, 'AC-2004 still trades with MC-09 on other days');
  const oldRel = db.prepare("SELECT * FROM graph_edges WHERE rel_key LIKE '%AC-2004|merchant:MC-09' AND day=?").get(day);
  const newRel = db.prepare("SELECT * FROM graph_edges WHERE rel_key LIKE '%AC-2004|merchant:MC-02' AND day=?").get(day);
  assert.equal(oldRel, undefined, 'superseded merchant relation removed');
  assert.ok(newRel, 'corrected merchant relation present');
  const evidenceRefs = db.prepare('SELECT txn_ref FROM edge_transactions WHERE edge_id=?').all(newRel.id).map(e => e.txn_ref);
  assert.ok(!evidenceRefs.includes(prev.id), 'old version is not cited as evidence');
  assert.ok(evidenceRefs.includes(latest.id), 'new version is the evidence');
  compareWithRebuild(db, 'revision');
});

test('a duplicate copy is never used as the base for a later revision', () => {
  const db = fresh();
  const mk = (amountCents, minutesAgo) => ({
    txn_id: 'CHAIN-1', account_id: 'AC-1005', device_id: 'DV-01', merchant_id: 'MC-05',
    amount_cents: amountCents, ip: '203.0.113.10',
    occurred_at: new Date(Date.now() - minutesAgo * 60e3).toISOString(),
    received_at: new Date(Date.now() - minutesAgo * 60e3 + 30e3).toISOString(),
  });
  const original = mk(100, 300);
  const first = ingestBatch(db, [original, { ...original }], { ...ANALYST });
  assert.deepEqual(first.results.map(r => r.outcome), ['accepted', 'duplicate']);

  // The duplicate copy shares version 1 with the live row and is not
  // superseded, so a naive "superseded_by_id IS NULL" lookup would take it as
  // the base. That would mint a second version-2 row, leaving two live
  // versions of one transaction in the aggregates.
  const second = ingestBatch(db, [mk(200, 300)], { ...ANALYST });
  assert.equal(second.results[0].outcome, 'revised');
  assert.equal(second.results[0].version, 2);
  const third = ingestBatch(db, [mk(300, 300)], { ...ANALYST });
  assert.equal(third.results[0].outcome, 'revised');
  assert.equal(third.results[0].version, 3, 'each correction advances the chain by one');

  // Replaying a payload that has since been superseded must not blow up on a
  // primary-key collision; it is a correction relative to the live row.
  const replay = ingestBatch(db, [mk(200, 300)], { ...ANALYST });
  assert.equal(replay.results[0].outcome, 'revised');
  assert.equal(replay.results[0].version, 4);

  const chain = db.prepare("SELECT * FROM transactions WHERE txn_id='CHAIN-1' ORDER BY version, is_duplicate").all();
  const pristine = chain.filter(r => !r.is_duplicate);
  assert.deepEqual(pristine.map(r => r.version), [1, 2, 3, 4], 'versions never repeat');
  assert.equal(chain.filter(r => !r.is_duplicate && r.superseded_by_id === null).length, 1,
    'exactly one live version of the transaction');
  const live = pristine.find(r => r.superseded_by_id === null);
  assert.equal(live.version, 4);
  // The last delivery restated the earlier amount, so v4 carries 200 and the
  // 300 correction is retained only in the history chain.
  assert.equal(live.amount_cents, 200);
  const copy = chain.find(r => r.is_duplicate);
  assert.equal(copy.duplicate_of, pristine[0].id, 'the copy points at the original, not at a revision');

  const summary = windowSummary(db, { from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' });
  const others = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents),0) a FROM transactions
    WHERE superseded_by_id IS NULL AND is_duplicate=0 AND txn_id<>'CHAIN-1'`).get();
  assert.equal(summary.transactions, others.c + 1, 'only the live revision is counted');
  assert.equal(summary.amount_cents, others.a + 200, 'superseded and duplicate amounts stay out');
  compareWithRebuild(db, 'duplicate then revisions');
});

test('late arrival is flagged and folded into its original day bucket', () => {
  const db = fresh();
  const occurred = new Date(Date.now() - 5 * 3600e3).toISOString();
  const res = ingestBatch(db, [{
    txn_id: 'LATE-1', account_id: 'AC-1005', device_id: 'DV-01', merchant_id: 'MC-05',
    amount_cents: 777000, occurred_at: occurred, received_at: new Date().toISOString(), ip: '203.0.113.10',
  }], { actor: 'analyst', role: 'analyst' });
  assert.equal(res.late, 1);
  const row = db.prepare("SELECT * FROM transactions WHERE txn_id='LATE-1'").get();
  assert.equal(row.is_late, 1);
  assert.ok(row.late_minutes >= 295);
  const edge = db.prepare("SELECT * FROM graph_edges WHERE day=? AND rel_key LIKE ?").get(occurred.slice(0, 10), '%AC-1005%device:DV-01%');
  assert.ok(edge, 'edge lands in the occurrence day, not the receipt day');
  assert.ok(edge.late_count >= 1, 'late count propagates to the edge');
  const factors = JSON.parse(edge.factors);
  assert.ok(factors.lateMultiplier > 1, 'late evidence slightly raises strength uncertainty');
  compareWithRebuild(db, 'late ingest');
});

test('rejected records never reach the graph', () => {
  const db = fresh();
  const before = edgeSnapshot(db);
  const res = ingestBatch(db, [
    { txn_id: 'BAD-1', account_id: 'AC-1005', amount_cents: -5, occurred_at: new Date().toISOString() },
    { txn_id: 'BAD-2', account_id: 'AC-9999', amount_cents: 100, occurred_at: new Date().toISOString() },
    { txn_id: 'BAD-3', account_id: 'AC-1005', amount_cents: 100, occurred_at: 'not-a-date' },
    { txn_id: 'BAD-4', account_id: 'AC-1005', amount_cents: 100, occurred_at: new Date(Date.now() + 86400e3).toISOString() },
  ], { actor: 'analyst', role: 'analyst' });
  assert.equal(res.rejected, 4);
  assert.equal(res.accepted, 0);
  assert.equal(res.graph, null);
  assert.deepEqual(edgeSnapshot(db), before);
});

test('fingerprint distinguishes replay from correction', () => {
  const base = {
    txn_id: 'F-1', account_id: 'A', amount_cents: 100, occurred_at: '2026-01-01T00:00:00.000Z',
    device_id: 'D1', merchant_id: 'M1',
  };
  assert.equal(fingerprintOf(base), fingerprintOf({ ...base }));
  assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, merchant_id: 'M2' }));
  assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, amount_cents: 101 }));
});

// ---------------------------------------------------------------------------
// Incremental recompute
// ---------------------------------------------------------------------------

test('incremental graph equals full rebuild after each mutation kind', () => {
  let db = fresh();
  compareWithRebuild(db, 'seed');

  db = fresh();
  mergeEntities(db, { kind: 'account', sourceIds: ['AC-1002', 'AC-1004'], targetId: 'AC-1001', ...ANALYST });
  compareWithRebuild(db, 'merge');

  db = fresh();
  const merge = mergeEntities(db, { kind: 'account', sourceIds: ['AC-1002', 'AC-1004'], targetId: 'AC-1001', ...ANALYST });
  undoMerge(db, merge.merge.id, ANALYST);
  compareWithRebuild(db, 'merge+undo');

  db = fresh();
  addLabel(db, { targetType: 'account', targetId: 'AC-1005', label: 'suspicious', confidence: 0.8, ...ANALYST });
  compareWithRebuild(db, 'label');

  db = fresh();
  ingestBatch(db, [{
    txn_id: 'INC-1', account_id: 'AC-1005', device_id: 'DV-02', merchant_id: 'MC-03',
    amount_cents: 300000, occurred_at: new Date(Date.now() - 7200e3).toISOString(), ip: '203.0.113.11',
  }], ANALYST);
  compareWithRebuild(db, 'ingest');
});

test('merge only rewrites relation buckets that touch the merged node', () => {
  const db = fresh();
  const before = db.prepare('SELECT rel_key, day, computed_version FROM graph_edges').all();
  const merged = ['AC-1001', 'AC-1002', 'AC-1004'];
  const merge = mergeEntities(db, { kind: 'account', sourceIds: ['AC-1002', 'AC-1004'], targetId: 'AC-1001', ...ANALYST });
  const after = new Map(db.prepare('SELECT rel_key, day, computed_version FROM graph_edges').all().map(r => [`${r.rel_key}@${r.day}`, r]));
  // IP overlap is recomputed per (ip, day) group, and every pair in a group
  // whose membership changed is rewritten or removed. Pre-compute the groups
  // that contain a transaction of a merged account.
  const contaminatedIpDays = new Set(db.prepare(`SELECT DISTINCT ip, substr(occurred_at,1,10) AS day FROM transactions
    WHERE ip IS NOT NULL AND (account_id IN (?,?,?) OR counterparty_account_id IN (?,?,?))`)
    .all(...merged, ...merged).map(r => `ip=${r.ip}@${r.day}`));
  let untouched = 0;
  for (const row of before) {
    const key = `${row.rel_key}@${row.day}`;
    const ipDay = `${row.rel_key.split('|').find(p => p.startsWith('ip='))}@${row.day}`;
    const touchesIpGroup = row.rel_key.startsWith('ip_overlap') && contaminatedIpDays.has(ipDay);
    if (!merged.some(m => key.includes(m)) && !touchesIpGroup) {
      const now = after.get(key);
      if (!now) continue;
      assert.equal(now.computed_version, row.computed_version, `untouched bucket ${key} keeps its version`);
      untouched += 1;
    }
  }
  assert.ok(untouched > 50, `expected many untouched buckets, saw ${untouched}`);
  assert.ok(merge.stats.edges_recomputed < db.prepare('SELECT COUNT(*) c FROM graph_edges').get().c + merge.stats.edges_deleted,
    'merge recomputes less than the whole graph');
  // Version history records every recomputed bucket for the new version.
  const recorded = db.prepare('SELECT COUNT(*) c FROM edge_versions WHERE version=?').get(merge.stats.version).c;
  assert.equal(recorded, merge.stats.edges_recomputed + merge.stats.edges_deleted);
});

test('undo restores the pre-merge graph exactly', () => {
  const db = fresh();
  const before = edgeSnapshot(db);
  const merge = mergeEntities(db, { kind: 'account', sourceIds: ['AC-2001', 'AC-2003'], targetId: 'AC-2002', ...ANALYST });
  assert.notDeepEqual(edgeSnapshot(db), before, 'merge changed the graph');
  undoMerge(db, merge.merge.id, ANALYST);
  assert.deepEqual(edgeSnapshot(db), before, 'undo restores every edge figure');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM entity_aliases').get().c, 0, 'aliases removed');
  assert.equal(resolveCanon(db, 'account', 'AC-2001'), 'AC-2001');
  assert.equal(resolveCanon(db, 'account', 'AC-2003'), 'AC-2003');
});

test('merge is reversible only once and leaves an audit trail', () => {
  const db = fresh();
  const merge = mergeEntities(db, { kind: 'account', sourceIds: ['AC-2001'], targetId: 'AC-1001', ...ANALYST });
  undoMerge(db, merge.merge.id, ANALYST);
  assert.throws(() => undoMerge(db, merge.merge.id, ANALYST), /already undone/);
  const auditRows = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'merge.%'").all().map(r => r.action);
  assert.ok(auditRows.includes('merge.create'));
  assert.ok(auditRows.includes('merge.undo'));
});

test('merging the same entity twice is rejected', () => {
  const db = fresh();
  assert.throws(
    () => mergeEntities(db, { kind: 'account', sourceIds: ['AC-1001'], targetId: 'AC-1001', ...ANALYST }),
    err => err instanceof HttpError && err.status === 409,
  );
  mergeEntities(db, { kind: 'account', sourceIds: ['AC-1002'], targetId: 'AC-1001', ...ANALYST });
  assert.throws(
    () => mergeEntities(db, { kind: 'account', sourceIds: ['AC-1002'], targetId: 'AC-1003', ...ANALYST }),
    err => err instanceof HttpError && err.status === 409,
  );
});

// ---------------------------------------------------------------------------
// Traceability
// ---------------------------------------------------------------------------

test('every window edge traces back to raw transactions with matching sums', () => {
  const db = fresh();
  const w = windowOf(db);
  const edges = windowEdges(db, { ...w, limit: 500 });
  assert.ok(edges.length > 20);
  for (const edge of edges.slice(0, 40)) {
    const rows = edgeEvidence(db, edge.agg_key, w);
    assert.ok(rows.length > 0, `evidence for ${edge.agg_key}`);
    const txns = rows.map(r => db.prepare('SELECT * FROM transactions WHERE id=?').get(r.txn_ref));
    const live = txns.filter(t => t && !t.is_duplicate && !t.superseded_by_id);
    assert.equal(live.length, edge.txn_count, `txn count reconciles for ${edge.agg_key}`);
    assert.equal(live.reduce((a, t) => a + t.amount_cents, 0), edge.amount_cents, `amount reconciles for ${edge.agg_key}`);
    assert.ok(rows.every(r => r.day >= w.from.slice(0, 10) && r.day <= w.to.slice(0, 10)), 'evidence inside window');
  }
});

test('window summary counts transactions once, not once per relation', () => {
  const db = fresh();
  const w = windowOf(db);
  const summary = windowSummary(db, w);
  const live = db.prepare(`SELECT COUNT(*) c FROM transactions WHERE superseded_by_id IS NULL AND is_duplicate=0
    AND substr(occurred_at,1,10) BETWEEN ? AND ?`).get(w.from.slice(0, 10), w.to.slice(0, 10)).c;
  assert.equal(summary.transactions, live);
  assert.ok(summary.duplicates >= 5, 'duplicates are reported separately');
  assert.ok(summary.revisions >= 1, 'revisions are reported separately');
  const revisionRows = db.prepare(`SELECT COUNT(*) c FROM transactions WHERE superseded_by_id IS NOT NULL
    AND substr(occurred_at,1,10) BETWEEN ? AND ?`).get(w.from.slice(0, 10), w.to.slice(0, 10)).c;
  const supersededCopies = db.prepare(`SELECT COUNT(*) c FROM transactions WHERE superseded_by_id IS NOT NULL
    AND is_duplicate=1 AND substr(occurred_at,1,10) BETWEEN ? AND ?`).get(w.from.slice(0, 10), w.to.slice(0, 10)).c;
  assert.equal(summary.revisions, revisionRows - supersededCopies,
    'a replay that later got superseded is still a duplicate, not a correction');
  assert.ok(summary.late >= 1, 'late records are reported separately');
});

test('path search returns an evidence-bearing chain or a clean miss', () => {
  const db = fresh();
  const w = windowOf(db);
  const found = shortestPath(db, { fromType: 'account', fromId: 'AC-1002', toType: 'merchant', toId: 'MC-03', ...w, maxHops: 3 });
  assert.equal(found.found, true);
  assert.ok(found.steps.length >= 1);
  for (const step of found.steps) {
    assert.ok(step.edge.txn_count >= 1);
    assert.ok(step.edge.evidence_txn_ids.length >= 1);
  }
  assert.ok(found.confidence > 0 && found.confidence <= 1);
  const miss = shortestPath(db, { fromType: 'account', fromId: 'AC-1002', toType: 'merchant', toId: 'MC-99', ...w, maxHops: 2 });
  assert.equal(miss.found, false);
});

test('a merged node is found by any of its member ids, and path endpoints resolve', () => {
  const db = fresh();
  mergeEntities(db, { kind: 'account', sourceIds: ['AC-1002', 'AC-1004'], targetId: 'AC-1001', ...ANALYST });
  assert.equal(resolveCanon(db, 'account', 'AC-1004'), 'AC-1001');
  const w = windowOf(db);
  const viaMember = shortestPath(db, { fromType: 'account', fromId: 'AC-1004', toType: 'merchant', toId: 'MC-05', ...w, maxHops: 2 });
  const viaTarget = shortestPath(db, { fromType: 'account', fromId: 'AC-1001', toType: 'merchant', toId: 'MC-05', ...w, maxHops: 2 });
  assert.equal(viaMember.found, viaTarget.found);
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test('restricted roles only ever see projected ids, in payloads and exports', () => {
  const db = fresh();
  const viewer = createIdMapper(db, 'viewer');
  const node = projectNode('viewer', {
    id: 'AC-1001', type: 'account', label: '王海涛 · 招商银行 6222••••1001', degree: 3, risk: 0.5,
    risk_factors: {}, members: ['AC-1001', 'AC-1002'], member_count: 2, labels: [],
  });
  assert.match(node.id, /^anon_/);
  assert.ok(!JSON.stringify(node).includes('AC-1001'), 'raw account id absent');
  assert.ok(!JSON.stringify(node).includes('王海涛'), 'holder name absent');
  assert.ok(!node.raw_ref, 'raw_ref not exposed');
  const scrubbed = viewer.scrub({ agg_key: 'shared_device|account:AC-1001|device:DV-01', nested: { list: ['AC-1002'] } });
  assert.ok(!JSON.stringify(scrubbed).includes('AC-1001'));
  assert.ok(!JSON.stringify(scrubbed).includes('AC-1002'));
  assert.ok(JSON.stringify(scrubbed).includes('anon_'));
});

test('projected ids round-trip and raw ids are not an oracle', () => {
  const db = fresh();
  const viewer = createIdMapper(db, 'viewer');
  const projected = viewer.scrub('AC-1001');
  assert.equal(viewer.resolve('account', projected), 'AC-1001');
  assert.equal(viewer.resolve('account', 'AC-1001'), null, 'raw ids are not accepted from restricted roles');
  const analyst = createIdMapper(db, 'analyst');
  assert.equal(analyst.scrubbed, false);
  assert.equal(analyst.resolve('account', 'AC-1001'), 'AC-1001');
  assert.equal(analyst.resolve('account', 'AC-9999'), null);
});

test('role field policies are enforced server-side, not client-supplied', () => {
  assert.deepEqual(new Set(policyFor('auditor').fields), new Set(['amount', 'device', 'merchant', 'timing']));
  assert.ok(!policyFor('auditor').fields.has('note'));
  assert.ok(!policyFor('viewer').fields.has('account'));
  assert.equal(policyFor('viewer').identity.account, 'pseudo');
  assert.equal(policyFor('analyst').identity.account, 'raw');
});

test('CSV export neutralises formula injection', () => {
  assert.equal(csvCell('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-2'), "'-2");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  const csv = toCsv(['a', 'b'], [{ a: '=1+1', b: 'ok' }]);
  assert.equal(csv.split('\r\n')[1], "'=1+1,ok");
});

test('review follows four-eyes and updates risk only through approved labels', () => {
  const db = fresh();
  const created = addLabel(db, { targetType: 'account', targetId: 'AC-1005', label: 'confirmed_fraud', confidence: 0.9, ...ANALYST });
  const beforeReview = db.prepare("SELECT risk FROM node_stats WHERE node_type='account' AND node_id='AC-1005'").get().risk;
  assert.throws(() => reviewObject(db, {
    objectType: 'label', objectId: created.label.id, decision: 'approved', actor: 'analyst', role: 'admin',
  }), err => err instanceof HttpError && err.status === 403, 'author cannot approve their own label');
  reviewObject(db, { objectType: 'label', objectId: created.label.id, decision: 'approved', actor: 'auditor', role: 'auditor' });
  const afterReview = db.prepare("SELECT risk FROM node_stats WHERE node_type='account' AND node_id='AC-1005'").get().risk;
  assert.ok(afterReview >= beforeReview, 'approved fraud label does not lower risk');
  const r = db.prepare('SELECT * FROM labels WHERE id=?').get(created.label.id);
  assert.equal(r.review_state, 'approved');
  assert.equal(r.reviewed_by, 'auditor');
});

test('revoking a label removes its risk contribution', () => {
  const db = fresh();
  const created = addLabel(db, { targetType: 'account', targetId: 'AC-1005', label: 'suspicious', confidence: 0.9, ...ANALYST });
  const withLabel = db.prepare("SELECT risk FROM node_stats WHERE node_type='account' AND node_id='AC-1005'").get().risk;
  revokeLabel(db, created.label.id, ANALYST);
  const without = db.prepare("SELECT risk FROM node_stats WHERE node_type='account' AND node_id='AC-1005'").get().risk;
  assert.ok(without < withLabel, 'risk drops after revocation');
  assert.throws(() => revokeLabel(db, created.label.id, ANALYST), /already revoked/);
  assert.throws(() => revokeLabel(db, created.label.id, { actor: 'analyst', role: 'analyst' }), /already revoked/);
});

test('another analyst cannot revoke someone else’s label', () => {
  const db = fresh();
  const created = addLabel(db, { targetType: 'account', targetId: 'AC-1005', label: 'watchlist', confidence: 0.5, ...ANALYST });
  assert.throws(() => revokeLabel(db, created.label.id, { actor: 'analyst2', role: 'analyst' }),
    err => err instanceof HttpError && err.status === 403);
  revokeLabel(db, created.label.id, { actor: 'admin', role: 'admin' });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('graph version advances by exactly one per published change', () => {
  const db = fresh();
  const v0 = Number(db.prepare("SELECT value FROM settings WHERE key='graph_version'").get().value);
  ingestBatch(db, [{
    txn_id: 'V-1', account_id: 'AC-1005', amount_cents: 100, occurred_at: new Date(Date.now() - 1000).toISOString(),
  }], ANALYST);
  const v1 = Number(db.prepare("SELECT value FROM settings WHERE key='graph_version'").get().value);
  assert.equal(v1, v0 + 1);
  const row = db.prepare('SELECT * FROM graph_versions WHERE version=?').get(v1);
  assert.equal(row.trigger, 'ingest');
  assert.ok(row.duration_ms >= 0);
});

test('seeding twice does not duplicate data', () => {
  const db = fresh();
  const before = db.prepare('SELECT COUNT(*) c FROM transactions').get().c;
  const result = seedDatabase(db);
  assert.equal(result.seeded, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, before);
});
