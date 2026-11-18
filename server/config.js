import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || '127.0.0.1',
  now: () => new Date(),
  // Simulation clock positions the seeded stream relative to "now" so the demo
  // always has fresh, late and duplicate trades to reason about.
  latencyBudgetMinutes: 10,
  lateToleranceMinutes: 30,
  // Fraction of a window whose early span is treated as provisional for
  // completeness: transactions arriving after this are flagged "迟到".
  provisionalEdgeRatio: 0.35,
  risk: {
    amountWeight: 1.0,
    highAmount: 25000,
    crossWindowBoost: 0.6,
    lateBoost: 0.4,
    duplicateBoost: 0.5,
    manualBoost: 1.2,
  },
  // Field-level visibility. Roles only ever see fields they are cleared for,
  // and the same filter is applied to exports and raw trace payloads.
  roleFields: {
    admin: ['amount', 'ip', 'device_id', 'merchant', 'counterparty', 'note'],
    analyst: ['amount', 'ip', 'device_id', 'merchant', 'counterparty', 'note'],
    auditor: ['amount', 'device_id', 'merchant'],
    viewer: ['amount'],
  },
  labelTypes: ['confirmed_fraud', 'suspicious', 'legitimate', 'watchlist'],
  edgeTypes: ['shared_device', 'ip_overlap', 'merchant_link', 'amount_flow', 'manual_link'],
  maxExportRows: 5000,
  graphHopLimit: 4,
};

export const ROLE_CAPS = {
  admin: new Set(['view', 'annotate', 'merge', 'undo_merge', 'export', 'export.graph', 'audit.read', 'review', 'ingest', 'demo.reset']),
  analyst: new Set(['view', 'annotate', 'merge', 'undo_merge', 'export', 'export.graph', 'ingest']),
  auditor: new Set(['view', 'export', 'audit.read', 'review']),
  viewer: new Set(['view']),
};

export function hasCap(role, cap) {
  return Boolean(ROLE_CAPS[role]?.has(cap));
}
