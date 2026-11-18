import { config } from './config.js';
import { stableId } from './auth.js';
import { getGraphVersion, bumpGraphVersion, tx } from './db.js';

// ---------------------------------------------------------------------------
// Entity resolution
// ---------------------------------------------------------------------------

export function resolveCanon(db, kind, id) {
  if (id == null) return null;
  let current = id;
  for (let i = 0; i < 16; i++) {
    const row = db.prepare('SELECT canonical_id FROM entity_aliases WHERE kind=? AND alias_id=?').get(kind, current);
    if (!row) return current;
    if (row.canonical_id === current) return current;
    current = row.canonical_id;
  }
  throw new Error('alias cycle detected');
}

export function canonicalKeysForTxn(db, row) {
  return {
    account: resolveCanon(db, 'account', row.account_id),
    device: row.device_id ? resolveCanon(db, 'device', row.device_id) : null,
    merchant: row.merchant_id ? resolveCanon(db, 'merchant', row.merchant_id) : null,
    counterparty: row.counterparty_account_id ? resolveCanon(db, 'account', row.counterparty_account_id) : null,
  };
}

export function membersOf(db, kind, canonicalId) {
  const rows = db.prepare('SELECT alias_id FROM entity_aliases WHERE kind=? AND canonical_id=? ORDER BY alias_id')
    .all(kind, canonicalId);
  return rows.map(r => r.alias_id);
}

export function canonicalNodeId(db, node) {
  return resolveCanon(db, node.type, node.id);
}

// ---------------------------------------------------------------------------
// Relation derivation
// ---------------------------------------------------------------------------

const DAY_SQL = "substr(occurred_at,1,10)";

export function relationSpecs(row) {
  const specs = [];
  const day = row.occurred_at.slice(0, 10);
  if (row.canon_device_id) {
    specs.push({
      edge_type: 'shared_device',
      aType: 'account', aId: row.canon_account_id,
      bType: 'device', bId: row.canon_device_id,
      undirected: true, day,
    });
  }
  if (row.canon_merchant_id) {
    specs.push({
      edge_type: 'merchant_link',
      aType: 'account', aId: row.canon_account_id,
      bType: 'merchant', bId: row.canon_merchant_id,
      undirected: false, day,
    });
  }
  if (row.canon_counterparty_id && row.canon_counterparty_id !== row.canon_account_id) {
    specs.push({
      edge_type: 'amount_flow',
      aType: 'account', aId: row.canon_account_id,
      bType: 'account', bId: row.canon_counterparty_id,
      undirected: false, day,
    });
  }
  if (row.ip) {
    specs.push({
      edge_type: 'ip_overlap',
      ipGroup: true, ip: row.ip,
      aType: 'account', aId: row.canon_account_id,
      day,
    });
  }
  return specs;
}

export function relKeyOf(spec, bIdOverride) {
  if (spec.edge_type === 'ip_overlap') {
    const [a, b] = [spec.aId, bIdOverride].sort();
    return `ip_overlap|ip=${spec.ip}|account:${a}|account:${b}`;
  }
  if (spec.undirected) {
    const [a, b] = [`${spec.aType}:${spec.aId}`, `${spec.bType}:${spec.bId}`].sort();
    return `${spec.edge_type}|${a}|${b}`;
  }
  return `${spec.edge_type}|${spec.aType}:${spec.aId}|${spec.bType}:${spec.bId}`;
}

export function edgeIdOf(relKey, day) {
  return `e_${stableId(relKey, day)}`;
}

export function splitRelKey(relKey) {
  const [edgeType, ...parts] = relKey.split('|');
  const ipPart = parts.find(p => p.startsWith('ip='));
  const endpointParts = parts.filter(p => !p.startsWith('ip='));
  const parse = p => {
    const idx = p.indexOf(':');
    return { type: p.slice(0, idx), id: p.slice(idx + 1) };
  };
  const a = parse(endpointParts[0]);
  const b = endpointParts[1] ? parse(endpointParts[1]) : null;
  return { edgeType, ip: ipPart ? ipPart.slice(3) : null, a, b };
}

// ---------------------------------------------------------------------------
// Strength
// ---------------------------------------------------------------------------

