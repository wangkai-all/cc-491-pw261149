import { config } from './config.js';
import { pseudonym } from './auth.js';

// ---------------------------------------------------------------------------
// Central projection layer. Every API response and every export goes through
// these functions. Client-supplied field lists are never honoured, so a role
// cannot widen its own visibility.
// ---------------------------------------------------------------------------

const ALL_FIELDS = ['amount', 'ip', 'device', 'merchant', 'counterparty', 'note', 'account', 'timing', 'channel'];

const POLICY = {
  admin: {
    fields: new Set(ALL_FIELDS),
    identity: { account: 'raw', device: 'raw', merchant: 'raw' },
  },
  analyst: {
    fields: new Set(ALL_FIELDS),
    identity: { account: 'raw', device: 'raw', merchant: 'raw' },
  },
  auditor: {
    // Auditors validate control evidence, not customer identity or free text.
    fields: new Set(['amount', 'device', 'merchant', 'timing']),
    identity: { account: 'pseudo', device: 'raw', merchant: 'raw' },
  },
  viewer: {
    fields: new Set(['amount', 'timing']),
    identity: { account: 'pseudo', device: 'pseudo', merchant: 'pseudo' },
  },
};

export function policyFor(role) {
  return POLICY[role] || POLICY.viewer;
}

export function allowedFields(role) {
  return [...policyFor(role).fields];
}

export function displayId(role, kind, id) {
  if (id == null) return null;
  const mode = policyFor(role).identity[kind] || 'pseudo';
  return mode === 'raw' ? String(id) : pseudonym(`${kind}:${id}`);
}

function can(role, field) {
  return policyFor(role).fields.has(field);
}

const REF_TABLE = { account: 'accounts', device: 'devices', merchant: 'merchants' };

/**
 * Build the role's id mapping once per request.
 *
 * `scrub` walks any response payload and rewrites every raw entity id (and any
 * raw id embedded in a composite string such as an agg_key or an audit detail
 * blob) into the role's projected id. Because projected ids never contain a raw
 * id, the rewrite is idempotent and safe to apply to every response. This is
 * the backstop that makes "permissions cannot be bypassed by exporting" hold
 * for payload shapes nobody thought to project by hand.
 */
export function createIdMapper(db, role) {
  const forward = new Map();
  // Keyed by `${kind}\u0000${projected}`: two different entities of different
  // kinds can never collide, so a device lookup can't return an account id.
  const reverse = new Map();
  for (const [kind, table] of Object.entries(REF_TABLE)) {
    const mode = policyFor(role).identity[kind] || 'pseudo';
    if (mode === 'raw') continue;
    for (const row of db.prepare(`SELECT id FROM ${table}`).all()) {
      const projected = displayId(role, kind, row.id);
      forward.set(row.id, projected);
      reverse.set(`${kind}\u0000${projected}`, row.id);
    }
  }
  const entries = [...forward.entries()].sort((a, b) => b[0].length - a[0].length);
  const reverseEntries = [...reverse.entries()]
    .map(([key, rawId]) => [key.slice(key.indexOf('\u0000') + 1), rawId])
    .sort((a, b) => b[0].length - a[0].length);

  const rewrite = (value, pairs) => {
    if (typeof value === 'string') {
      let out = value;
      for (const [from, to] of pairs) if (out.includes(from)) out = out.split(from).join(to);
      return out;
    }
    if (Array.isArray(value)) return value.map(v => rewrite(v, pairs));
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = rewrite(v, pairs);
      return out;
    }
    return value;
  };

  return {
    scrubbed: entries.length > 0,
    scrub: value => (entries.length ? rewrite(value, entries) : value),
    unscrub: value => (reverseEntries.length ? rewrite(value, reverseEntries) : value),
    // Prefix lookup over the projected ids this role already holds. Used by
    // search for restricted roles, which must never be an oracle for raw ids.
    matchPrefix(prefix) {
      const out = [];
      for (const [key, rawId] of reverse) {
        const sep = key.indexOf('\u0000');
        const kind = key.slice(0, sep);
        const projected = key.slice(sep + 1);
        if (projected.startsWith(prefix)) out.push({ kind, id: rawId, projected });
      }
      return out;
    },
    // Resolve an inbound reference to a raw id. Restricted roles may only
    // navigate with the projected ids they were given: probing a guessed raw id
    // must not confirm whether it exists.
    resolve(kind, ref) {
      if (!ref) return null;
      const table = REF_TABLE[kind];
      if (!table) return null;
      const mode = policyFor(role).identity[kind] || 'pseudo';
      if (mode === 'raw') return db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(ref) ? ref : null;
      return reverse.get(`${kind}\u0000${ref}`) || null;
    },
  };
}

