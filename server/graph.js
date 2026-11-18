import { config } from './config.js';
import { tx, audit, getGraphVersion } from './db.js';
import { resolveCanon, membersOf, splitRelKey } from './engine.js';
import { stableId } from './auth.js';

const KIND_TABLE = { account: 'accounts', device: 'devices', merchant: 'merchants' };

export function entityLabel(db, kind, id) {
  if (kind === 'account') {
    const r = db.prepare('SELECT account_no, holder_name, bank FROM accounts WHERE id=?').get(id);
    return r ? `${r.holder_name} · ${r.bank} ${maskAccount(r.account_no)}` : `账户 ${id}`;
  }
  if (kind === 'device') {
    const r = db.prepare('SELECT kind, model, fingerprint FROM devices WHERE id=?').get(id);
    return r ? `${r.model || r.kind} · ${r.fingerprint}` : `设备 ${id}`;
  }
  const r = db.prepare('SELECT name, category FROM merchants WHERE id=?').get(id);
  return r ? `${r.name}` : `商户 ${id}`;
}

export function maskAccount(no) {
  if (!no) return '';
  return no.length <= 4 ? no : `${no.slice(0, 4)}••••${no.slice(-4)}`;
}

export function nodeSummary(db, kind, rawId) {
  const canonicalId = resolveCanon(db, kind, rawId);
  const members = membersOf(db, kind, canonicalId);
  const stats = db.prepare('SELECT * FROM node_stats WHERE node_type=? AND node_id=?').get(kind, canonicalId) || {
    degree: 0, risk: 0, risk_factors: '{}', edge_strength_sum: 0, max_edge_strength: 0, txn_amount_cents: 0, late_count: 0,
    computed_version: getGraphVersion(db),
  };
  const labels = db.prepare(`SELECT * FROM labels WHERE target_type=? AND target_id=? AND revoked_at IS NULL ORDER BY created_at DESC`)
    .all(kind, canonicalId);
  const mergeRow = members.length
    ? db.prepare('SELECT * FROM merges WHERE target_id=? AND kind=? AND undone_at IS NULL ORDER BY created_at DESC').get(canonicalId, kind)
    : null;
  return {
    id: canonicalId,
    type: kind,
    label: entityLabel(db, kind, canonicalId),
    members,
    member_count: members.length || 1,
    degree: stats.degree,
    risk: stats.risk,
    risk_factors: JSON.parse(stats.risk_factors || '{}'),
    txn_amount_cents: stats.txn_amount_cents,
    late_count: stats.late_count,
    edge_strength_sum: stats.edge_strength_sum,
    max_edge_strength: stats.max_edge_strength,
    computed_version: stats.computed_version,
    review_state: mergeRow ? mergeRow.review_state : 'n/a',
    labels,
    merge: mergeRow ? { id: mergeRow.id, target_id: mergeRow.target_id, source_ids: JSON.parse(mergeRow.source_ids), created_by: mergeRow.created_by, created_at: mergeRow.created_at } : null,
  };
}

/**
 * Aggregate day-bucket edges into a window. Strength is a recomputed
 * window-level figure, not a sum of daily strengths: we re-derive it from
 * the summed evidence so overlapping windows remain comparable.
 */
