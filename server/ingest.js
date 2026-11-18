import crypto from 'node:crypto';
import { config } from './config.js';
import { tx, audit, getSetting, setSetting } from './db.js';
import { applyGraphDelta, canonicalKeysForTxn } from './engine.js';
import { stableId } from './auth.js';

export function fingerprintOf(raw) {
  // Fingerprint covers every economically meaningful field. A redelivery of
  // the same record matches exactly; an upstream correction (different
  // merchant, device, amount...) becomes a revision instead of a duplicate.
  return crypto.createHash('sha256').update([
    raw.txn_id, raw.account_id, raw.amount_cents, raw.occurred_at, raw.direction || 'out',
    raw.device_id || '', raw.merchant_id || '', raw.counterparty_account_id || '', raw.ip || '',
  ].join('|')).digest('hex').slice(0, 32);
}

export function normalizeTxn(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { errors: ['record is not an object'] };
  const txnId = String(raw.txn_id || '').trim();
  if (!txnId) errors.push('txn_id required');
  if (!raw.account_id) errors.push('account_id required');
  const amount = Number(raw.amount_cents ?? (raw.amount != null ? Math.round(Number(raw.amount) * 100) : NaN));
  if (!Number.isFinite(amount) || amount <= 0) errors.push('amount_cents must be a positive integer');
  if (!Number.isInteger(amount) && Number.isFinite(amount)) errors.push('amount_cents must be integer cents');
  const occurred = raw.occurred_at ? new Date(raw.occurred_at) : null;
  if (!occurred || Number.isNaN(occurred.getTime())) errors.push('occurred_at invalid');
  const received = raw.received_at ? new Date(raw.received_at) : null;
  if (received && Number.isNaN(received.getTime())) errors.push('received_at invalid');
  if (raw.ip && !/^(\d{1,3}\.){3}\d{1,3}$/.test(String(raw.ip)) && !/^[0-9a-f:]+$/i.test(String(raw.ip))) {
    errors.push('ip malformed');
  }
  if (errors.length) return { errors };
  return {
    value: {
      txn_id: txnId,
      account_id: String(raw.account_id),
      device_id: raw.device_id ? String(raw.device_id) : null,
      merchant_id: raw.merchant_id ? String(raw.merchant_id) : null,
      counterparty_account_id: raw.counterparty_account_id ? String(raw.counterparty_account_id) : null,
      amount_cents: Math.round(amount),
      currency: raw.currency || 'CNY',
      direction: raw.direction === 'in' ? 'in' : 'out',
      occurred_at: occurred.toISOString(),
      received_at: (received || config.now()).toISOString(),
      ip: raw.ip ? String(raw.ip) : null,
      channel: raw.channel || 'app',
      status: raw.status || 'posted',
      note: raw.note ? String(raw.note) : null,
    },
  };
}

function nextSeq(db) {
  const n = Number(getSetting(db, 'ingest_seq', '0')) + 1;
  setSetting(db, 'ingest_seq', n);
  return n;
}

function knownRefs(db, value) {
  const problems = [];
  if (!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(value.account_id)) problems.push(`unknown account ${value.account_id}`);
  if (value.device_id && !db.prepare('SELECT 1 FROM devices WHERE id=?').get(value.device_id)) problems.push(`unknown device ${value.device_id}`);
  if (value.merchant_id && !db.prepare('SELECT 1 FROM merchants WHERE id=?').get(value.merchant_id)) problems.push(`unknown merchant ${value.merchant_id}`);
  if (value.counterparty_account_id && !db.prepare('SELECT 1 FROM accounts WHERE id=?').get(value.counterparty_account_id)) {
    problems.push(`unknown counterparty ${value.counterparty_account_id}`);
  }
  if (value.occurred_at > new Date(config.now().getTime() + 5 * 60 * 1000).toISOString()) problems.push('occurred_at in the future');
  return problems;
}

function lateMinutesOf(value) {
  const delta = (new Date(value.received_at) - new Date(value.occurred_at)) / 60000;
  return Math.max(0, Math.round(delta));
}

