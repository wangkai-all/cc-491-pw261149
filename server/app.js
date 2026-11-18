import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, hasCap, ROLE_CAPS } from './config.js';
import { openDb, audit, getGraphVersion, getSetting, setSetting, cleanupSessions, tx } from './db.js';
import { hashPassword, verifyPassword, randomToken, tokenHash } from './auth.js';
import {
  projectNode, projectEdge, projectTransaction, projectLabel, projectMerge, projectAudit,
  allowedFields, toCsv, policyFor, createIdMapper,
} from './redact.js';
import { ingestBatch } from './ingest.js';
import {
  nodeSummary, windowEdges, edgeEvidence, graphAround, shortestPath, windowSummary, entityLabel,
} from './graph.js';
import {
  mergeEntities, undoMerge, addLabel, revokeLabel, reviewObject, bulkMergeSuggestions, HttpError,
} from './mutations.js';
import { resolveCanon, membersOf } from './engine.js';
import { seedDatabase } from './seed.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createApp({ dbFile = ':memory:', seed = true, clock = null } = {}) {
  if (clock) config.now = clock;
  const db = openDb(dbFile);
  if (seed) seedDatabase(db);
  const mcpTokens = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, db, mcpTokens);
      } else {
        serveStatic(req, res, url);
      }
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: err.message, detail: err.detail ?? undefined });
    }
  });

  server.db = db;
  return server;
}

function sendJson(res, status, body, headers = {}) {
  const safe = res.__scrub ? res.__scrub(body) : body;
  const payload = JSON.stringify(safe);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(config.publicDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(config.publicDir)) return sendText(res, 403, 'forbidden');
  fs.readFile(full, (err, data) => {
    if (err) return sendText(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    });
    res.end(data);
  });
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function currentUser(req, db) {
  const token = parseCookies(req).tl_session;
  if (!token) return null;
  const row = db.prepare(`SELECT s.token_hash, s.expires_at, u.id, u.username, u.display_name, u.role
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(tokenHash(token));
  if (!row) return null;
  if (row.expires_at < config.now().toISOString()) return null;
  return { id: row.id, username: row.username, name: row.display_name, role: row.role };
}

function requireUser(req, db) {
  const user = currentUser(req, db);
  if (!user) throw new HttpError(401, 'authentication required');
  return user;
}

// Raw internal transaction ids are exposed only to roles that already handle
// unprojected identifiers (ingest operators and auditors tracing control
// evidence). Everyone else uses the business txn_id.
function mayUseRawTxnRef(user) {
  return hasCap(user.role, 'ingest') || hasCap(user.role, 'audit.read');
}

function requireCap(user, cap) {
  if (!hasCap(user.role, cap)) throw new HttpError(403, `role ${user.role} lacks capability ${cap}`);
}

function publicUser(user) {
  return {
    id: user.id, username: user.username, name: user.name, role: user.role,
    fields: allowedFields(user.role), caps: [...(ROLE_CAPS[user.role] || new Set())].sort(),
  };
}

/**
 * Turn client seed references into raw `type:id` keys. Unrestricted roles may
 * pass raw ids; restricted roles must pass the projected ids they were given.
 * Unresolvable seeds are dropped silently so a guessed raw id cannot change
 * the shape of the response.
 */
function resolveSeeds(db, ids, rawSeeds) {
  const out = [];
  out.requested = rawSeeds.length;
  for (const seed of rawSeeds) {
    const idx = seed.indexOf(':');
    const type = idx > 0 ? seed.slice(0, idx) : 'account';
    const ref = idx > 0 ? seed.slice(idx + 1) : seed;
    if (!['account', 'device', 'merchant'].includes(type)) continue;
    const id = ids.resolve(type, ref);
    // A merged source id still addresses the canonical node.
    if (id) out.push(`${type}:${resolveCanon(db, type, id)}`);
  }
  return out;
}

function qp(url, name, fallback = null) {
  const v = url.searchParams.get(name);
  return v == null ? fallback : v;
}

function isoOrThrow(value, field) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${field} invalid`);
  return d.toISOString();
}