function strengthOf({ txnCount, amountCents, lateShare, days }) {
  const countScore = Math.log1p(txnCount) / Math.log1p(40);
  const amountScore = Math.log1p(Math.max(0, amountCents) / 100) / Math.log1p(500000);
  const dayScore = Math.min(days, 7) / 7;
  const raw = 0.5 * Math.min(1, countScore) + 0.38 * Math.min(1, amountScore) + 0.12 * dayScore;
  const latePenalty = 1 + 0.15 * lateShare;
  const value = raw * latePenalty;
  return {
    value: Math.round(Math.min(1, value) * 10000) / 10000,
    factors: {
      countScore: Math.round(Math.min(1, countScore) * 1000) / 1000,
      amountScore: Math.round(Math.min(1, amountScore) * 1000) / 1000,
      dayScore: Math.round(dayScore * 1000) / 1000,
      lateMultiplier: Math.round(latePenalty * 1000) / 1000,
      formula: 'min(1, 0.50*log(txn)/log(40) + 0.38*log(CNY)/log(500k) + 0.12*days/7) * (1+0.15*late_share)',
    },
  };
}

// ---------------------------------------------------------------------------
// Edge recompute
// ---------------------------------------------------------------------------

function aggregateTxnRows(rows) {
  let txnCount = 0, amountCents = 0, lateCount = 0, duplicateCount = 0;
  const days = new Set();
  let firstSeen = null, lastSeen = null;
  const evidence = [];
  const counterparties = new Set();
  for (const row of rows) {
    if (!row.is_duplicate) {
      txnCount += 1;
      amountCents += row.amount_cents;
      if (row.is_late) lateCount += 1;
      days.add(row.occurred_at.slice(0, 10));
      // Duplicate copies are counted, never cited: evidence must point at the
      // canonical occurrence.
      evidence.push(row);
    } else {
      duplicateCount += 1;
    }
    if (row.counterparty_account_id) counterparties.add(row.counterparty_account_id);
    if (!firstSeen || row.occurred_at < firstSeen) firstSeen = row.occurred_at;
    if (!lastSeen || row.occurred_at > lastSeen) lastSeen = row.occurred_at;
  }
  return { txnCount, amountCents, lateCount, duplicateCount, days: days.size, firstSeen, lastSeen, evidence, counterparties };
}

function computeEdgeRow(edgeType, relKey, day, rows, version) {
  const agg = aggregateTxnRows(rows);
  if (agg.evidence.length === 0) return null;
  const lateShare = agg.txnCount ? agg.lateCount / agg.txnCount : 0;
  const { value, factors } = strengthOf({
    txnCount: agg.txnCount,
    amountCents: agg.amountCents,
    lateShare,
    days: agg.days,
  });
  const { a, b } = splitRelKey(relKey);
  return {
    id: edgeIdOf(relKey, day),
    rel_key: relKey,
    edge_type: edgeType,
    src_type: a.type, src_id: a.id,
    dst_type: b?.type || a.type, dst_id: b?.id || a.id,
    day,
    txn_count: agg.txnCount,
    amount_cents: agg.amountCents,
    late_count: agg.lateCount,
    duplicate_count: agg.duplicateCount,
    distinct_counterparties: agg.counterparties.size,
    strength: value,
    factors: JSON.stringify({ ...factors, late_count: agg.lateCount, duplicate_count: agg.duplicateCount }),
    first_seen: agg.firstSeen,
    last_seen: agg.lastSeen,
    computed_version: version,
    evidence: agg.evidence.map(row => ({
      txn_ref: row.id,
      contribution: row.is_duplicate ? 0 : (agg.txnCount ? 1 / agg.txnCount : 0),
      flags: { late: Boolean(row.is_late), duplicate: Boolean(row.is_duplicate), version: row.version },
    })),
  };
}

function deleteEdge(db, edge) {
  db.prepare('DELETE FROM graph_edges WHERE id=?').run(edge.id);
}

