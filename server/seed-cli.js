import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { openDb, getSetting } from './db.js';
import { seedDatabase } from './seed.js';

const dbFile = process.env.TRACELINK_DB || path.join(config.root, 'data', 'tracelink.db');
const reset = process.argv.includes('--reset');
if (reset) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
}
const db = openDb(dbFile);
const result = seedDatabase(db);
console.log(result.seeded ? `seeded ${result.records} records -> ${dbFile}` : `database already seeded: ${dbFile}`);
console.log('graph_version =', getSetting(db, 'graph_version', '0'));
