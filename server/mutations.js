import { config } from './config.js';
import { tx, audit, getGraphVersion } from './db.js';
import {
  resolveCanon, membersOf, transactionsReferencing, applyGraphDelta, computeNodeStats, canonicalKeysForTxn,
} from './engine.js';
import { stableId } from './auth.js';

export class HttpError extends Error {
  constructor(status, message, detail = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const ALLOWED_KINDS = new Set(['account', 'device', 'merchant']);

function recanon(txn, canon) {
  return {
    ...txn,
    canon_account_id: canon.account,
    canon_device_id: canon.device,
    canon_merchant_id: canon.merchant,
    canon_counterparty_id: canon.counterparty,
  };
}

function canonicalKeys(db, txn) {
  return {
    account: resolveCanon(db, 'account', txn.account_id),
    device: txn.device_id ? resolveCanon(db, 'device', txn.device_id) : null,
    merchant: txn.merchant_id ? resolveCanon(db, 'merchant', txn.merchant_id) : null,
    counterparty: txn.counterparty_account_id ? resolveCanon(db, 'account', txn.counterparty_account_id) : null,
  };
}

function assertEntity(db, kind, id) {
  if (!ALLOWED_KINDS.has(kind)) throw new HttpError(400, `unsupported entity kind: ${kind}`);
  const table = { account: 'accounts', device: 'devices', merchant: 'merchants' }[kind];
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) throw new HttpError(404, `${kind} ${id} not found`);
}

export function mergeEntities(db, { kind, sourceIds, targetId, note, actor, role }) {
  if (!ALLOWED_KINDS.has(kind)) throw new HttpError(400, `unsupported entity kind: ${kind}`);
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) throw new HttpError(400, 'sourceIds required');
  if (sourceIds.length > 20) throw new HttpError(400, 'at most 20 sources per merge');