export function windowEdges(db, { from, to, edgeTypes = null, minStrength = 0, limit = 2000 }) {
  const fromDay = from.slice(0, 10);
  const toDay = to.slice(0, 10);
  const types = edgeTypes && edgeTypes.length ? edgeTypes : config.edgeTypes.filter(t => t !== 'manual_link');
  const placeholders = types.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM graph_edges WHERE day>=? AND day<=? AND edge_type IN (${placeholders})`)
    .all(fromDay, toDay, ...types);

  const grouped = new Map();
  for (const row of rows) {
    const k = row.rel_key;
    let g = grouped.get(k);
    if (!g) {
      g = {
        rel_key: row.rel_key, edge_type: row.edge_type,
        src_type: row.src_type, src_id: row.src_id, dst_type: row.dst_type, dst_id: row.dst_id,
        days: [], txn_count: 0, amount_cents: 0, late_count: 0, duplicate_count: 0,
        first_seen: row.first_seen, last_seen: row.last_seen, day_strengths: [], last_version: row.computed_version,
        distinct_counterparties: 0,
      };
      grouped.set(k, g);
    }
    g.days.push(row.day);
    g.txn_count += row.txn_count;
    g.amount_cents += row.amount_cents;
    g.late_count += row.late_count;
    g.duplicate_count += row.duplicate_count;
    g.distinct_counterparties = Math.max(g.distinct_counterparties, row.distinct_counterparties);
    g.day_strengths.push({ day: row.day, strength: row.strength, txn_count: row.txn_count });
    if (row.first_seen < g.first_seen) g.first_seen = row.first_seen;
    if (row.last_seen > g.last_seen) g.last_seen = row.last_seen;
    g.last_version = Math.max(g.last_version, row.computed_version);
  }

  const out = [];
  for (const g of grouped.values()) {
    const lateShare = g.txn_count ? g.late_count / g.txn_count : 0;
    const countScore = Math.log1p(g.txn_count) / Math.log1p(40);
    const amountScore = Math.log1p(g.amount_cents / 100) / Math.log1p(500000);
    const spanDays = new Set(g.days).size;
    const dayScore = Math.min(spanDays, 7) / 7;
    const strength = Math.min(1, (0.5 * Math.min(1, countScore) + 0.38 * Math.min(1, amountScore) + 0.12 * dayScore) * (1 + 0.15 * lateShare));
    if (strength * 100 < minStrength) continue;
    const { a, b } = splitRelKey(g.rel_key);
    out.push({
      id: `${g.edge_type}:${stableId(g.rel_key, fromDay, toDay)}`,
      agg_key: g.rel_key,
      edge_type: g.edge_type,
      src_type: a.type, src_id: a.id,
      dst_type: b?.type || a.type, dst_id: b?.id || a.id,
      strength: Math.round(strength * 10000) / 10000,
      txn_count: g.txn_count,
      amount_cents: g.amount_cents,
      late_count: g.late_count,
      duplicate_count: g.duplicate_count,
      distinct_counterparties: g.distinct_counterparties,
      day_count: spanDays,
      first_seen: g.first_seen,
      last_seen: g.last_seen,
      computed_version: g.last_version,
      days: g.days.sort(),
      day_strengths: g.day_strengths.sort((x, y) => x.day.localeCompare(y.day)),
      evidence_txn_ids: db.prepare(`SELECT et.txn_ref FROM edge_transactions et JOIN graph_edges ge ON ge.id=et.edge_id
        WHERE ge.rel_key=? AND ge.day>=? AND ge.day<=? LIMIT 12`).all(g.rel_key, fromDay, toDay).map(r => r.txn_ref),
    });
  }
  out.sort((x, y) => y.strength - x.strength || y.txn_count - x.txn_count);
  return out.slice(0, limit);
}

export function edgeEvidence(db, aggKey, { from, to, role }) {
  const rows = db.prepare(`SELECT ge.day, ge.id AS edge_id, ge.strength, ge.txn_count, ge.amount_cents,
      et.txn_ref, et.contribution, et.flags
    FROM graph_edges ge JOIN edge_transactions et ON et.edge_id=ge.id
    WHERE ge.rel_key=? AND ge.day>=? AND ge.day<=?
    ORDER BY ge.day DESC, et.txn_ref`).all(aggKey, from.slice(0, 10), to.slice(0, 10));
  return rows;
}

export function graphAround(db, { from, to, seeds, hops = 2, edgeTypes, minStrength = 0, limitNodes = 120 }) {
  const edges = windowEdges(db, { from, to, edgeTypes, minStrength, limit: 4000 });
  const adjacency = new Map();
  const add = (id, e) => {
    if (!adjacency.has(id)) adjacency.set(id, []);
    adjacency.get(id).push(e);
  };
  for (const e of edges) {
    add(`${e.src_type}:${e.src_id}`, e);
    add(`${e.dst_type}:${e.dst_id}`, e);
  }
  let frontier = (seeds || []).map(s => (s.includes(':') ? s : `account:${s}`));
  if (!frontier.length) {
    // No seed: pick the highest-risk nodes present in the window.
    const ranked = [...adjacency.keys()].sort((x, y) => {
      const sx = nodeStat(db, x)?.risk || 0;
      const sy = nodeStat(db, x)?.risk || 0;
      return sy - sx;
    });
    frontier = ranked.slice(0, 6);
  }
  const visited = new Set();
  const nodeEdges = new Map();
  let current = frontier.filter(f => adjacency.has(f));
  for (const f of current) visited.add(f);
  for (let hop = 0; hop < Math.min(hops, config.graphHopLimit); hop++) {
    const next = new Set();
    for (const node of current) {
      for (const e of adjacency.get(node) || []) {
        const other = `${e.src_type}:${e.src_id}` === node ? `${e.dst_type}:${e.dst_id}` : `${e.src_type}:${e.src_id}`;
        nodeEdges.set(e.agg_key, e);
        if (!visited.has(other)) { visited.add(other); next.add(other); }
      }
    }
    current = [...next];
    if (!current.length) break;
    if (visited.size > limitNodes * 3) break;
  }
  const keptEdges = [...nodeEdges.values()].filter(e => visited.has(`${e.src_type}:${e.src_id}`) && visited.has(`${e.dst_type}:${e.dst_id}`));
  const score = id => nodeStat(db, id);
  const ranked = [...visited].map(id => {
    const [type, raw] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    const s = score(id);
    return { type, id: raw, key: id, risk: s?.risk ?? 0, degree: s?.degree ?? 0 };
  }).sort((a, b) => b.risk - a.risk).slice(0, limitNodes);
  const keep = new Set(ranked.map(n => n.key));
  return {
    seeds: frontier,
    nodes: ranked,
    edges: keptEdges.filter(e => keep.has(`${e.src_type}:${e.src_id}`) || keep.has(`${e.dst_type}:${e.dst_id}`)),
    truncated: visited.size > ranked.length,
    window: { from, to },
  };
}

function nodeStat(db, key) {
  const idx = key.indexOf(':');
  return db.prepare('SELECT risk, degree FROM node_stats WHERE node_type=? AND node_id=?').get(key.slice(0, idx), key.slice(idx + 1));
}

// ---------------------------------------------------------------------------
// Shortest path with evidence
// ---------------------------------------------------------------------------

export function shortestPath(db, { fromType, fromId, toType, toId, from, to, maxHops = 3, minStrength = 0 }) {
  const start = `${fromType}:${resolveCanon(db, fromType, fromId)}`;
  const goal = `${toType}:${resolveCanon(db, toType, toId)}`;
  const edges = windowEdges(db, { from, to, minStrength, limit: 6000 });
  const adjacency = new Map();
  for (const e of edges) {
    const a = `${e.src_type}:${e.src_id}`;
    const b = `${e.dst_type}:${e.dst_id}`;
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push({ other: b, edge: e });
    if (e.edge_type !== 'amount_flow') adjacency.get(b).push({ other: a, edge: e });
  }
  const prev = new Map([[start, null]]);
  let frontier = [start];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next = [];
    for (const node of frontier) {
      for (const { other, edge } of adjacency.get(node) || []) {
        if (prev.has(other)) continue;
        prev.set(other, { node, edge });
        if (other === goal) {
          const chain = [];
          let cursor = goal;
          while (prev.get(cursor)) {
            const step = prev.get(cursor);
            chain.unshift({ from: step.node, to: cursor, edge: step.edge });
            cursor = step.node;
          }
          return {
            found: true, hops: chain.length, start, goal,
            nodes: [start, ...chain.map(c => c.to)],
            steps: chain.map(c => ({
              from: c.edge.src_id, to: c.edge.dst_id,
              from_type: c.edge.src_type, to_type: c.edge.dst_type,
              direction_forward: `${c.edge.src_type}:${c.edge.src_id}` === c.from,
              edge: c.edge,
            })),
            confidence: Math.round(chain.reduce((acc, c) => acc * Math.max(0.05, c.edge.strength), 1) * 10000) / 10000,
            weakest: Math.min(...chain.map(c => c.edge.strength)),
          };
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return { found: false, start, goal, searched_hops: maxHops };
}

export function windowSummary(db, { from, to }) {
  const fromDay = from.slice(0, 10), toDay = to.slice(0, 10);
  const edges = db.prepare(`SELECT COUNT(*) AS n FROM graph_edges WHERE day>=? AND day<=?`).get(fromDay, toDay).n;
  // Counts come from live transactions, not edge membership: one transaction
  // can support several relations, so summing edge counts would inflate totals.
  const live = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS amount, COALESCE(SUM(is_late),0) AS late
    FROM transactions WHERE superseded_by_id IS NULL AND is_duplicate=0 AND substr(occurred_at,1,10)>=? AND substr(occurred_at,1,10)<=?`)
    .get(fromDay, toDay);
  const dups = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE is_duplicate=1
    AND substr(occurred_at,1,10)>=? AND substr(occurred_at,1,10)<=?`).get(fromDay, toDay).n;
  // Superseded versions are history, not duplicates: a correction restates the
  // same delivery and only the live version counts. Replays are counted apart.
  const revisions = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE superseded_by_id IS NOT NULL AND is_duplicate=0
    AND substr(occurred_at,1,10)>=? AND substr(occurred_at,1,10)<=?`).get(fromDay, toDay).n;
  const nodes = db.prepare('SELECT COUNT(*) AS n FROM node_stats WHERE degree>0').get().n;
  const days = db.prepare('SELECT DISTINCT day FROM graph_edges WHERE day>=? AND day<=? ORDER BY day').all(fromDay, toDay).map(r => r.day);
  return {
    edges, transactions: live.n, amount_cents: live.amount,
    late: live.late, duplicates: dups, revisions, active_nodes: nodes, days,
    version: getGraphVersion(db),
  };
}