/**
 * Ingest a batch. Returns a per-record report and the graph delta applied.
 * Handles three awkward cases explicitly:
 *  - duplicate delivery (same fingerprint): recorded, linked, excluded from aggregates
 *  - revision (same txn_id, different content): supersedes prior version
 *  - late arrival: flagged and surfaced in staleness reporting
 */
export function ingestBatch(db, records, { actor, role, source = 'api', batchId = null } = {}) {
  if (!Array.isArray(records)) throw Object.assign(new Error('records must be an array'), { status: 400 });
  if (records.length > 2000) throw Object.assign(new Error('batch exceeds 2000 records'), { status: 413 });
  const started = Date.now();
  const id = batchId || `B-${stableId(source, config.now().toISOString(), Math.random())}`;

  return tx(db, () => {
    const results = [];
    let accepted = 0, duplicates = 0, late = 0, rejected = 0, revisions = 0;
    const graphBefore = [];
    const graphAfter = [];

    for (const raw of records) {
      const { value, errors } = normalizeTxn(raw);
      if (errors) {
        rejected += 1;
        results.push({ txn_id: raw?.txn_id ?? null, outcome: 'rejected', reasons: errors });
        continue;
      }
      const refProblems = knownRefs(db, value);
      if (refProblems.length) {
        rejected += 1;
        results.push({ txn_id: value.txn_id, outcome: 'rejected', reasons: refProblems });
        continue;
      }
      const fp = fingerprintOf(value);
      // A redelivery copy is still "live" in the sense that it has no
      // superseded_by_id, so it must be excluded explicitly: otherwise a second
      // corrected delivery after a replay would supersede the copy and mint a
      // second version-2 row instead of version 3.
      const live = db.prepare(`SELECT * FROM transactions
        WHERE txn_id=? AND superseded_by_id IS NULL AND is_duplicate=0
        ORDER BY version DESC LIMIT 1`).get(value.txn_id);
      const seq = nextSeq(db);

      if (live && live.fingerprint === fp) {
        // Exact redelivery: store as an audit-visible duplicate but keep it out
        // of graph aggregates so strengths are not inflated.
        const dupId = `txd_${stableId(id, value.txn_id, seq)}`;
        // A replay is evidence of a delivery problem, not a late business
        // event: it is excluded from the graph and never marks the trade late.
        const lateMin = 0;
        db.prepare(`INSERT INTO transactions(id,txn_id,version,account_id,canon_account_id,device_id,canon_device_id,merchant_id,
          canon_merchant_id,counterparty_account_id,canon_counterparty_id,amount_cents,currency,direction,occurred_at,received_at,
          ip,channel,status,note,fingerprint,duplicate_of,is_duplicate,late_minutes,is_late,ingest_batch_id,ingested_seq)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(dupId, value.txn_id, live.version, live.account_id, live.canon_account_id, live.device_id, live.canon_device_id,
            live.merchant_id, live.canon_merchant_id, live.counterparty_account_id, live.canon_counterparty_id,
            value.amount_cents, value.currency, value.direction, value.occurred_at, config.now().toISOString(),
            value.ip, value.channel, value.status, value.note, fp, live.id, 1, lateMin, 0,
            id, seq);
        duplicates += 1;
        // The copy is excluded from counts and amounts, but it does change the
        // bucket's duplicate tally, so the affected relation days are
        // recomputed and a new graph version is published. This keeps the
        // incremental graph byte-identical to a full rebuild.
        graphAfter.push(db.prepare('SELECT * FROM transactions WHERE id=?').get(dupId));
        results.push({
          txn_id: value.txn_id, outcome: 'duplicate', duplicate_of: live.id,
          reason: 'identical fingerprint already ingested',
        });
        continue;
      }

      if (live && live.fingerprint !== fp) {
        // Revision of an existing transaction: keep old version for audit, remove
        // it from the live graph and recompute affected relations.
        revisions += 1;
        const prior = { ...live };
        const newId = `txv_${stableId(value.txn_id, live.version + 1, fp)}`;
        db.prepare(`INSERT INTO transactions(id,txn_id,version,account_id,canon_account_id,device_id,canon_device_id,merchant_id,
          canon_merchant_id,counterparty_account_id,canon_counterparty_id,amount_cents,currency,direction,occurred_at,received_at,
          ip,channel,status,note,fingerprint,supersedes_id,ingest_batch_id,ingested_seq)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(newId, value.txn_id, live.version + 1, value.account_id, value.account_id, value.device_id, value.device_id,
            value.merchant_id, value.merchant_id, value.counterparty_account_id, value.counterparty_account_id,
            value.amount_cents, value.currency, value.direction, value.occurred_at, value.received_at,
            value.ip, value.channel, value.status, value.note, fp, live.id, id, seq);
        const canon = canonicalKeysForTxn(db, value);
        db.prepare('UPDATE transactions SET canon_account_id=?,canon_device_id=?,canon_merchant_id=?,canon_counterparty_id=? WHERE id=?')
          .run(canon.account, canon.device, canon.merchant, canon.counterparty, newId);
        db.prepare('UPDATE transactions SET superseded_by_id=? WHERE id=?').run(newId, live.id);
        const after = db.prepare('SELECT * FROM transactions WHERE id=?').get(newId);
        const lateMin = lateMinutesOf(value);
        if (lateMin > config.lateToleranceMinutes) {
          db.prepare('UPDATE transactions SET is_late=1, late_minutes=? WHERE id=?').run(lateMin, newId);
          after.is_late = 1; after.late_minutes = lateMin; late += 1;
        }
        graphBefore.push(prior);
        graphAfter.push(after);
        accepted += 1;
        results.push({ txn_id: value.txn_id, outcome: 'revised', version: live.version + 1, supersedes: live.id, late_minutes: lateMin });
        continue;
      }

      const txnRef = `tx_${stableId(value.txn_id, value.occurred_at, fp, seq)}`;
      const lateMin = lateMinutesOf(value);
      const isLate = lateMin > config.lateToleranceMinutes ? 1 : 0;
      db.prepare(`INSERT INTO transactions(id,txn_id,version,account_id,canon_account_id,device_id,canon_device_id,merchant_id,
        canon_merchant_id,counterparty_account_id,canon_counterparty_id,amount_cents,currency,direction,occurred_at,received_at,
        ip,channel,status,note,fingerprint,late_minutes,is_late,ingest_batch_id,ingested_seq)
        VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(txnRef, value.txn_id, value.account_id, value.account_id, value.device_id, value.device_id,
          value.merchant_id, value.merchant_id, value.counterparty_account_id, value.counterparty_account_id,
          value.amount_cents, value.currency, value.direction, value.occurred_at, value.received_at,
          value.ip, value.channel, value.status, value.note, fp, lateMin, isLate, id, seq);
      const canon = canonicalKeysForTxn(db, value);
      db.prepare('UPDATE transactions SET canon_account_id=?,canon_device_id=?,canon_merchant_id=?,canon_counterparty_id=? WHERE id=?')
        .run(canon.account, canon.device, canon.merchant, canon.counterparty, txnRef);
      const after = db.prepare('SELECT * FROM transactions WHERE id=?').get(txnRef);
      graphAfter.push(after);
      accepted += 1;
      if (isLate) late += 1;
      results.push({ txn_id: value.txn_id, outcome: 'accepted', ref: txnRef, late_minutes: lateMin, is_late: Boolean(isLate) });
    }

    let delta = null;
    if (graphAfter.length || graphBefore.length) {
      delta = applyGraphDelta(db, { rowsBefore: graphBefore, rowsAfter: graphAfter, actor, trigger: 'ingest', detail: { batch: id } });
    }

    db.prepare(`INSERT INTO import_batches(id,received_at,actor,total,accepted,duplicates,late,rejected,detail)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, config.now().toISOString(), actor, records.length, accepted, duplicates, late, rejected,
      JSON.stringify({ source, revisions, duration_ms: Date.now() - started }));
    audit(db, {
      actor, role, action: 'ingest.batch', objectType: 'import_batch', objectId: id,
      detail: { total: records.length, accepted, duplicates, late, rejected, revisions, graph_version: delta?.version ?? null },
    });
    return {
      batch_id: id, total: records.length, accepted, duplicates, late, rejected, revisions,
      graph: delta ? { version: delta.version, edges_recomputed: delta.edgesRecomputed, edges_deleted: delta.edgesDeleted, nodes: delta.touched.length } : null,
      results,
    };
  });
}
