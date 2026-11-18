import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_no TEXT NOT NULL UNIQUE,
  bank TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  segment TEXT NOT NULL DEFAULT 'retail'
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  model TEXT,
  first_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  country TEXT NOT NULL,
  risk_level INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  txn_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  account_id TEXT NOT NULL,
  canon_account_id TEXT NOT NULL,
  device_id TEXT,
  canon_device_id TEXT,
  merchant_id TEXT,
  canon_merchant_id TEXT,
  counterparty_account_id TEXT,
  canon_counterparty_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  direction TEXT NOT NULL DEFAULT 'out',
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  ip TEXT,
  channel TEXT NOT NULL DEFAULT 'app',
  status TEXT NOT NULL DEFAULT 'posted',
  note TEXT,
  fingerprint TEXT NOT NULL,
  duplicate_of TEXT,
  is_duplicate INTEGER NOT NULL DEFAULT 0,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  is_late INTEGER NOT NULL DEFAULT 0,
  supersedes_id TEXT,
  superseded_by_id TEXT,
  ingest_batch_id TEXT,
  ingested_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_txn_device ON transactions(device_id);
CREATE INDEX IF NOT EXISTS idx_txn_merchant ON transactions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_txn_counterparty ON transactions(counterparty_account_id);
CREATE INDEX IF NOT EXISTS idx_txn_occurred ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_txn_fingerprint ON transactions(fingerprint);
CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_txn_business ON transactions(txn_id);
CREATE INDEX IF NOT EXISTS idx_txn_canon_account ON transactions(canon_account_id);
CREATE INDEX IF NOT EXISTS idx_txn_canon_device ON transactions(canon_device_id);
CREATE INDEX IF NOT EXISTS idx_txn_canon_merchant ON transactions(canon_merchant_id);
CREATE INDEX IF NOT EXISTS idx_txn_canon_cp ON transactions(canon_counterparty_id);

CREATE TABLE IF NOT EXISTS entity_aliases (
  kind TEXT NOT NULL,
  alias_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  merge_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, alias_id)
);
CREATE INDEX IF NOT EXISTS idx_alias_canonical ON entity_aliases(kind, canonical_id);
CREATE INDEX IF NOT EXISTS idx_alias_merge ON entity_aliases(merge_id);

CREATE TABLE IF NOT EXISTS merges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_ids TEXT NOT NULL,
  target_id TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  undone_at TEXT,
  undone_by TEXT,
  review_state TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TEXT,
  version_before INTEGER NOT NULL,
  version_after INTEGER,
  stats TEXT
);
CREATE INDEX IF NOT EXISTS idx_merges_review ON merges(review_state);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_display TEXT,
  label TEXT NOT NULL,
  confidence REAL NOT NULL,
  note TEXT,
  author TEXT NOT NULL,
  author_role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_labels_target ON labels(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_labels_review ON labels(review_state);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  rel_key TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  src_type TEXT NOT NULL,
  src_id TEXT NOT NULL,
  dst_type TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  day TEXT NOT NULL,
  txn_count INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  late_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  distinct_counterparties INTEGER NOT NULL DEFAULT 0,
  strength REAL NOT NULL,
  factors TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  computed_version INTEGER NOT NULL,
  UNIQUE (edge_type, day, src_type, src_id, dst_type, dst_id)
);
CREATE INDEX IF NOT EXISTS idx_edge_src ON graph_edges(src_type, src_id);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON graph_edges(dst_type, dst_id);
CREATE INDEX IF NOT EXISTS idx_edge_day ON graph_edges(day);
CREATE INDEX IF NOT EXISTS idx_edge_type ON graph_edges(edge_type);

CREATE TABLE IF NOT EXISTS edge_transactions (
  edge_id TEXT NOT NULL REFERENCES graph_edges(id) ON DELETE CASCADE,
  txn_ref TEXT NOT NULL,
  contribution REAL NOT NULL,
  flags TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (edge_id, txn_ref)
);
CREATE INDEX IF NOT EXISTS idx_edgetxn_txn ON edge_transactions(txn_ref);

CREATE TABLE IF NOT EXISTS node_stats (
  node_type TEXT NOT NULL,
  node_id TEXT NOT NULL,
  degree INTEGER NOT NULL,
  edge_strength_sum REAL NOT NULL,
  max_edge_strength REAL NOT NULL,
  txn_amount_cents INTEGER NOT NULL,
  late_count INTEGER NOT NULL,
  risk REAL NOT NULL,
  risk_factors TEXT NOT NULL,
  computed_version INTEGER NOT NULL,
  PRIMARY KEY (node_type, node_id)
);
CREATE INDEX IF NOT EXISTS idx_nodestats_risk ON node_stats(risk);

CREATE TABLE IF NOT EXISTS graph_versions (
  version INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  actor TEXT NOT NULL,
  affected_nodes INTEGER NOT NULL,
  edges_recomputed INTEGER NOT NULL,
  edges_deleted INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  total INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  duplicates INTEGER NOT NULL,
  late INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reset_tokens (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edge_versions (
  version INTEGER NOT NULL,
  rel_key TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  src_type TEXT NOT NULL,
  src_id TEXT NOT NULL,
  dst_type TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  day TEXT NOT NULL,
  action TEXT NOT NULL,
  strength_before REAL,
  strength_after REAL,
  txn_count_after INTEGER,
  PRIMARY KEY (version, rel_key, day, action)
);
CREATE INDEX IF NOT EXISTS idx_edgever_rel ON edge_versions(rel_key);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

export function getGraphVersion(db) {
  return Number(getSetting(db, 'graph_version', '0'));
}

export function bumpGraphVersion(db, { trigger, actor, affectedNodes, edgesRecomputed, edgesDeleted, durationMs, detail }) {
  const next = getGraphVersion(db) + 1;
  const at = config.now().toISOString();
  db.prepare(`INSERT INTO graph_versions(version,created_at,trigger,actor,affected_nodes,edges_recomputed,edges_deleted,duration_ms,detail)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(next, at, trigger, actor, affectedNodes, edgesRecomputed, edgesDeleted, durationMs,
    detail ? JSON.stringify(detail) : null);
  setSetting(db, 'graph_version', next);
  return next;
}

export function audit(db, { actor, role, action, objectType = null, objectId = null, detail = null }) {
  db.prepare('INSERT INTO audit_log(at,actor,role,action,object_type,object_id,detail) VALUES(?,?,?,?,?,?,?)')
    .run(config.now().toISOString(), actor, role, action, objectType, objectId,
      detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
}

export function cleanupSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(config.now().toISOString());
}
