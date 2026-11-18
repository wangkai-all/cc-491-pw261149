import crypto from 'node:crypto';
import { config } from './config.js';
import { audit, getSetting, setSetting, getGraphVersion } from './db.js';
import { ingestBatch } from './ingest.js';
import { addLabel } from './mutations.js';

export const DEMO_USERS = [
  { username: 'admin', name: '林知远', role: 'admin', password: 'demo-admin' },
  { username: 'analyst', name: '周未然', role: 'analyst', password: 'demo-analyst' },
  { username: 'auditor', name: '陈静', role: 'auditor', password: 'demo-auditor' },
  { username: 'viewer', name: '访客', role: 'viewer', password: 'demo-viewer' },
];

const ACCOUNTS = [
  ['AC-1001', '6222020200001001', '招商银行', '王海涛', 'retail'],
  ['AC-1002', '6222020200001002', '招商银行', '李梦琪', 'retail'],
  ['AC-1003', '6222020200001003', '工商银行', '张志成', 'retail'],
  ['AC-1004', '6222020200001004', '建设银行', '赵子轩', 'retail'],
  ['AC-1005', '6222020200001005', '农业银行', '孙晓雯', 'retail'],
  ['AC-2001', '6222020200002001', '招商银行', '陈国栋', 'retail'],
  ['AC-2002', '6222020200002002', '招商银行', '刘丽娟', 'retail'],
  ['AC-2003', '6222020200002003', '平安银行', '黄文博', 'retail'],
  ['AC-2004', '6222020200002004', '平安银行', '周敏', 'retail'],
  ['AC-3001', '6222020200003001', '浦发银行', '吴建国', 'smb'],
  ['AC-3002', '6222020200003002', '浦发银行', '郑雅文', 'smb'],
  ['AC-3003', '6222020200003003', '中信银行', '何俊杰', 'smb'],
  ['AC-3004', '6222020200003004', '中信银行', '马晓东', 'smb'],
  ['AC-4001', '6222020200004001', '交通银行', '许文静', 'retail'],
  ['AC-4002', '6222020200004002', '交通银行', '冯浩然', 'retail'],
];

const DEVICES = [
  ['DV-01', 'a1b2c3d4e5f601', 'android', 'Redmi Note 12'],
  ['DV-02', 'a1b2c3d4e5f602', 'android', 'Xiaomi 13'],
  ['DV-03', 'a1b2c3d4e5f603', 'ios', 'iPhone 13'],
  ['DV-04', 'a1b2c3d4e5f604', 'android', 'OPPO Reno 8'],
  ['DV-05', 'a1b2c3d4e5f605', 'ios', 'iPhone 15'],
  ['DV-06', 'a1b2c3d4e5f606', 'web', 'Chrome 126 / Win11'],
  ['DV-07', 'a1b2c3d4e5f607', 'web', 'Safari 17 / macOS'],
  ['DV-08', 'a1b2c3d4e5f608', 'android', 'Vivo X90'],
  ['DV-09', 'a1b2c3d4e5f609', 'ios', 'iPhone SE'],
  ['DV-10', 'a1b2c3d4e5f610', 'android', 'Samsung S23'],
];

const MERCHANTS = [
  ['MC-01', '星辰数码专营店', 'electronics', 'CN', 3],
  ['MC-02', '优品百货', 'retail', 'CN', 1],
  ['MC-03', '快充网络科技', 'digital', 'CN', 4],
  ['MC-04', '云海票务', 'travel', 'CN', 2],
  ['MC-05', '恒通支付服务', 'financial', 'CN', 5],
  ['MC-06', '绿色食品超市', 'grocer', 'CN', 1],
  ['MC-07', '极速游戏点卡', 'gaming', 'CN', 4],
  ['MC-08', '海岸咖啡', 'food', 'CN', 1],
  ['MC-09', '环球购跨境', 'cross_border', 'HK', 3],
  ['MC-10', '安家房产中介', 'realestate', 'CN', 2],
];

function iso(minutesAgo) {
  return new Date(config.now().getTime() - minutesAgo * 60000).toISOString();
}

export function seedDatabase(db) {
  if (getSetting(db, 'seeded') === '1') return { seeded: false };
  return seedSync(db);
}