export function projectNode(role, node) {
  const view = {
    id: displayId(role, node.type, node.id),
    raw_ref: can(role, 'account') ? node.id : undefined,
    type: node.type,
    label: nodeLabel(role, node),
    members: node.members ? node.members.map(m => displayId(role, node.type, m)) : undefined,
    member_count: node.member_count,
    degree: node.degree,
    risk: node.risk,
    risk_factors: node.risk_factors,
    review_state: node.review_state,
    labels: node.labels ? node.labels.map(l => projectLabel(role, l)) : undefined,
  };
  for (const key of Object.keys(view)) if (view[key] === undefined) delete view[key];
  return view;
}

function nodeLabel(role, node) {
  if (node.type === 'account') {
    if (can(role, 'account')) return node.label;
    return `账户 ${displayId(role, 'account', node.id).slice(0, 10)}`;
  }
  if (node.type === 'device') {
    if (can(role, 'device')) return node.label;
    return `设备 ${displayId(role, 'device', node.id).slice(0, 10)}`;
  }
  if (can(role, 'merchant')) return node.label;
  return `商户 ${displayId(role, 'merchant', node.id).slice(0, 10)}`;
}

export function projectEdge(role, edge) {
  return {
    id: edge.id,
    agg_key: edge.agg_key,
    edge_type: edge.edge_type,
    source: displayId(role, edge.src_type, edge.src_id),
    target: displayId(role, edge.dst_type, edge.dst_id),
    source_type: edge.src_type,
    target_type: edge.dst_type,
    strength: edge.strength,
    txn_count: edge.txn_count,
    amount_cents: edge.amount_cents,
    late_count: edge.late_count,
    day_count: edge.day_count,
    first_seen: edge.first_seen,
    last_seen: edge.last_seen,
    computed_version: edge.computed_version,
    labels: edge.labels ? edge.labels.map(l => projectLabel(role, l)) : undefined,
    evidence_txn_ids: edge.evidence_txn_ids,
  };
}

export function projectTransaction(role, txn, extra = {}) {
  if (!txn) return null;
  const base = {
    txn_id: txn.txn_id,
    amount_cents: can(role, 'amount') ? txn.amount_cents : null,
    currency: txn.currency,
    occurred_at: txn.occurred_at,
    received_at: can(role, 'timing') ? txn.received_at : undefined,
    device_id: can(role, 'device') ? displayId(role, 'device', txn.device_id) : undefined,
    merchant_id: can(role, 'merchant') ? displayId(role, 'merchant', txn.merchant_id) : undefined,
    account_id: can(role, 'account') ? displayId(role, 'account', txn.account_id) : displayId(role, 'account', txn.account_id),
    counterparty_account_id: can(role, 'counterparty') ? displayId(role, 'account', txn.counterparty_account_id) : undefined,
    ip: can(role, 'ip') ? txn.ip : undefined,
    note: can(role, 'note') ? txn.note : undefined,
    channel: can(role, 'channel') ? txn.channel : undefined,
    direction: txn.direction,
    status: txn.status,
    version: txn.version,
    is_duplicate: Boolean(txn.is_duplicate),
    duplicate_of: txn.duplicate_of || undefined,
    is_late: Boolean(txn.is_late),
    late_minutes: txn.late_minutes,
    superseded_by: txn.superseded_by || undefined,
    ingest_batch_id: txn.ingest_batch_id,
    ingested_seq: txn.ingested_seq,
  };
  for (const key of Object.keys(base)) if (base[key] === undefined) delete base[key];
  return Object.assign(base, extra);
}

export function projectLabel(role, label) {
  return {
    id: label.id,
    target_type: label.target_type,
    target_id: label.target_id,
    label: label.label,
    confidence: label.confidence,
    note: can(role, 'note') ? label.note : undefined,
    author: label.author,
    created_at: label.created_at,
    review_state: label.review_state,
    reviewed_by: label.reviewed_by,
    reviewed_at: label.reviewed_at,
    revoked_at: label.revoked_at,
  };
}

export function projectMerge(role, merge) {
  return {
    id: merge.id,
    kind: merge.kind,
    source_ids: merge.source_ids,
    target_id: merge.target_id,
    note: can(role, 'note') ? merge.note : undefined,
    created_by: merge.created_by,
    created_at: merge.created_at,
    undone_at: merge.undone_at,
    undone_by: merge.undone_by,
    review_state: merge.review_state,
    reviewed_by: merge.reviewed_by,
    reviewed_at: merge.reviewed_at,
    version_before: merge.version_before,
    version_after: merge.version_after,
    stats: merge.stats ? JSON.parse(merge.stats) : null,
  };
}

export function projectAudit(role, row) {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    role: row.role,
    action: row.action,
    object_type: row.object_type,
    object_id: row.object_id,
    detail: can(role, 'note') ? row.detail : null,
  };
}

// Defence against CSV formula injection: any cell starting with a formula
// trigger is apostrophe-prefixed. Applied to every export cell.
export function csvCell(value) {
  if (value == null) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(headers.map(h => csvCell(row[h])).join(','));
  return lines.join('\r\n');
}

export { POLICY, config };
