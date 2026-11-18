import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { seedDatabase } from './seed.js';
import path from 'node:path';
import fs from 'node:fs';

const dbFile = process.env.TRACELINK_DB || path.join(config.root, 'data', 'tracelink.db');
const fresh = process.argv.includes('--reset') || process.env.TRACELINK_RESET === '1';
if (fresh && fs.existsSync(dbFile)) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
}
if (fresh) process.env.TRACELINK_SEED_FORCE = '1';

const server = createApp({ dbFile, seed: false });
seedDatabase(server.db);

server.listen(config.port, config.host, () => {
  console.log(`tracelink listening on http://${config.host}:${config.port}`);
  console.log(`database: ${dbFile}`);
});
