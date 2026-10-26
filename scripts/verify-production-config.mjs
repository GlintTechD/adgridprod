/**
 * Verify a deployed ADGRID environment is correctly configured for production.
 *
 * Run this straight after a deploy, and again after changing Resend or Neon
 * settings. It reads /api/health and /api/health/config (no secrets are exposed)
 * and reports exactly what still needs attention.
 *
 * Usage:
 *   node scripts/verify-production-config.mjs --url https://app.adgrids.com
 *   npm run verify:prod -- --url https://app.adgrids.com
 *
 * Add --strict to also fail on warnings (recommended in CI or before launch).
 */
const args = process.argv.slice(2);
const urlFlagIndex = args.indexOf('--url');
const BASE_URL = (urlFlagIndex !== -1 ? args[urlFlagIndex + 1] : process.env.APP_URL)?.replace(/\/+$/, '');
const STRICT = args.includes('--strict');

const results = [];
let failures = 0;
let warnings = 0;

function report(level, message, detail) {
  const icon = level === 'pass' ? '\u2713' : level === 'warn' ? '!' : level === 'info' ? '\u2022' : '\u2717';
  const line = `  ${icon} ${message}${detail ? ` — ${detail}` : ''}`;
  if (level === 'fail') {
    console.error(line);
    failures += 1;
  } else if (level === 'warn') {
    console.warn(line);
    warnings += 1;
  } else {
    console.log(line);
  }
  results.push({ level, message });
}

async function getJson(path) {
  const response = await fetch(`${BASE_URL}${path}`);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: response.status, data };
}