function seedSync(db) {
  // Password hashing is async; the demo credentials are fixed so we precompute
  // them once with a synchronous scrypt call.
  for (const user of DEMO_USERS) {
    const salt = `demo-salt-${user.username}`;
    const { hash } = hashPasswordSync(user.password, salt);
    db.prepare(`INSERT INTO users(id,username,display_name,role,password_salt,password_hash,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(`U-${user.username}`, user.username, user.name, user.role, salt, hash,
      config.now().toISOString());
  }

  const insertAccount = db.prepare(`INSERT INTO accounts(id,account_no,bank,holder_name,opened_at,segment)
    VALUES(?,?,?,?,?,?)`);
  for (const [id, no, bank, holder, segment] of ACCOUNTS) {
    insertAccount.run(id, no, bank, holder, iso(60 * 24 * 400), segment);
  }
  const insertDevice = db.prepare('INSERT INTO devices(id,fingerprint,kind,model,first_seen) VALUES(?,?,?,?,?)');
  for (const [id, fp, kind, model] of DEVICES) insertDevice.run(id, fp, kind, model, iso(60 * 24 * 120));
  const insertMerchant = db.prepare('INSERT INTO merchants(id,name,category,country,risk_level) VALUES(?,?,?,?,?)');
  for (const [id, name, category, country, risk] of MERCHANTS) insertMerchant.run(id, name, category, country, risk);

  const records = buildRecords();
  const batches = [
    { name: '历史回填 2024-Q2', slice: records.slice(0, 40), late: true },
    { name: '日终文件', slice: records.slice(40, 52), late: false },
    { name: '实时流', slice: records.slice(52), late: false },
  ];
  let n = 0;
  for (const batch of batches) {
    n += 1;
    ingestBatch(db, batch.slice, {
      actor: 'system',
      role: 'admin',
      source: batch.name,
      batchId: `B-SEED-${String(n).padStart(2, '0')}`,
    });
  }

  // A redelivered file: 6 of the same records arrive again, exercising the
  // duplicate path. The copies are linked, not counted.
  ingestBatch(db, records.slice(10, 16).map(r => ({ ...r, received_at: undefined })), {
    actor: 'system', role: 'admin', source: '重复投递（模拟上游重放）', batchId: 'B-SEED-04',
  });

  // A revision: merchant was misclassified upstream, corrected later.
  const revised = records.find(r => r.txn_id === 'T-2112');
  ingestBatch(db, [{ ...revised, merchant_id: 'MC-08', note: '上游更正商户号' }], {
    actor: 'system', role: 'admin', source: '更正报文', batchId: 'B-SEED-05',
  });

  const insertLabels = [
    ['AC-1003', 'account', 'confirmed_fraud', 0.92, '与三个已确认欺诈账户共用设备，资金快进快出', 'analyst'],
    ['AC-1004', 'account', 'suspicious', 0.71, '夜间集中交易，收款方为高风险商户', 'analyst'],
    ['AC-2002', 'account', 'watchlist', 0.55, 'IP 与多个新开户账户重合', 'analyst'],
    ['DV-01', 'device', 'suspicious', 0.80, '设备指纹在 5 个账户间轮换', 'analyst'],
    ['MC-05', 'merchant', 'confirmed_fraud', 0.88, '监管通报的非法支付通道', 'admin'],
  ];
  for (const [id, type, label, conf, note, author] of insertLabels) {
    const res = addLabel(db, { targetType: type, targetId: id, label, confidence: conf, note, actor: author, role: author === 'admin' ? 'admin' : 'analyst' });
    if (author === 'admin') {
      db.prepare("UPDATE labels SET review_state='approved', reviewed_by='auditor', reviewed_at=? WHERE id=?")
        .run(config.now().toISOString(), res.label.id);
    }
  }

  setSetting(db, 'seeded', '1');
  audit(db, { actor: 'system', role: 'admin', action: 'seed.complete', detail: { records: records.length, graph_version: getGraphVersion(db) } });
  return { seeded: true, records: records.length };
}

function hashPasswordSync(password, salt) {
  return { hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}

// ---------------------------------------------------------------------------
// Dataset generator
// ---------------------------------------------------------------------------

export function buildRecords() {
  const records = [];
  let n = 0;
  const push = (rec) => {
    n += 1;
    records.push(rec);
  };

  // Ring A: mule accounts sharing two devices and a payment-shell merchant.
  const ringA = [
    ['AC-1001', 'DV-01', 'MC-01'], ['AC-1002', 'DV-01', 'MC-03'],
    ['AC-1003', 'DV-02', 'MC-03'], ['AC-1004', 'DV-01', 'MC-05'],
  ];
  for (let i = 0; i < 26; i++) {
    const [acct, dev, merch] = ringA[i % ringA.length];
    push({
      txn_id: `T-${1000 + i}`,
      account_id: acct,
      device_id: dev,
      merchant_id: merch,
      amount_cents: 180000 + (i % 7) * 42000,
      occurred_at: iso(60 * 24 * (6 - (i % 6)) + 40 * i),
      received_at: iso(60 * 24 * (6 - (i % 6)) + 40 * i - 1),
      ip: `203.0.113.${10 + (i % 4)}`,
      channel: 'app',
      direction: 'out',
    });
  }

  // Ring B: accounts joined only through shared IP + counterparty flows.
  for (let i = 0; i < 18; i++) {
    push({
      txn_id: `T-${2000 + i}`,
      account_id: ['AC-2001', 'AC-2002', 'AC-2003', 'AC-2004'][i % 4],
      device_id: `DV-${String(5 + (i % 3)).padStart(2, '0')}`,
      merchant_id: ['MC-05', 'MC-09', 'MC-07'][i % 3],
      counterparty_account_id: ['AC-1001', 'AC-1003', 'AC-2002'][i % 3],
      amount_cents: 950000 + i * 53000,
      occurred_at: iso(60 * 24 * (5 - (i % 5)) + 15 * i + 20),
      received_at: iso(60 * 24 * (5 - (i % 5)) + 15 * i + 19),
      ip: `198.51.100.${40 + (i % 3)}`,
      channel: i % 2 ? 'app' : 'web',
      direction: 'out',
    });
  }

  // Ring C: merchant-side split payments, many small inflows.
  for (let i = 0; i < 20; i++) {
    push({
      txn_id: `T-${3000 + i}`,
      account_id: ['AC-3001', 'AC-3002', 'AC-3003', 'AC-3004'][i % 4],
      device_id: `DV-${String(7 + (i % 4)).padStart(2, '0')}`,
      merchant_id: ['MC-02', 'MC-06', 'MC-10'][i % 3],
      counterparty_account_id: ['AC-3002', 'AC-3001'][i % 2],
      amount_cents: 65000 + i * 7100,
      occurred_at: iso(60 * 24 * (4 - (i % 4)) + 30 * i + 5),
      received_at: iso(60 * 24 * (4 - (i % 4)) + 30 * i + 4),
      ip: `192.0.2.${20 + (i % 5)}`,
      channel: 'web',
      direction: i % 2 ? 'in' : 'out',
    });
  }

  // Clean baseline traffic.
  for (let i = 0; i < 24; i++) {
    push({
      txn_id: `T-${4000 + i}`,
      account_id: ['AC-1005', 'AC-2001', 'AC-3004', 'AC-4001', 'AC-4002'][i % 5],
      device_id: `DV-${String(3 + (i % 8)).padStart(2, '0')}`,
      merchant_id: ['MC-02', 'MC-04', 'MC-06', 'MC-08'][i % 4],
      amount_cents: 12000 + i * 3300,
      occurred_at: iso(60 * 24 * (6 - (i % 6)) + 55 * i + 11),
      received_at: iso(60 * 24 * (6 - (i % 6)) + 55 * i + 10),
      ip: `192.0.2.${100 + (i % 6)}`,
      channel: i % 3 ? 'app' : 'web',
      direction: 'out',
    });
  }

  // Late-arriving file: system of record lagged by 2-5 hours.
  for (let i = 0; i < 8; i++) {
    push({
      txn_id: `T-${5000 + i}`,
      account_id: ['AC-1003', 'AC-2002', 'AC-3003'][i % 3],
      device_id: 'DV-02',
      merchant_id: 'MC-07',
      amount_cents: 300000 + i * 88000,
      occurred_at: iso(60 * 24 * 3 + 90 * i + 30),
      received_at: iso(60 * 24 * 3 + 90 * i + 30 - 260),
      ip: '203.0.113.11',
      channel: 'app',
      direction: 'out',
      note: 'T+4 补传',
    });
  }

  // Two transfers that will form a traceable path AC-1002 -> AC-2003 -> MC-03.
  push({
    txn_id: 'T-2110', account_id: 'AC-1002', device_id: 'DV-01', merchant_id: 'MC-04',
    counterparty_account_id: 'AC-2003', amount_cents: 480000,
    occurred_at: iso(60 * 24 * 2 + 15), received_at: iso(60 * 24 * 2 + 14), ip: '203.0.113.12', channel: 'app', direction: 'out',
  });
  push({
    txn_id: 'T-2111', account_id: 'AC-2003', device_id: 'DV-06', merchant_id: 'MC-03',
    counterparty_account_id: 'AC-1004', amount_cents: 460000,
    occurred_at: iso(60 * 24 * 2 + 5), received_at: iso(60 * 24 * 2 + 4), ip: '198.51.100.41', channel: 'web', direction: 'out',
  });
  // The record that will later be revised upstream.
  push({
    txn_id: 'T-2112', account_id: 'AC-2004', device_id: 'DV-05', merchant_id: 'MC-09',
    counterparty_account_id: 'AC-1001', amount_cents: 233000,
    occurred_at: iso(60 * 24 * 2 + 100), received_at: iso(60 * 24 * 2 + 99), ip: '198.51.100.41', channel: 'app', direction: 'out',
  });

  return records;
}
