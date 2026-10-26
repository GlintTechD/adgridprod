import 'dotenv/config';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';

if (process.env.NEON_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.NEON_DATABASE_URL;
}

const require = createRequire(import.meta.url);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  var prismaGlobal: PrismaClient | undefined;
}

const PRISMA_LOG: any = process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'];

/**
 * Prisma client factory.
 *
 * Production uses Neon Postgres. NEON_DATABASE_URL is used for runtime traffic;
 * NEON_DIRECT_URL may be set for migrations, otherwise NEON_DATABASE_URL is
 * used. DATABASE_URL and DIRECT_URL remain supported for compatibility — see
 * docs/PRODUCTION_SETUP.md.
 *
 * Local development can instead run against the embedded Postgres started by
 * `npm run dev:db`. That path goes through a `pg` driver adapter and Prisma's
 * WebAssembly query engine, so no downloadable native engine binary is needed.
 * It is opt-in via PRISMA_DRIVER_ADAPTER=pg and never affects production.
 *
 * Two rules keep a misconfigured environment from taking down every endpoint:
 *
 * 1. The client is built lazily. Constructing it eagerly means its async engine
 *    instantiation floats at import time; when that promise rejects (missing or
 *    incompatible query engine, bad connection string) nothing is awaiting it,
 *    Node treats it as an unhandled rejection and the process dies — on
 *    serverless that surfaces as FUNCTION_INVOCATION_FAILED on routes that never
 *    touch the database, such as /api and /api/health.
 * 2. The local driver-adapter switch is ignored on serverless runtimes, so a
 *    `.env` copied into Vercel cannot import dev-only packages that are not in
 *    the function bundle.
 */
const IS_SERVERLESS =
  process.env.VERCEL === '1' ||
  process.env.VERCEL_ENV !== undefined ||
  process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;

function wantsDriverAdapter(): boolean {
  if (process.env.PRISMA_DRIVER_ADAPTER !== 'pg') {
    return false;
  }

  if (!IS_SERVERLESS) {
    return true;
  }

  console.warn(
    '[Database] PRISMA_DRIVER_ADAPTER=pg is a local-development switch and is ignored on serverless ' +
      'runtimes (it needs dev-only packages and the WASM engine loader, which are not in the function ' +
      'bundle). Remove it from this environment\'s variables so DATABASE_URL is used.'
  );
  return false;
}

/**
 * Connection strings carry a password, so only the shape is ever logged.
 */
function describeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? `:${parsed.port}` : '';
    const database = parsed.pathname.replace(/^\//, '') || '(no database name)';
    return `${parsed.protocol}//${parsed.hostname}${port}/${database}`;
  } catch {
    return 'an unparseable connection string';
  }
}

function assertDatabaseUrl(): void {
  if (process.env.NEON_DATABASE_URL) {
    let neonUrl: URL;
    try {
      neonUrl = new URL(process.env.NEON_DATABASE_URL);
    } catch {
      throw new Error('[Database] NEON_DATABASE_URL is not a valid connection string.');
    }

    if (!['postgres:', 'postgresql:'].includes(neonUrl.protocol)) {
      throw new Error('[Database] NEON_DATABASE_URL must use the PostgreSQL protocol.');
    }

    if (!neonUrl.searchParams.has('connect_timeout')) {
      neonUrl.searchParams.set('connect_timeout', '15');
    }
    process.env.DATABASE_URL = neonUrl.toString();
  }

  const url = process.env.DATABASE_URL;

  if (!url) {
    // Fail with a named cause instead of falling back to a local file: there is
    // no SQLite fallback any more, and every query would fail confusingly.
    throw new Error(
      '[Database] NEON_DATABASE_URL (or DATABASE_URL) is not set for this environment. ' +
        'Configure a Neon Postgres connection string — see docs/PRODUCTION_SETUP.md.'
    );
  }

  // A leaked local .env is the difference between "the API works" and "every
  // request times out", so say so instead of letting the pooler hang.
  if (IS_SERVERLESS && /@(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/)/.test(url)) {
    throw new Error(
      `[Database] DATABASE_URL points at the local development database (${describeDatabaseUrl(
        url
      )}), which this runtime cannot reach. Set the Neon connection string for Production and Preview, then redeploy.`
    );
  }
}

function buildClient(): PrismaClient {
  if (wantsDriverAdapter()) {
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { Pool } = require('pg');
    const { PrismaClient: WasmPrismaClient } = require('@prisma/client/wasm');

    // The embedded database is single-threaded, so keep the pool small.
    const pool = new Pool({
      connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL,
      max: Number(process.env.PRISMA_POOL_MAX || 5),
    });

    return new WasmPrismaClient({ adapter: new PrismaPg(pool), log: PRISMA_LOG });
  }

  assertDatabaseUrl();

  return new PrismaClient({ log: PRISMA_LOG });
}

let client: PrismaClient | null = globalThis.prismaGlobal ?? null;

/**
 * Builds the client on first use. Failures are never cached: a transient problem
 * (DNS, a cold pooler) must not permanently brick a warm instance, and the
 * caller always receives the current error so it can be reported per request.
 */
function resolveClient(): PrismaClient {
  if (client) {
    return client;
  }

  const built = buildClient();
  client = built;

  // Retain the client across warm serverless invocations (Vercel) and in development.
  if (process.env.NODE_ENV !== 'production' || process.env.VERCEL) {
    globalThis.prismaGlobal = built;
  }

  return built;
}

/**
 * Lazy stand-in for the client so `import { prisma }` can never throw. Every
 * property access resolves the real client, which keeps call sites
 * (`prisma.user.findUnique`, `prisma.$transaction`, `prisma.$queryRawUnsafe`)
 * unchanged and moves construction errors to a place that has an error handler.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    // Never mistaken for a thenable by `await prisma` or by Promise.resolve().
    if (property === 'then') {
      return undefined;
    }

    // Session teardown must be safe before anything was ever connected.
    if (property === '$connect' || property === '$disconnect') {
      return async () => {
        if (!client) {
          return;
        }
        return (client as any)[property]();
      };
    }

    const value = (resolveClient() as any)[property];
    return typeof value === 'function' ? value.bind(client) : value;
  },
}) as PrismaClient;

// Long-lived servers want the engine (and any configuration error) resolved at
// boot. Serverless gets neither benefit nor safety from that, so it stays lazy.
if (!IS_SERVERLESS) {
  try {
    resolveClient();
  } catch (error: any) {
    console.error(`[Database] Prisma Client could not be initialised: ${error?.message || error}`);
  }
}

export default prisma;