async function main() {
  if (!BASE_URL) {
    console.error('Provide the deployment URL: --url https://your-domain  (or set APP_URL)');
    process.exit(1);
  }

  console.log(`\n=====================================================`);
  console.log(`ADGRID PRODUCTION CONFIGURATION CHECK`);
  console.log(`${BASE_URL}`);
  console.log(`=====================================================\n`);

  console.log('1. Application and database');
  let health;
  try {
    health = await getJson('/api/health');
  } catch (error) {
    // A DNS/network failure on this machine looks identical to an outage, so say
    // both possibilities and the fastest way to tell them apart.
    const cause = error?.cause?.code || error?.cause?.message || error.message;
    report('fail', `Could not reach ${BASE_URL}`, cause);
    console.error(
      '\n  The URL is either down, or this machine cannot reach it. Check from a\n' +
        '  browser first:\n' +
        `    ${BASE_URL}/api/health   should answer {"status":"ok","db":"connected",...}\n`
    );
    process.exit(1);
  }

  report(health.status === 200 && health.data.status === 'ok' ? 'pass' : 'fail', 'Health endpoint responds', `HTTP ${health.status}`);
  report(
    health.data.db === 'connected' ? 'pass' : 'fail',
    'Database connection works',
    health.data.db === 'connected'
      ? health.data.users === undefined
        ? 'connected (row counts are withheld on production endpoints)'
        : `${health.data.users} users`
      // The API reports a curated cause only; the wording of the failure itself is
      // kept in the runtime log so it cannot be read by anyone else.
      : `${health.data.reason || 'error'} - read the full cause with: vercel inspect <deployment-url> --logs`
  );

  console.log('\n2. Configuration report');
  const config = await getJson('/api/health/config');
  if (config.status !== 200) {
    report('fail', '/api/health/config unavailable', `HTTP ${config.status} - deploy the latest build`);
    process.exit(1);
  }

  const { email, supabaseAuth, environment, appUrl, database } = config.data;

  report(environment === 'production' ? 'pass' : 'warn', 'Build runs in production mode', `NODE_ENV=${environment}`);
  report(appUrl ? 'pass' : 'fail', 'Public app URL is configured', appUrl || 'set APP_URL');
  report(
    ['NEON_DATABASE_URL', 'DATABASE_URL'].includes(database?.mode) ? 'pass' : 'warn',
    'Database driver',
    `${database?.mode}${database?.mode === 'pg driver adapter' ? ' (development-only switch is on!)' : ''}`
  );

  console.log('\n2b. What this deployment says about itself');
  const demo = await getJson('/api/auth/demo-config');
  report(
    demo.data?.enabled === false ? 'pass' : 'fail',
    'Demo accounts are off here',
    demo.data?.enabled
      ? 'DEMO_AUTH_ENABLED is set: every demo login shares a published password - remove it and redeploy'
      : `HTTP ${demo.status} - demo-config should answer { "enabled": false }`
  );
  report(
    demo.data?.sharedPasswordHint == null ? 'pass' : 'fail',
    'Shared demo password is not published to clients',
    demo.data?.sharedPasswordHint ? 'the sign-in screen is being handed the demo password' : undefined
  );
  report(
    health.data?.users === undefined ? 'pass' : 'warn',
    'Health endpoint leaks no row counts',
    health.data?.users !== undefined ? `users=${health.data.users} is readable by anyone` : undefined
  );

  console.log('\n3. Transactional email (Resend)');
  report(email.configured ? 'pass' : 'fail', 'Resend API key and sender are set', email.configured ? undefined : 'set RESEND_API_KEY and RESEND_FROM_EMAIL');
  report(!!email.fromDomain ? 'pass' : 'fail', 'Sender address has a domain', email.fromAddress || 'unset');
  report(
    email.usingSharedTestSender ? 'fail' : 'pass',
    'Sender is not the shared onboarding@resend.dev address',
    email.usingSharedTestSender ? 'verify your own domain in Resend' : undefined
  );
  report(
    email.devOutboxEnabled ? 'fail' : 'pass',
    'Development verification-code outbox is disabled',
    email.devOutboxEnabled ? '/api/auth/dev-last-otp is readable - never expose this' : undefined
  );

  console.log('\n4. Social sign-in (optional, off by default)');
  if (!supabaseAuth.enabled) {
    // Not a warning: the supported sign-in flow is email + code, which needs only
    // Resend and the database. Social sign-in is opt-in via SUPABASE_URL.
    report('info', 'Social sign-in is disabled', 'email + verification code is the active sign-in flow');
  } else {
    report('info', 'Social sign-in is enabled');
    report(
      supabaseAuth.anonKeyPresent ? 'pass' : 'warn',
      'Publishable key present (enables live session checks)',
      supabaseAuth.anonKeyPresent ? undefined : 'set SUPABASE_ANON_KEY'
    );
    report(
      supabaseAuth.redirectUrl?.startsWith('http') ? 'pass' : 'warn',
      'OAuth callback URL',
      supabaseAuth.redirectUrl
    );
    report(
      supabaseAuth.autoProvision === 'none' ? 'pass' : 'warn',
      'Account provisioning policy',
      supabaseAuth.autoProvision === 'none'
        ? 'unknown emails must register first'
        : `auto-provisioning ${supabaseAuth.autoProvision} accounts for unknown emails`
    );
  }

  console.log('\n5. Reported warnings from the deployment');
  if (Array.isArray(config.data.warnings) && config.data.warnings.length > 0) {
    for (const warning of config.data.warnings) {
      report('warn', warning);
    }
  } else {
    report('pass', 'No configuration warnings reported');
  }

  console.log('\n6. Manual checks this script cannot perform');
  console.log('  • Sign up at /admin with a real address and confirm the 6-digit code arrives');
  console.log('  • Confirm the Resend dashboard shows that message as delivered');
  console.log('  • Use the wrong code 5x and confirm the lockout behaves');
  console.log('  • Reset a password end to end (link must point at this domain)');

  console.log('\n-----------------------------------------------------');
  console.log(`failures: ${failures} | warnings: ${warnings}`);
  console.log('-----------------------------------------------------\n');

  if (failures > 0 || (STRICT && warnings > 0)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Verification crashed:', error.message);
  process.exit(1);
});
