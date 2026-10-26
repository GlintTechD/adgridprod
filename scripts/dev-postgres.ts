/**
 * Local development Postgres (PGlite) for ADGRID.
 *
 * Spins up an embedded Postgres (WASM) that speaks the real Postgres wire
 * protocol, so Prisma Client and `prisma migrate` can connect to it exactly as
 * they would to a Neon database. This exists so signup / sign-in / OTP
 * verification can be exercised locally without Docker or a cloud project.
 *
 * Usage:
 *   npm run dev:db              # start on 127.0.0.1:5433 (persistent data)
 *   npm run dev:db -- --port 5544 --memory
 *
 * Then point .env at it:
 *   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres"
 *   DIRECT_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres"
 *
 * This is a DEVELOPMENT convenience only. Production uses Neon Postgres.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

interface CliOptions {
  port: number;
  host: string;
  dataDir: string;
  memory: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const portFlag = argv.indexOf('--port');
  const hostFlag = argv.indexOf('--host');
  const dirFlag = argv.indexOf('--data-dir');

  return {
    port: portFlag !== -1 ? Number(argv[portFlag + 1]) : Number(process.env.PGLITE_PORT || 5433),
    host: hostFlag !== -1 ? String(argv[hostFlag + 1]) : process.env.PGLITE_HOST || '127.0.0.1',
    dataDir: dirFlag !== -1 ? String(argv[dirFlag + 1]) : process.env.PGLITE_DATA_DIR || '.pglite-data',
    memory: argv.includes('--memory'),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.memory) {
    console.log('[dev:db] starting in-memory Postgres (data is discarded on exit)');
  } else {
    const absoluteDataDir = path.resolve(process.cwd(), options.dataDir);
    fs.mkdirSync(absoluteDataDir, { recursive: true });
    console.log(`[dev:db] persisted data directory: ${absoluteDataDir}`);
  }

  const db = options.memory
    ? new PGlite()
    : new PGlite(path.resolve(process.cwd(), options.dataDir));

  await db.waitReady;

  const server = new PGLiteSocketServer({
    db,
    port: options.port,
    host: options.host,
    maxConnections: 10,
  });

  await server.start();

  // PGlite accepts any username/password combination; Prisma still requires
  // credentials to be present in the URL.
  console.log(
    `[dev:db] ready → postgresql://postgres:postgres@${options.host}:${options.port}/postgres`
  );
  console.log('[dev:db] press Ctrl+C to stop');

  const shutdown = async (signal: string) => {
    console.log(`\n[dev:db] received ${signal}, shutting down`);
    try {
      await server.stop();
      await db.close();
    } catch (error) {
      console.error('[dev:db] shutdown error:', error);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[dev:db] failed to start:', error);
  process.exit(1);
});