  return tx(db, () => {
    assertEntity(db, kind, targetId);
    const canonicalTarget = resolveCanon(db, kind, targetId);
    const resolvedSources = [...new Set(sourceIds.map(id => resolveCanon(db, kind, id)))];
    for (const id of sourceIds) assertEntity(db, kind, id);
    for (const id of sourceIds) {
      const canon = resolveCanon(db, kind, id);
      if (canon !== id) {
        throw new HttpError(409, `${id} is already merged into ${canon}; undo that merge first`, { merged_into: canon });
      }
    }
    if (resolvedSources.includes(canonicalTarget)) {
      throw new HttpError(409, 'target is already part of the merge set');
    }
    if (resolvedSources.length !== sourceIds.length) {
      throw new HttpError(409, 'duplicate sources after canonicalisation', { resolvedSources });
    }

    // Rows that will change canonical endpoints.
    const affected = new Map();
    for (const source of resolvedSources) {
      for (const txn of transactionsReferencing(db, kind, [source])) {
        const before = txn;
        const aliasRow = db.prepare('SELECT canonical_id FROM entity_aliases WHERE kind=? AND alias_id=?').get(kind, source);
        db.prepare(`INSERT INTO entity_aliases(kind,alias_id,canonical_id,merge_id,created_at) VALUES(?,?,?,?,?)
          ON CONFLICT(kind,alias_id) DO UPDATE SET canonical_id=excluded.canonical_id, merge_id=excluded.merge_id`)
          .run(kind, source, canonicalTarget, 'pending', config.now().toISOString());
        void aliasRow;
        affected.set(txn.id, before);
      }
    }
    // Also cast the target's own direct endpoint references.
    for (const txn of transactionsReferencing(db, kind, [canonicalTarget])) affected.set(txn.id, txn);

    const mergeId = `M-${stableId(kind, canonicalTarget, resolvedSources.join(','), config.now().toISOString())}`;
    for (const source of resolvedSources) {
      db.prepare(`UPDATE entity_aliases SET merge_id=? WHERE kind=? AND alias_id=?`).run(mergeId, kind, source);
    }

    const beforeRows = [...affected.values()];
    const afterRows = [];
    const upd = db.prepare('UPDATE transactions SET canon_account_id=?,canon_device_id=?,canon_merchant_id=?,canon_counterparty_id=? WHERE id=?');
    for (const txn of beforeRows) {
      const canon = canonicalKeys(db, txn);
      upd.run(canon.account, canon.device, canon.merchant, canon.counterparty, txn.id);
      afterRows.push(recanon(txn, canon));
    }

    const versionBefore = getGraphVersion(db);
    db.prepare(`INSERT INTO merges(id,kind,source_ids,target_id,note,created_by,created_at,review_state,version_before)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(mergeId, kind, JSON.stringify(sourceIds), canonicalTarget, note || null, actor,
      config.now().toISOString(), 'pending', versionBefore);

    const delta = applyGraphDelta(db, {
      rowsBefore: beforeRows, rowsAfter: afterRows, actor, trigger: `merge:${kind}`,
      detail: { merge_id: mergeId, sources: sourceIds, target: canonicalTarget },
    });

    const stats = {
      nodes_touched: delta.touched.length,
      nodes_in_scope: (resolvedSources.length + 1),
      edges_recomputed: delta.edgesRecomputed,
      edges_deleted: delta.edgesDeleted,
      transactions_recanonicalised: beforeRows.length,
      version: delta.version,
    };
    db.prepare('UPDATE merges SET stats=?, version_after=? WHERE id=?').run(JSON.stringify(stats), delta.version, mergeId);

    // Clean up now-empty canonical nodes' stats.
    for (const source of resolvedSources) {
      if (!db.prepare('SELECT 1 FROM transactions WHERE canon_account_id=? OR canon_device_id=? OR canon_merchant_id=? OR canon_counterparty_id=? LIMIT 1')
        .get(source, source, source, source)) {
        db.prepare('DELETE FROM node_stats WHERE node_type=? AND node_id=?').run(kind, source);
      }
    }

    audit(db, {
      actor, role, action: 'merge.create', objectType: kind, objectId: canonicalTarget,
      detail: { merge_id: mergeId, sources: sourceIds, stats },
    });
    const row = db.prepare('SELECT * FROM merges WHERE id=?').get(mergeId);
    return { merge: row, stats };
  });
}

export function undoMerge(db, mergeId, { actor, role }) {
  return tx(db, () => {
    const merge = db.prepare('SELECT * FROM merges WHERE id=?').get(mergeId);
    if (!merge) throw new HttpError(404, 'merge not found');
    if (merge.undone_at) throw new HttpError(409, 'merge already undone');
    const kind = merge.kind;
    const sources = JSON.parse(merge.source_ids);
    const target = merge.target_id;

    const aliases = db.prepare('SELECT alias_id FROM entity_aliases WHERE merge_id=?').all(mergeId).map(r => r.alias_id);
    if (!aliases.length) throw new HttpError(409, 'merge has no live aliases');

    // Determine affected rows BEFORE removing aliases.
    const affected = new Map();
    for (const txn of transactionsReferencing(db, kind, [target, ...aliases])) affected.set(txn.id, txn);
    const beforeRows = [...affected.values()];

    db.prepare('DELETE FROM entity_aliases WHERE merge_id=?').run(mergeId);
    const afterRows = [];
    const upd = db.prepare('UPDATE transactions SET canon_account_id=?,canon_device_id=?,canon_merchant_id=?,canon_counterparty_id=? WHERE id=?');
    for (const txn of beforeRows) {
      const canon = canonicalKeys(db, txn);
      upd.run(canon.account, canon.device, canon.merchant, canon.counterparty, txn.id);
      afterRows.push(recanon(txn, canon));
    }

    db.prepare('UPDATE merges SET undone_at=?, undone_by=? WHERE id=?').run(config.now().toISOString(), actor, mergeId);

    const delta = applyGraphDelta(db, {
      rowsBefore: beforeRows, rowsAfter: afterRows, actor, trigger: `undo_merge:${kind}`,
      detail: { merge_id: mergeId, restored: aliases, target },
    });

    const stats = {
      ...(merge.stats ? JSON.parse(merge.stats) : {}),
      undo_nodes_touched: delta.touched.length,
      undo_edges_recomputed: delta.edgesRecomputed,
      undo_edges_deleted: delta.edgesDeleted,
      undo_version: delta.version,
    };
    db.prepare('UPDATE merges SET stats=? WHERE id=?').run(JSON.stringify(stats), mergeId);

    audit(db, {
      actor, role, action: 'merge.undo', objectType: kind, objectId: target,
      detail: { merge_id: mergeId, restored: aliases, stats },
    });
    return { merge: db.prepare('SELECT * FROM merges WHERE id=?').get(mergeId), stats };
  });
}

export function addLabel(db, { targetType, targetId, label, confidence, note, actor, role }) {
  if (!ALLOWED_KINDS.has(targetType)) throw new HttpError(400, 'unsupported target type');
  if (!config.labelTypes.includes(label)) throw new HttpError(400, `label must be one of ${config.labelTypes.join(', ')}`);
  const conf = Number(confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) throw new HttpError(400, 'confidence must be 0..1');
  const canonical = resolveCanon(db, targetType, targetId);

  return tx(db, () => {
    assertEntity(db, targetType, targetId);
    const id = `L-${stableId(targetType, canonical, label, config.now().toISOString(), Math.random())}`;
    db.prepare(`INSERT INTO labels(id,target_type,target_id,label,confidence,note,author,author_role,created_at,review_state)
      VALUES(?,?,?,?,?,?,?,?,?, 'pending')`).run(id, targetType, canonical, label, conf, note || null, actor, role,
      config.now().toISOString());

    const stats = computeNodeStats(db, targetType, canonical);
    db.prepare(`INSERT INTO node_stats(node_type,node_id,degree,edge_strength_sum,max_edge_strength,txn_amount_cents,late_count,risk,risk_factors,computed_version)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(node_type,node_id) DO UPDATE SET risk=excluded.risk, risk_factors=excluded.risk_factors,
      computed_version=excluded.computed_version`)
      .run(stats.node_type, stats.node_id, stats.degree, stats.edge_strength_sum, stats.max_edge_strength,
        stats.txn_amount_cents, stats.late_count, stats.risk, JSON.stringify(stats.risk_factors), stats.computed_version);
    audit(db, { actor, role, action: 'label.create', objectType: targetType, objectId: canonical, detail: { id, label, confidence: conf } });
    return { label: db.prepare('SELECT * FROM labels WHERE id=?').get(id), risk_after: stats.risk };
  });
}

export function revokeLabel(db, labelId, { actor, role }) {
  return tx(db, () => {
    const label = db.prepare('SELECT * FROM labels WHERE id=?').get(labelId);
    if (!label) throw new HttpError(404, 'label not found');
    if (label.revoked_at) throw new HttpError(409, 'label already revoked');
    if (label.author !== actor && role !== 'admin') throw new HttpError(403, 'only the author or an admin can revoke a label');
    db.prepare('UPDATE labels SET revoked_at=?, revoked_by=?, review_state=?, reviewed_by=?, reviewed_at=? WHERE id=?')
      .run(config.now().toISOString(), actor, 'revoked', actor, config.now().toISOString(), labelId);
    const stats = computeNodeStats(db, label.target_type, label.target_id);
    db.prepare(`UPDATE node_stats SET risk=?, risk_factors=?, computed_version=? WHERE node_type=? AND node_id=?`)
      .run(stats.risk, JSON.stringify(stats.risk_factors), stats.computed_version, label.target_type, label.target_id);
    audit(db, { actor, role, action: 'label.revoke', objectType: label.target_type, objectId: label.target_id, detail: { id: labelId } });
    return { label: db.prepare('SELECT * FROM labels WHERE id=?').get(labelId), risk_after: stats.risk };
  });
}

export function reviewObject(db, { objectType, objectId, decision, note, actor, role }) {
  if (!['label', 'merge'].includes(objectType)) throw new HttpError(400, 'objectType must be label or merge');
  if (!['approved', 'rejected', 'pending'].includes(decision)) throw new HttpError(400, 'invalid decision');
  return tx(db, () => {
    const table = objectType === 'label' ? 'labels' : 'merges';
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(objectId);
    if (!row) throw new HttpError(404, `${objectType} not found`);
    if (objectType === 'label' && row.revoked_at) throw new HttpError(409, 'cannot review a revoked label');
    if (objectType === 'merge' && row.undone_at) throw new HttpError(409, 'cannot review an undone merge');
    // Four-eyes: reviewers cannot approve their own work.
    if ((row.created_by || row.author) === actor) throw new HttpError(403, 'four-eyes: reviewer must differ from author');
    db.prepare(`UPDATE ${table} SET review_state=?, reviewed_by=?, reviewed_at=? WHERE id=?`)
      .run(decision, actor, config.now().toISOString(), objectId);
    const reviewId = `R-${stableId(objectType, objectId, decision, config.now().toISOString())}`;
    db.prepare('INSERT INTO reviews(id,object_type,object_id,decision,note,reviewer,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(reviewId, objectType, objectId, decision, note || null, actor, config.now().toISOString());
    if (objectType === 'label') {
      const stats = computeNodeStats(db, row.target_type, row.target_id);
      db.prepare('UPDATE node_stats SET risk=?, risk_factors=?, computed_version=? WHERE node_type=? AND node_id=?')
        .run(stats.risk, JSON.stringify(stats.risk_factors), stats.computed_version, row.target_type, row.target_id);
    }
    audit(db, { actor, role, action: `${objectType}.review`, objectType, objectId, detail: { decision, review_id: reviewId } });
    return { objectType, objectId, decision };
  });
}

export function bulkMergeSuggestions(db) {
  // Same-device accounts are the strongest deterministic signal; surface pairs
  // that share a device but are not yet merged.
  const rows = db.prepare(`SELECT canon_device_id AS device, COUNT(DISTINCT canon_account_id) AS n
    FROM transactions WHERE canon_device_id IS NOT NULL AND superseded_by_id IS NULL
    GROUP BY canon_device_id HAVING n > 1 ORDER BY n DESC LIMIT 20`).all();
  const out = [];
  for (const row of rows) {
    const accounts = db.prepare(`SELECT DISTINCT canon_account_id AS id, COUNT(*) AS n FROM transactions
      WHERE canon_device_id=? AND superseded_by_id IS NULL GROUP BY canon_account_id ORDER BY n DESC`).all(row.device);
    const deviceRow = db.prepare('SELECT fingerprint, model FROM devices WHERE id=?').get(row.device);
    out.push({
      kind: 'device',
      device_id: row.device,
      device_label: deviceRow ? `${deviceRow.model || ''} ${deviceRow.fingerprint}`.trim() : row.device,
      accounts: accounts.map(a => a.id),
      txn_counts: accounts.map(a => a.n),
      reason: `同一设备 ${deviceRow?.fingerprint || row.device} 关联 ${accounts.length} 个账户`,
    });
  }
  return out;
}