function writeEdgeVersion(db, version, edge, action, beforeStrength) {
  db.prepare(`INSERT OR REPLACE INTO edge_versions(version,rel_key,edge_type,src_type,src_id,dst_type,dst_id,day,action,strength_before,strength_after,txn_count_after)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(version, edge.rel_key, edge.edge_type, edge.src_type, edge.src_id, edge.dst_type, edge.dst_id, edge.day,
      action, beforeStrength, edge.strength, edge.txn_count);
}

function upsertEdge(db, edge) {
  const existing = db.prepare('SELECT * FROM graph_edges WHERE id=?').get(edge.id);
  if (existing) {
    db.prepare(`UPDATE graph_edges SET txn_count=?, amount_cents=?, late_count=?, duplicate_count=?, distinct_counterparties=?,
      strength=?, factors=?, first_seen=?, last_seen=?, computed_version=? WHERE id=?`)
      .run(edge.txn_count, edge.amount_cents, edge.late_count, edge.duplicate_count, edge.distinct_counterparties,
        edge.strength, edge.factors, edge.first_seen, edge.last_seen, edge.computed_version, edge.id);
    db.prepare('DELETE FROM edge_transactions WHERE edge_id=?').run(edge.id);
  } else {
    db.prepare(`INSERT INTO graph_edges(id,rel_key,edge_type,src_type,src_id,dst_type,dst_id,day,txn_count,amount_cents,
      late_count,duplicate_count,distinct_counterparties,strength,factors,first_seen,last_seen,computed_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(edge.id, edge.rel_key, edge.edge_type, edge.src_type, edge.src_id, edge.dst_type, edge.dst_id, edge.day,
        edge.txn_count, edge.amount_cents, edge.late_count, edge.duplicate_count, edge.distinct_counterparties,
        edge.strength, edge.factors, edge.first_seen, edge.last_seen, edge.computed_version);
  }
  const ins = db.prepare('INSERT OR REPLACE INTO edge_transactions(edge_id,txn_ref,contribution,flags) VALUES(?,?,?,?)');
  for (const e of edge.evidence) ins.run(edge.id, e.txn_ref, e.contribution, JSON.stringify(e.flags));
  return existing;
}

function fetchRelRows(db, spec, relKey, day) {
  const { a, b } = splitRelKey(relKey);
  if (spec.edge_type === 'shared_device') {
    return db.prepare(`SELECT * FROM transactions WHERE canon_account_id=? AND canon_device_id=? AND substr(occurred_at,1,10)=?
      AND superseded_by_id IS NULL`).all(a.id, b.id, day);
  }
  if (spec.edge_type === 'merchant_link') {
    return db.prepare(`SELECT * FROM transactions WHERE canon_account_id=? AND canon_merchant_id=? AND substr(occurred_at,1,10)=?
      AND superseded_by_id IS NULL`).all(a.id, b.id, day);
  }
  if (spec.edge_type === 'amount_flow') {
    return db.prepare(`SELECT * FROM transactions WHERE canon_account_id=? AND canon_counterparty_id=? AND substr(occurred_at,1,10)=?
      AND superseded_by_id IS NULL`).all(a.id, b.id, day);
  }
  if (spec.edge_type === 'ip_overlap') {
    const ip = spec.ip || splitRelKey(relKey).ip;
    return db.prepare(`SELECT * FROM transactions WHERE ip=? AND substr(occurred_at,1,10)=?
      AND (canon_account_id=? OR canon_account_id=?) AND superseded_by_id IS NULL`)
      .all(ip, day, a.id, b.id);
  }
  throw new Error(`unsupported edge type ${spec.edge_type}`);
}

/**
 * Recompute only the relation-day buckets that can have changed.
 * `targets` is a set of {edge_type, rel_key, day}. IP overlap additionally
 * needs its (ip, day) group so pair edges that disappeared are removed.
 */
function recomputeTargets(db, targets, version) {
  let edgesRecomputed = 0, edgesDeleted = 0;
  const touched = new Set();

  const ipGroups = new Map();
  for (const t of targets) {
    if (t.edge_type === 'ip_overlap') {
      const { ip } = splitRelKey(t.rel_key);
      ipGroups.set(`${ip}|${t.day}`, { ip, day: t.day });
    }
  }

  for (const t of targets) {
    if (t.edge_type === 'ip_overlap') continue;
    const spec = { edge_type: t.edge_type };
    const rows = fetchRelRows(db, spec, t.rel_key, t.day);
    const before = db.prepare('SELECT * FROM graph_edges WHERE id=?').get(edgeIdOf(t.rel_key, t.day));
    const edge = rows.length ? computeEdgeRow(t.edge_type, t.rel_key, t.day, rows, version) : null;
    const { a, b } = splitRelKey(t.rel_key);
    touched.add(`${a.type}:${a.id}`);
    if (b) touched.add(`${b.type}:${b.id}`);
    if (!edge || edge.txn_count === 0) {
      if (before) { deleteEdge(db, before); edgesDeleted += 1; }
      if (edge) writeEdgeVersion(db, version, edge, 'delete', before?.strength ?? null);
      else if (before) {
        writeEdgeVersion(db, version, {
          rel_key: t.rel_key, edge_type: t.edge_type, src_type: a.type, src_id: a.id,
          dst_type: b?.type || a.type, dst_id: b?.id || a.id, day: t.day,
          strength: 0, txn_count: 0,
        }, 'delete', before.strength);
      }
      continue;
    }
    const prior = upsertEdge(db, edge);
    writeEdgeVersion(db, version, edge, prior ? 'update' : 'create', prior?.strength ?? null);
    edgesRecomputed += 1;
  }

  for (const { ip, day } of ipGroups.values()) {
    const prefix = `ip_overlap|ip=${ip}|`;
    const existing = db.prepare("SELECT * FROM graph_edges WHERE edge_type='ip_overlap' AND day=? AND rel_key LIKE ?")
      .all(day, `${prefix}%`);
    for (const e of existing) {
      const { a, b } = splitRelKey(e.rel_key);
      touched.add(`${a.type}:${a.id}`);
      if (b) touched.add(`${b.type}:${b.id}`);
      deleteEdge(db, e);
      edgesDeleted += 1;
      writeEdgeVersion(db, version, {
        rel_key: e.rel_key, edge_type: 'ip_overlap', src_type: a.type, src_id: a.id,
        dst_type: b?.type || a.type, dst_id: b?.id || a.id, day, strength: 0, txn_count: 0,
      }, 'delete', e.strength);
    }
    const accounts = db.prepare(`SELECT DISTINCT canon_account_id FROM transactions
      WHERE ip=? AND substr(occurred_at,1,10)=? AND superseded_by_id IS NULL`).all(ip, day).map(r => r.canon_account_id);
    for (const id of accounts) touched.add(`account:${id}`);
    for (let i = 0; i < accounts.length; i++) {
      for (let j = i + 1; j < accounts.length; j++) {
        const relKey = `ip_overlap|ip=${ip}|account:${accounts[i]}|account:${accounts[j]}`;
        const rows = fetchRelRows(db, { edge_type: 'ip_overlap' }, relKey, day);
        const edge = rows.length ? computeEdgeRow('ip_overlap', relKey, day, rows, version) : null;
        if (edge && edge.txn_count > 0) {
          upsertEdge(db, edge);
          writeEdgeVersion(db, version, edge, 'create', null);
          edgesRecomputed += 1;
        }
      }
    }
  }

  return { edgesRecomputed, edgesDeleted, touched };
}

// ---------------------------------------------------------------------------
// Node stats (lifetime). Recomputed only for touched canonical nodes.
// ---------------------------------------------------------------------------

export function computeNodeStats(db, type, id, version = null) {
  const edges = db.prepare(`SELECT * FROM graph_edges WHERE txn_count>0 AND
    ((src_type=? AND src_id=?) OR (dst_type=? AND dst_id=?))`).all(type, id, type, id);
  let riskAcc = 0;
  let amount = 0;
  let late = 0;
  const neighborTypes = {};
  let maxEdge = 0;
  for (const e of edges) {
    riskAcc += e.strength;
    amount += e.amount_cents;
    late += e.late_count;
    maxEdge = Math.max(maxEdge, e.strength);
    const otherType = e.src_type === type && e.src_id === id ? e.dst_type : e.src_type;
    neighborTypes[otherType] = (neighborTypes[otherType] || 0) + 1;
  }
  // Bounded so that broad-but-weak neighbourhoods do not saturate: exposure
  // grows with total evidence weight but is anchored by the strongest edge.
  const exposure = 1 - Math.exp(-0.30 * riskAcc);
  const base = Math.min(1, 0.55 * exposure + 0.45 * maxEdge);
  const labels = db.prepare(`SELECT label, COUNT(*) AS n FROM labels WHERE target_type=? AND target_id=?
    AND revoked_at IS NULL AND review_state!='rejected' GROUP BY label`).all(type, id);
  let labelBoost = 0;
  const boosts = {};
  for (const l of labels) {
    const b = { confirmed_fraud: 0.3, suspicious: 0.16, watchlist: 0.08, legitimate: -0.22 }[l.label] || 0;
    labelBoost += b;
    boosts[l.label] = b;
  }
  const lateBoost = Math.min(0.12, late * 0.01);
  const risk = Math.max(0, Math.min(1, base + labelBoost + lateBoost));
  return {
    node_type: type, node_id: id,
    degree: edges.length,
    edge_strength_sum: Math.round(riskAcc * 10000) / 10000,
    max_edge_strength: maxEdge,
    txn_amount_cents: amount,
    late_count: late,
    risk: Math.round(risk * 10000) / 10000,
    risk_factors: { base: Math.round(base * 10000) / 10000, labels: boosts, label_boost: labelBoost, late_boost: lateBoost, neighbors: neighborTypes },
    computed_version: version ?? getGraphVersion(db),
  };
}

function refreshNodeStats(db, touched, version = null) {
  const stmt = db.prepare(`INSERT INTO node_stats(node_type,node_id,degree,edge_strength_sum,max_edge_strength,txn_amount_cents,late_count,risk,risk_factors,computed_version)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(node_type,node_id) DO UPDATE SET degree=excluded.degree, edge_strength_sum=excluded.edge_strength_sum,
    max_edge_strength=excluded.max_edge_strength, txn_amount_cents=excluded.txn_amount_cents, late_count=excluded.late_count,
    risk=excluded.risk, risk_factors=excluded.risk_factors, computed_version=excluded.computed_version`);
  for (const key of touched) {
    const idx = key.indexOf(':');
    const type = key.slice(0, idx);
    const id = key.slice(idx + 1);
    const s = computeNodeStats(db, type, id, version);
    stmt.run(s.node_type, s.node_id, s.degree, s.edge_strength_sum, s.max_edge_strength, s.txn_amount_cents,
      s.late_count, s.risk, JSON.stringify(s.risk_factors), s.computed_version);
  }
}

// ---------------------------------------------------------------------------
// Public recompute entrypoint
// ---------------------------------------------------------------------------

/**
 * Apply a graph delta.
 * @param {object} p
 * @param {Array<object>} p.rowsBefore transaction rows in their pre-change shape
 * @param {Array<object>} p.rowsAfter transaction rows in their post-change shape
 * @param {object} p.actor
 * @param {string} p.trigger
 * @param {Array<{type:string,id:string}>} [p.statsOnly] nodes whose labels changed
 */
export function applyGraphDelta(db, { rowsBefore = [], rowsAfter = [], actor = 'system', trigger = 'ingest', statsOnly = [], detail = null }) {
  const started = Date.now();
  const version = getGraphVersion(db) + 1;
  const targets = new Map();
  const addSpec = (spec, relKey, dayOverride = null) => {
    if (spec.edge_type === 'ip_overlap') {
      targets.set(`ip_overlap|${spec.ip}|${spec.day}|${relKey}`, { edge_type: 'ip_overlap', rel_key: relKey, day: spec.day, ip: spec.ip });
      return;
    }
    const day = dayOverride || spec.day;
    targets.set(`${spec.edge_type}|${relKey}|${day}`, { edge_type: spec.edge_type, rel_key: relKey, day });
  };

  // Only relations whose membership actually changed are recomputed. A row
  // that keeps the same relation key (e.g. account↔device while its
  // counterparty changes) leaves that bucket untouched, which is what makes
  // the affected subgraph genuinely smaller than the graph.
  const beforeByRef = new Map(rowsBefore.map(r => [r.id, r]));
  const afterByRef = new Map(rowsAfter.map(r => [r.id, r]));
  const relKeysOf = row => new Set(relationSpecs(row).filter(s => !s.ipGroup && s.aId !== s.bId).map(s => relKeyOf(s)));
  const changedRefs = new Set([...beforeByRef.keys(), ...afterByRef.keys()]);
  const changedNonIpKeys = new Map(); // relKey -> set of days
  const noteKey = (key, day) => {
    if (!changedNonIpKeys.has(key)) changedNonIpKeys.set(key, new Set());
    changedNonIpKeys.get(key).add(day);
  };
  for (const ref of changedRefs) {
    const beforeKeys = beforeByRef.has(ref) ? relKeysOf(beforeByRef.get(ref)) : new Set();
    const afterKeys = afterByRef.has(ref) ? relKeysOf(afterByRef.get(ref)) : new Set();
    const beforeRow = beforeByRef.get(ref);
    const afterRow = afterByRef.get(ref);
    for (const key of beforeKeys) {
      if (!afterKeys.has(key)) noteKey(key, (beforeRow?.occurred_at || afterRow?.occurred_at).slice(0, 10));
    }
    for (const key of afterKeys) {
      if (!beforeKeys.has(key)) noteKey(key, (afterRow?.occurred_at || beforeRow?.occurred_at).slice(0, 10));
    }
  }

  const ipGroups = new Map();
  for (const row of [...rowsBefore, ...rowsAfter]) {
    for (const spec of relationSpecs(row)) {
      if (spec.ipGroup) {
        ipGroups.set(`${spec.ip}|${spec.day}`, { ip: spec.ip, day: spec.day });
      }
    }
  }
  // Enumerate pairs in both before and after states so that pair edges that
  // no longer exist are removed, not orphaned.
  for (const { ip, day } of ipGroups.values()) {
    const accountsBefore = rowsBefore.filter(r => r.ip === ip && r.occurred_at.slice(0, 10) === day)
      .map(r => r.canon_account_id);
    const accountsAfter = rowsAfter.filter(r => r.ip === ip && r.occurred_at.slice(0, 10) === day)
      .map(r => r.canon_account_id);
    // The other side of the pair is usually NOT in this delta (it arrived in an
    // earlier batch), so the current database state must be part of the union.
    // Missing this produced ip_overlap edges that only existed when both sides
    // happened to arrive together.
    const accountsStored = db.prepare(`SELECT DISTINCT canon_account_id AS id FROM transactions
      WHERE ip=? AND substr(occurred_at,1,10)=? AND superseded_by_id IS NULL`).all(ip, day).map(r => r.id);
    const accounts = [...new Set([...accountsBefore, ...accountsAfter, ...accountsStored])];
    for (let i = 0; i < accounts.length; i++) {
      for (let j = i + 1; j < accounts.length; j++) {
        if (accounts[i] === accounts[j]) continue;
        const [a, b] = [accounts[i], accounts[j]].sort();
        const spec = { edge_type: 'ip_overlap', ip, day, aType: 'account', aId: a };
        addSpec(spec, relKeyOf(spec, b));
      }
    }
  }
  for (const [key, days] of changedNonIpKeys) {
    const edgeType = key.slice(0, key.indexOf('|'));
    for (const day of days) addSpec({ edge_type: edgeType }, key, day);
  }

  const result = recomputeTargets(db, [...targets.values()], version);
  for (const n of statsOnly) result.touched.add(`${n.type}:${n.id}`);
  // Always refresh both endpoints of changed relations plus stats-only nodes.
  refreshNodeStats(db, result.touched, version);

  const graphVersion = bumpGraphVersion(db, {
    trigger,
    actor,
    affectedNodes: result.touched.size,
    edgesRecomputed: result.edgesRecomputed,
    edgesDeleted: result.edgesDeleted,
    durationMs: Date.now() - started,
    detail: { ...detail, rows: rowsAfter.length + rowsBefore.length },
  });
  return { version: graphVersion, ...result, touched: [...result.touched] };
}

// Full rebuild used by seeding and by merge undo when a wide repair is safer.
export function rebuildAll(db, { actor = 'system', trigger = 'rebuild', detail = null } = {}) {
  const started = Date.now();
  const version = getGraphVersion(db) + 1;
  db.exec('DELETE FROM graph_edges');
  db.exec('DELETE FROM node_stats');
  const touched = new Set();
  let edgesRecomputed = 0;

  const rows = db.prepare('SELECT * FROM transactions WHERE superseded_by_id IS NULL').all();
  const groups = new Map();
  const ipGroups = new Map();
  for (const row of rows) {
    for (const spec of relationSpecs(row)) {
      if (spec.ipGroup) {
        const gk = `${spec.ip}|${spec.day}`;
        if (!ipGroups.has(gk)) ipGroups.set(gk, { ip: spec.ip, day: spec.day, accounts: new Set() });
        ipGroups.get(gk).accounts.add(spec.aId);
        continue;
      }
      if (spec.aId === spec.bId) continue;
      const rk = relKeyOf(spec);
      const k = `${spec.edge_type}|${rk}|${spec.day}`;
      if (!groups.has(k)) groups.set(k, { edge_type: spec.edge_type, rel_key: rk, day: spec.day });
    }
  }
  for (const g of groups.values()) {
    const { a, b } = splitRelKey(g.rel_key);
    const spec = { edge_type: g.edge_type };
    const groupRows = fetchRelRows(db, spec, g.rel_key, g.day);
    if (!groupRows.length) continue;
    const edge = computeEdgeRow(g.edge_type, g.rel_key, g.day, groupRows, version);
    if (!edge || edge.txn_count === 0) continue;
    upsertEdge(db, edge);
    writeEdgeVersion(db, version, edge, 'create', null);
    edgesRecomputed += 1;
    touched.add(`${a.type}:${a.id}`);
    if (b) touched.add(`${b.type}:${b.id}`);
  }
  for (const { ip, day, accounts } of ipGroups.values()) {
    const ids = [...accounts].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const rk = `ip_overlap|ip=${ip}|account:${ids[i]}|account:${ids[j]}`;
        const groupRows = fetchRelRows(db, { edge_type: 'ip_overlap' }, rk, day);
        if (!groupRows.length) continue;
        const edge = computeEdgeRow('ip_overlap', rk, day, groupRows, version);
        if (!edge || edge.txn_count === 0) continue;
        upsertEdge(db, edge);
        writeEdgeVersion(db, version, edge, 'create', null);
        edgesRecomputed += 1;
        touched.add(`account:${ids[i]}`);
        touched.add(`account:${ids[j]}`);
      }
    }
  }
  refreshNodeStats(db, touched, version);
  const graphVersion = bumpGraphVersion(db, {
    trigger, actor, affectedNodes: touched.size, edgesRecomputed, edgesDeleted: 0,
    durationMs: Date.now() - started, detail,
  });
  return { version: graphVersion, edgesRecomputed, nodes: touched.size };
}

