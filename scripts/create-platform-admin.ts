/**
 * Create (or repair) a Platform Admin account.
 *
 * Production must never run `npm run db:seed` - that script creates demo
 * accounts with a published password. This is the safe bootstrap: it creates a
 * single Platform Admin with a strong generated password that is printed once.
 *
 * Usage:
 *   npx tsx scripts/create-platform-admin.ts --email you@company.com --name "Ada Obi"
 *   npx tsx scripts/create-platform-admin.ts --email you@company.com --password 'Custom-Passw0rd!'
 *   npx tsx scripts/create-platform-admin.ts --email you@company.com --unverified
 *
 * Requires NEON_DATABASE_URL (or DATABASE_URL) to point at the target database.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import { prisma } from '../server/db';
import { ROLE_DEFAULT_PERMISSIONS } from '../server/auth';

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function generatePassword(): string {
  // Strong, copy-pasteable, no ambiguous characters.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const pick = (length: number) =>
    Array.from({ length }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
  return `${pick(4)}-${pick(4)}-${pick(4)}-${pick(4)}`;
}

async function main() {
  const email = (readFlag('email') || '').trim().toLowerCase();
  const name = (readFlag('name') || 'Platform Administrator').trim();
  const providedPassword = readFlag('password');
  const skipVerification = process.argv.includes('--unverified');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('A valid --email is required, e.g. --email ops@your-domain.com');
    process.exit(1);
  }

  const databaseHost = (
    process.env.NEON_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.DIRECT_URL ||
    ''
  )
    .replace(/\/\/[^@]*@/, '//***@')
    .split('?')[0];
  console.log(`[admin] target database: ${databaseHost || '(unset)'}`);

  const password = providedPassword || generatePassword();
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const nameParts = name.split(/\s+/);

  const existing = await prisma.user.findUnique({ where: { email } });

  const user = existing
    ? await prisma.user.update({
        where: { email },
        data: {
          passwordHash,
          role: 'Platform Admin',
          status: 'ACTIVE',
          emailVerifiedAt: skipVerification ? existing.emailVerifiedAt : existing.emailVerifiedAt || new Date(),
        },
      })
    : await prisma.user.create({
        data: {
          email,
          name,
          firstName: nameParts[0] || name,
          lastName: nameParts.slice(1).join(' ') || undefined,
          passwordHash,
          role: 'Platform Admin',
          title: 'Platform Administrator',
          tenantId: null,
          status: 'ACTIVE',
          emailVerifiedAt: skipVerification ? null : new Date(),
        },
      });

  // Keep the role's canonical permissions present for anything that reads them.
  const permissions = ROLE_DEFAULT_PERMISSIONS['Platform Admin'] || [];
  if (permissions.length > 0) {
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({ role: 'Platform Admin', permission })),
      skipDuplicates: true,
    });
  }

  console.log(`\n[admin] ${existing ? 'updated' : 'created'} Platform Admin: ${user.email}`);
  if (!providedPassword) {
    console.log(`[admin] generated password (shown once): ${password}`);
  }
  console.log(
    `[admin] email verified: ${user.emailVerifiedAt ? 'yes' : 'no (sign in and enter the emailed code)'}`
  );
  console.log('[admin] sign in at /admin\n');

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('[admin] failed:', error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