function defaultWindow(db) {
  const maxDay = db.prepare('SELECT MAX(day) AS d FROM graph_edges').get()?.d;
  const anchor = maxDay ? new Date(`${maxDay}T00:00:00.000Z`) : config.now();
  const to = new Date(anchor.getTime() + 24 * 3600 * 1000);
  const from = new Date(anchor.getTime() - 6 * 24 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function handleApi(req, res, url, db, mcpTokens) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, graph_version: getGraphVersion(db), now: config.now().toISOString() });
  }

  if (p === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(body.username || ''));
    if (!user || !(await verifyPassword(String(body.password || ''), user.password_salt, user.password_hash))) {
      audit(db, { actor: String(body.username || 'anonymous'), role: 'unknown', action: 'auth.login_failed' });
      throw new HttpError(401, 'invalid credentials');
    }
    cleanupSessions(db);
    const token = randomToken();
    const expires = new Date(config.now().getTime() + 8 * 3600 * 1000).toISOString();
    db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)')
      .run(tokenHash(token), user.id, config.now().toISOString(), expires);
    audit(db, { actor: user.username, role: user.role, action: 'auth.login' });
    const u = { id: user.id, username: user.username, name: user.display_name, role: user.role };
    return sendJson(res, 200, { user: publicUser(u) }, {
      'set-cookie': `tl_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${8 * 3600}`,
    });
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    const token = parseCookies(req).tl_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
    return sendJson(res, 200, { ok: true }, { 'set-cookie': 'tl_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  if (p === '/api/auth/me' && method === 'GET') {
    const user = currentUser(req, db);
    if (!user) return sendJson(res, 200, { user: null, demo_users: demoUsers() });
    return sendJson(res, 200, { user: publicUser(user) });
  }

  // Everything below requires authentication.
  const user = requireUser(req, db);
  const role = user.role;
  // Every authenticated response passes through the role's id mapper. This is
  // the backstop behind the per-endpoint projection: a payload that forgot to
  // project a raw id still cannot leak one.
  const ids = createIdMapper(db, role);
  res.__scrub = ids.scrub;

  if (p === '/api/meta' && method === 'GET') {
    return sendJson(res, 200, {
      roles: ['admin', 'analyst', 'auditor', 'viewer'],
      label_types: config.labelTypes,
      edge_types: config.edgeTypes,
      fields: allowedFields(role),
      graph_version: getGraphVersion(db),
      default_window: defaultWindow(db),
      limits: { max_export_rows: config.maxExportRows, max_hops: config.graphHopLimit },
      now: config.now().toISOString(),
    });
  }

  if (p === '/api/overview' && method === 'GET') {
    requireCap(user, 'view');
    const w = windowParams(url, db);
    const summary = windowSummary(db, w);
    const top = db.prepare(`SELECT ns.*, 1 AS x FROM node_stats ns WHERE ns.degree>0 ORDER BY ns.risk DESC LIMIT 8`).all()
      .map(row => projectNode(role, {
        ...nodeSummary(db, row.node_type, row.node_id),
        labels: labelsFor(db, row.node_type, row.node_id, role),
      }));
    const suggestions = hasCap(role, 'merge') ? bulkMergeSuggestions(db).slice(0, 5) : [];
    const batches = db.prepare('SELECT * FROM import_batches ORDER BY received_at DESC LIMIT 6').all();
    const versions = db.prepare('SELECT * FROM graph_versions ORDER BY version DESC LIMIT 8').all();
    const pendingReviews = db.prepare(`SELECT
      (SELECT COUNT(*) FROM labels WHERE review_state='pending' AND revoked_at IS NULL) AS labels,
      (SELECT COUNT(*) FROM merges WHERE review_state='pending' AND undone_at IS NULL) AS merges`).get();
    return sendJson(res, 200, {
      summary, top_nodes: top, suggestions,
      batches: batches.map(b => ({ ...b, detail: role === 'viewer' ? null : safeJson(b.detail) })),
      versions: versions.map(v => ({ ...v, detail: role === 'viewer' ? null : safeJson(v.detail) })),
      pending_reviews: pendingReviews,
      window: w,
    });
  }

  if (p === '/api/graph' && method === 'GET') {
    requireCap(user, 'view');
    const w = windowParams(url, db);
    const seeds = resolveSeeds(db, ids, (qp(url, 'seeds', '') || '').split(',').map(s => s.trim()).filter(Boolean));
    const hops = Math.min(Number(qp(url, 'hops', '2')) || 2, config.graphHopLimit);
    const minStrength = Number(qp(url, 'min_strength', '0')) || 0;
    const edgeTypes = (qp(url, 'edge_types', '') || '').split(',').filter(Boolean);
    // Seeds the caller asked for but cannot address must not silently degrade
    // into a default "highest risk" view: that looks like authorisation was
    // honoured. Return an empty graph instead.
    if (seeds.requested && !seeds.length) {
      return sendJson(res, 200, { nodes: [], edges: [], seeds: [], truncated: false, window: w, graph_version: getGraphVersion(db) });
    }
    const graph = graphAround(db, { from: w.from, to: w.to, seeds, hops, edgeTypes, minStrength });
    const decoratedNodes = graph.nodes.map(n => projectNode(role, {
      ...nodeSummary(db, n.type, n.id),
      labels: labelsFor(db, n.type, n.id, role),
    }));
    const decoratedEdges = graph.edges.map(e => projectEdge(role, { ...e, labels: [] }));
    return sendJson(res, 200, {
      nodes: decoratedNodes,
      edges: decoratedEdges,
      seeds: graph.seeds,
      truncated: graph.truncated,
      window: w,
      graph_version: getGraphVersion(db),
    });
  }

  if (p === '/api/node' && method === 'GET') {
    requireCap(user, 'view');
    const type = qp(url, 'type', 'account');
    const ref = qp(url, 'id');
    if (!ref) throw new HttpError(400, 'id required');
    if (!['account', 'device', 'merchant'].includes(type)) throw new HttpError(400, 'invalid type');
    const id = ids.resolve(type, ref);
    if (!id) throw new HttpError(404, `${type} not found`);
    const node = nodeSummary(db, type, id);
    const w = windowParams(url, db);
    const edges = windowEdges(db, { from: w.from, to: w.to, limit: 500 })
      .filter(e => (e.src_type === type && e.src_id === node.id) || (e.dst_type === type && e.dst_id === node.id));
    const txnRows = db.prepare(`SELECT * FROM transactions WHERE superseded_by_id IS NULL
      AND ((?='account' AND (canon_account_id=? OR canon_counterparty_id=?)) OR (?='device' AND canon_device_id=?)
        OR (?='merchant' AND canon_merchant_id=?))
      ORDER BY occurred_at DESC LIMIT 200`).all(type, node.id, node.id, type, node.id, type, node.id);
    return sendJson(res, 200, {
      node: projectNode(role, { ...node, labels: labelsFor(db, type, node.id, role) }),
      edges: edges.map(e => projectEdge(role, e)),
      transactions: txnRows.map(t => projectTransaction(role, t)),
      merge_history: db.prepare('SELECT * FROM merges WHERE kind=? AND target_id=? ORDER BY created_at DESC').all(type, node.id)
        .map(m => projectMerge(role, m)),
      window: w,
    });
  }

  if (p === '/api/edge/evidence' && method === 'GET') {
    requireCap(user, 'view');
    const aggKey = ids.unscrub(qp(url, 'agg_key') || '');
    if (!aggKey) throw new HttpError(400, 'agg_key required');
    if (!/^[a-z_]+\|/.test(aggKey)) throw new HttpError(400, 'agg_key malformed');
    const w = windowParams(url, db);
    const rows = edgeEvidence(db, aggKey, { ...w, role });
    const txnIds = [...new Set(rows.map(r => r.txn_ref))];
    const txns = txnIds.length
      ? db.prepare(`SELECT * FROM transactions WHERE id IN (${txnIds.map(() => '?').join(',')})`).all(...txnIds)
      : [];
    const byId = new Map(txns.map(t => [t.id, t]));
    const accountByTxn = new Map(txns.map(t => [t.id, t.canon_account_id]));
    return sendJson(res, 200, {
      agg_key: aggKey,
      window: w,
      rows: rows.map(r => ({
        day: r.day,
        edge_id: r.edge_id,
        day_strength: r.strength,
        day_txn_count: r.txn_count,
        day_amount_cents: r.amount_cents,
        contribution: r.contribution,
        flags: safeJson(r.flags),
        transaction: projectTransaction(role, byId.get(r.txn_ref)),
        account: accountByTxn.get(r.txn_ref)
          ? projectNode(role, nodeSummary(db, 'account', accountByTxn.get(r.txn_ref)))
          : null,
      })),
      graph_version: getGraphVersion(db),
    });
  }

  if (p === '/api/search' && method === 'GET') {
    requireCap(user, 'view');
    const q = String(qp(url, 'q', '')).trim();
    if (q.length < 1) return sendJson(res, 200, { results: [] });
    // Restricted roles must not be able to search by a real name, account
    // number, device fingerprint or the raw readable part of an id: search
    // would otherwise be an oracle that turns a guessed value into a projected
    // handle. They resolve projected ids only; the raw-id LIKE query never runs.
    const restricted = policyFor(user.role).identity.account !== 'raw'
      || policyFor(user.role).identity.device !== 'raw'
      || policyFor(user.role).identity.merchant !== 'raw';
    if (restricted) {
      // Only projected ids this role already holds (or a prefix of one) can
      // match. Passing a guessed raw id returns an empty list, exactly like a
      // value that does not exist.
      const results = ids.matchPrefix(q).slice(0, 20).map(({ kind, id }) => {
        const shown = projectNode(user.role, nodeSummary(db, kind, id));
        return { type: kind, id: shown.id, label: shown.label };
      });
      return sendJson(res, 200, { results });
    }
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const accounts = db.prepare(`SELECT id, holder_name, account_no, bank FROM accounts
      WHERE id LIKE ? OR account_no LIKE ? OR holder_name LIKE ? LIMIT 8`).all(like, like, like);
    const devices = db.prepare(`SELECT id, fingerprint, model, kind FROM devices
      WHERE id LIKE ? OR fingerprint LIKE ? OR model LIKE ? LIMIT 6`).all(like, like, like);
    const merchants = db.prepare(`SELECT id, name, category FROM merchants
      WHERE id LIKE ? OR name LIKE ? LIMIT 6`).all(like, like);
    const results = [
      ...accounts.map(a => ({ type: 'account', id: a.id, label: entityLabel(db, 'account', a.id) })),
      ...devices.map(d => ({ type: 'device', id: d.id, label: entityLabel(db, 'device', d.id) })),
      ...merchants.map(m => ({ type: 'merchant', id: m.id, label: entityLabel(db, 'merchant', m.id) })),
    ];
    return sendJson(res, 200, { results });
  }

  if (p === '/api/path' && method === 'GET') {
    requireCap(user, 'view');
    const w = windowParams(url, db);
    const fromType = qp(url, 'from_type', 'account');
    const toType = qp(url, 'to_type', 'account');
    const fromId = ids.resolve(fromType, qp(url, 'from_id'));
    const toId = ids.resolve(toType, qp(url, 'to_id'));
    if (!fromId || !toId) throw new HttpError(400, 'from_id and to_id required (or not visible to this role)');
    const maxHops = Math.min(Number(qp(url, 'hops', '3')) || 3, 6);
    const result = shortestPath(db, { fromType, fromId, toType, toId, ...w, maxHops });
    return sendJson(res, 200, {
      ...result,
      nodes_detail: (result.nodes || []).map(key => {
        const idx = key.indexOf(':');
        const type = key.slice(0, idx), id = key.slice(idx + 1);
        return projectNode(role, nodeSummary(db, type, id));
      }),
      steps: (result.steps || []).map(s => ({ ...s, edge: projectEdge(role, s.edge) })),
      graph_version: getGraphVersion(db),
    });
  }

  if (p === '/api/trace' && method === 'GET') {
    requireCap(user, 'view');
    const txnId = qp(url, 'txn_id');
    const ref = qp(url, 'ref');
    if (!txnId && !ref) throw new HttpError(400, 'txn_id or ref required');
    // The internal row id is an implementation detail. Roles that cannot see
    // raw entity identity navigate by business txn_id only, so probing a
    // guessed raw id yields the same 404 as a nonexistent one.
    if (ref && !mayUseRawTxnRef(user)) throw new HttpError(404, 'transaction not found');
    return sendJson(res, 200, traceTransaction(db, { txnId, ref, role }));
  }

  if (p === '/api/import/batches' && method === 'GET') {
    requireCap(user, 'view');
    const rows = db.prepare('SELECT * FROM import_batches ORDER BY received_at DESC LIMIT 50').all();
    return sendJson(res, 200, {
      batches: rows.map(b => ({
        ...b, detail: hasCap(role, 'ingest') ? safeJson(b.detail) : null,
      })),
    });
  }

  if (p === '/api/ingest' && method === 'POST') {
    requireCap(user, 'ingest');
    const body = await readBody(req);
    const records = Array.isArray(body) ? body : body.records;
    const result = ingestBatch(db, records, { actor: user.username, role, source: body.source || 'api' });
    return sendJson(res, 200, result);
  }

  if (p === '/api/merge/suggestions' && method === 'GET') {
    requireCap(user, 'merge');
    return sendJson(res, 200, {
      suggestions: bulkMergeSuggestions(db).map(s => ({
        ...s, accounts: s.accounts.map(a => projectNode(role, nodeSummary(db, 'account', a))),
      })),
    });
  }

  if (p === '/api/merge' && method === 'POST') {
    requireCap(user, 'merge');
    const body = await readBody(req);
    const result = mergeEntities(db, {
      kind: body.kind, sourceIds: body.source_ids ?? body.sourceIds, targetId: body.target_id ?? body.targetId,
      note: body.note, actor: user.username, role,
    });
    const merge = projectMerge(role, result.merge);
    return sendJson(res, 200, {
      merge,
      stats: result.stats,
      nodes: merge.source_ids ? JSON.parse(result.merge.source_ids).map(id => projectNode(role, nodeSummary(db, merge.kind, id))) : [],
      target: projectNode(role, nodeSummary(db, merge.kind, merge.target_id)),
      graph_version: getGraphVersion(db),
    });
  }

  if (p === '/api/merge/undo' && method === 'POST') {
    requireCap(user, 'undo_merge');
    const body = await readBody(req);
    if (!body.merge_id) throw new HttpError(400, 'merge_id required');
    const result = undoMerge(db, body.merge_id, { actor: user.username, role });
    return sendJson(res, 200, {
      merge: projectMerge(role, result.merge),
      stats: result.stats,
      graph_version: getGraphVersion(db),
    });
  }

  if (p === '/api/label' && method === 'POST') {
    requireCap(user, 'annotate');
    const body = await readBody(req);
    const result = addLabel(db, {
      targetType: body.target_type, targetId: body.target_id, label: body.label,
      confidence: body.confidence, note: body.note, actor: user.username, role,
    });
    return sendJson(res, 200, { label: projectLabel(role, result.label), risk_after: result.risk_after });
  }

  if (p === '/api/label/revoke' && method === 'POST') {
    requireCap(user, 'annotate');
    const body = await readBody(req);
    const result = revokeLabel(db, body.label_id, { actor: user.username, role });
    return sendJson(res, 200, { label: projectLabel(role, result.label), risk_after: result.risk_after });
  }

  if (p === '/api/review' && method === 'POST') {
    requireCap(user, 'review');
    const body = await readBody(req);
    const result = reviewObject(db, {
      objectType: body.object_type, objectId: body.object_id, decision: body.decision,
      note: body.note, actor: user.username, role,
    });
    return sendJson(res, 200, result);
  }

  if (p === '/api/reviews' && method === 'GET') {
    requireCap(user, 'view');
    const labels = db.prepare('SELECT * FROM labels ORDER BY created_at DESC LIMIT 100').all().map(l => projectLabel(role, l));
    const merges = db.prepare('SELECT * FROM merges ORDER BY created_at DESC LIMIT 100').all().map(m => projectMerge(role, m));
    return sendJson(res, 200, { labels, merges });
  }

  if (p === '/api/versions' && method === 'GET') {
    requireCap(user, 'view');
    const versions = db.prepare('SELECT * FROM graph_versions ORDER BY version DESC LIMIT 100').all();
    return sendJson(res, 200, { versions: versions.map(v => ({ ...v, detail: hasCap(role, 'audit.read') ? safeJson(v.detail) : null })) });
  }

  if (p === '/api/audit' && method === 'GET') {
    requireCap(user, 'audit.read');
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
    return sendJson(res, 200, { entries: rows.map(r => projectAudit(role, r)) });
  }

  if (p === '/api/export' && method === 'POST') {
    requireCap(user, 'export');
    const body = await readBody(req);
    return handleExport(req, res, db, user, body, ids);
  }

  throw new HttpError(404, 'not found');
}