export function txnToCanonicalRow(db, row) {
  const canon = canonicalKeysForTxn(db, row);
  return {
    ...row,
    canon_account_id: canon.account,
    canon_device_id: canon.device,
    canon_merchant_id: canon.merchant,
    canon_counterparty_id: canon.counterparty,
  };
}

export function recanonicalizeTransaction(db, row) {
  const canon = canonicalKeysForTxn(db, row);
  db.prepare(`UPDATE transactions SET canon_account_id=?, canon_device_id=?, canon_merchant_id=?, canon_counterparty_id=? WHERE id=?`)
    .run(canon.account, canon.device, canon.merchant, canon.counterparty, row.id);
  return { ...row, canon_account_id: canon.account, canon_device_id: canon.device, canon_merchant_id: canon.merchant, canon_counterparty_id: canon.counterparty };
}

export function transactionsReferencing(db, kind, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const col = kind === 'account'
    ? `(account_id IN (${placeholders}) OR counterparty_account_id IN (${placeholders}))`
    : `${kind === 'device' ? 'device_id' : 'merchant_id'} IN (${placeholders})`;
  const params = kind === 'account' ? [...ids, ...ids] : ids;
  return db.prepare(`SELECT * FROM transactions WHERE superseded_by_id IS NULL AND ${col}`).all(...params);
}

export { tx };
