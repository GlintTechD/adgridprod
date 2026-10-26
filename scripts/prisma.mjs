import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

if (process.env.NEON_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.NEON_DATABASE_URL;
  const directUrl = new URL(process.env.NEON_DIRECT_URL || process.env.NEON_DATABASE_URL);
  if (!process.env.NEON_DIRECT_URL) {
    directUrl.hostname = directUrl.hostname.replace(/-pooler(?=\.|$)/, '');
  }
  process.env.DIRECT_URL = directUrl.toString();
}

const prismaCli = path.resolve('node_modules', 'prisma', 'build', 'index.js');
const result = spawnSync(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[Prisma] Could not start Prisma CLI: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