function safeJson(value) {
  if (value == null) return null;
  try { return JSON.parse(value); } catch { return value; }
}

function demoUsers() {
  return [
    { username: 'admin', name: '林知远', role: 'admin', password: 'demo-admin' },
    { username: 'analyst', name: '周未然', role: 'analyst', password: 'demo-analyst' },
    { username: 'auditor', name: '陈静', role: 'auditor', password: 'demo-auditor' },
    { username: 'viewer', name: '访客', role: 'viewer', password: 'demo-viewer' },
  ];
}

export { demoUsers };

function windowParams(url, db) {
  const fallback = defaultWindow(db);
  const from = qp(url, 'from');
  const to = qp(url, 'to');
  const w = {
    from: from ? isoOrThrow(from, 'from') : fallback.from,
    to: to ? isoOrThrow(to, 'to') : fallback.to,
  };
  if (new Date(w.from) >= new Date(w.to)) throw new HttpError(400, 'from must be before to');
  const days = (new Date(w.to) - new Date(w.from)) / 86400000;
  if (days > 366) throw new HttpError(400, 'window exceeds 366 days');
  return w;
}

function labelsFor(db, type, id, role) {
  return db.prepare(`SELECT * FROM labels WHERE target_type=? AND target_id=? AND revoked_at IS NULL ORDER BY created_at DESC`)
    .all(type, id).map(l => projectLabel(role, l));
}

function traceTransaction(db, { txnId, ref, role }) {
  const row = ref
    ? db.prepare('SELECT * FROM transactions WHERE id=?').get(ref)
    // Prefer the live, non-duplicate version: a redelivery copy shares its
    // version number with the original, so version alone is not a tie-break.
    : db.prepare(`SELECT * FROM transactions WHERE txn_id=?
      ORDER BY (superseded_by_id IS NULL) DESC, is_duplicate ASC, version DESC LIMIT 1`).get(txnId);
  if (!row) throw new HttpError(404, 'transaction not found');
  const chain = db.prepare('SELECT * FROM transactions WHERE txn_id=? ORDER BY version ASC').all(row.txn_id);
  const asEndpoints = db.prepare(`SELECT ge.*, et.contribution, et.flags FROM edge_transactions et
    JOIN graph_edges ge ON ge.id=et.edge_id WHERE et.txn_ref=?`).all(row.id);
  const duplicates = db.prepare('SELECT * FROM transactions WHERE duplicate_of=?').all(row.id);
  const nodeTypes = [];
  const nodes = [];
  const pushNode = (type, id) => {
    if (!id) return;
    const canon = resolveCanon(db, type, id);
    const key = `${type}:${canon}`;
    if (nodes.some(n => n.key === key)) return;
    nodes.push({ key, ...nodeSummary(db, type, canon) });
  };
  pushNode('account', row.account_id);
  pushNode('device', row.device_id);
  pushNode('merchant', row.merchant_id);
  pushNode('account', row.counterparty_account_id);
  for (const e of asEndpoints) {
    pushNode(e.src_type, e.src_id);
    pushNode(e.dst_type, e.dst_id);
  }
  let batch = null;
  if (row.ingest_batch_id) batch = db.prepare('SELECT * FROM import_batches WHERE id=?').get(row.ingest_batch_id);
  const labels = db.prepare(`SELECT * FROM labels WHERE revoked_at IS NULL AND (
    (target_type='account' AND target_id IN (?,?)) OR (target_type='device' AND target_id=?) OR (target_type='merchant' AND target_id=?))
  `).all(row.canon_account_id, row.canon_counterparty_id || row.canon_account_id, row.canon_device_id || '', row.canon_merchant_id || '');
  const versionMeta = asEndpoints.length
    ? db.prepare('SELECT * FROM graph_versions WHERE version IN (? , ?)')
      .all(...[Math.min(...asEndpoints.map(e => e.computed_version)), Math.max(...asEndpoints.map(e => e.computed_version))].map(v => v || 0))
    : [];
  return {
    transaction: projectTransaction(role, row),
    versions: chain.map(t => projectTransaction(role, t)),
    duplicate_divergence: duplicates.map(d => projectTransaction(role, d)),
    endpoints: asEndpoints.map(e => ({
      edge_id: e.id, rel_key: e.rel_key, edge_type: e.edge_type, day: e.day,
      src_type: e.src_type, src_id: e.src_id, dst_type: e.dst_type, dst_id: e.dst_id,
      strength: e.strength, txn_count: e.txn_count, amount_cents: e.amount_cents,
      late_count: e.late_count, duplicate_count: e.duplicate_count,
      computed_version: e.computed_version,
      contribution: e.contribution, flags: safeJson(e.flags),
      factors: safeJson(e.factors),
    })),
    nodes: nodes.map(n => projectNode(role, { ...n, labels: labelsFor(db, n.type, n.id, role) })),
    labels: labels.map(l => projectLabel(role, l)),
    batch,
    graph_versions: versionMeta.map(v => ({ ...v, detail: hasCap(role, 'audit.read') ? safeJson(v.detail) : null })),
    lineage: {
      raw_transaction: row.id,
      business_id: row.txn_id,
      occurrences: chain.map(t => ({ id: t.id, version: t.version, received_at: t.received_at, batch: t.ingest_batch_id })),
      duplicate_copies: duplicates.length,
      edges_derived: [...new Set(asEndpoints.map(e => `${e.rel_key}@${e.day}`))],
    },
  };
}

// ---------------------------------------------------------------------------
// Exports: same projection as the API, plus capability + field checks.
// ---------------------------------------------------------------------------

async function handleExport(req, res, db, user, body, ids) {
  const kind = body.kind || 'transactions';
  const w = {
    from: body.from ? isoOrThrow(body.from, 'from') : defaultWindow(db).from,
    to: body.to ? isoOrThrow(body.to, 'to') : defaultWindow(db).to,
  };
  const fields = policyFor(user.role).fields;
  if (kind === 'transactions' || kind === 'evidence') {
    const ids = Array.isArray(body.txn_ids) ? body.txn_ids : null;
    let rows;
    if (ids) {
      if (ids.length > config.maxExportRows) throw new HttpError(413, `selection exceeds ${config.maxExportRows} rows`);
      rows = ids.length
        ? db.prepare(`SELECT * FROM transactions WHERE id IN (${ids.map(() => '?').join(',')}) AND superseded_by_id IS NULL`).all(...ids)
        : [];
    } else {
      rows = db.prepare(`SELECT * FROM transactions WHERE occurred_at>=? AND occurred_at<? AND superseded_by_id IS NULL
        ORDER BY occurred_at DESC LIMIT ?`).all(w.from, w.to, config.maxExportRows);
    }
    const view = rows.map(t => projectTransaction(user.role, t));
    const headers = ['txn_id', 'occurred_at', 'amount_cents', 'device_id', 'merchant_id', 'account_id', 'counterparty_account_id', 'ip', 'channel', 'status', 'version', 'is_duplicate', 'is_late', 'late_minutes', 'received_at', 'note'];
    const available = headers.filter(h => view.some(v => v[h] !== undefined));
    const csv = toCsv(available, view);
    audit(db, { actor: user.username, role: user.role, action: 'export.transactions', objectType: 'export',
      detail: { rows: rows.length, fields: available, window: w } });
    return sendExport(res, `transactions-${w.from.slice(0, 10)}_${w.to.slice(0, 10)}.csv`, csv,
      { rows: rows.length, fields: available, role: user.role });
  }

  if (kind === 'graph') {
    requireCap(user, 'export.graph');
    const seeds = resolveSeeds(db, ids, Array.isArray(body.seeds) ? body.seeds : []);
    const graph = seeds.requested && !seeds.length
      ? { nodes: [], edges: [] }
      : graphAround(db, { from: w.from, to: w.to, seeds, hops: body.hops || 2, minStrength: body.min_strength || 0 });
    const nodes = graph.nodes.map(n => projectNode(user.role, nodeSummary(db, n.type, n.id)));
    const edges = graph.edges.map(e => projectEdge(user.role, e));
    // Strip any raw identifiers that the projection did not authorise.
    const payload = JSON.stringify({ generated_at: config.now().toISOString(), role: user.role, window: w,
      nodes, edges, graph_version: getGraphVersion(db) }, null, 2);
    audit(db, { actor: user.username, role: user.role, action: 'export.graph', objectType: 'export',
      detail: { nodes: nodes.length, edges: edges.length, window: w } });
    return sendExport(res, `graph-${w.from.slice(0, 10)}_${w.to.slice(0, 10)}.json`, payload,
      { nodes: nodes.length, edges: edges.length, role: user.role }, 'application/json');
  }

  if (kind === 'traces') {
    const ids = Array.isArray(body.refs) ? body.refs : [];
    if (ids.length > 200) throw new HttpError(413, 'trace export limited to 200 rows');
    if (ids.length && !mayUseRawTxnRef(user)) {
      throw new HttpError(403, `role ${user.role} must trace by business txn_id, not internal row ids`);
    }
    const traces = ids.map(ref => traceTransaction(db, { ref, role: user.role }));
    audit(db, { actor: user.username, role: user.role, action: 'export.traces', objectType: 'export',
      detail: { rows: traces.length } });
    return sendExport(res, 'traces.json', JSON.stringify({ role: user.role, traces }, null, 2),
      { rows: traces.length, role: user.role }, 'application/json');
  }

  throw new HttpError(400, 'unknown export kind');
}

function sendExport(res, filename, body, meta, contentType = 'text/csv; charset=utf-8') {
  // The export path takes the same scrubber as the API: restricted roles get
  // pseudonymous ids in CSV cells and inside composite JSON fields alike.
  const safeBody = res.__scrub ? res.__scrub(body) : body;
  res.writeHead(200, {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-export-rows': String(meta.rows ?? meta.nodes ?? 0),
    'x-export-policy': `role=${meta.role}; fields=${(meta.fields || []).join('+')}`,
  });
  res.end(safeBody);
}
