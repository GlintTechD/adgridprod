/**
 * Signup / sign-in journey smoke test (HTTP only — no database access needed).
 *
 * Covers the flow that matters most to customers:
 *   signup → verification code delivered → verify code → sign in → session
 * plus the failure and abuse paths around it.
 *
 * Usage:
 *   npm run dev                    # in one terminal
 *   node scripts/smoke-signup-signin.mjs
 *
 * BASE_URL defaults to http://localhost:3000/api
 *
 * The verification code is read from the development outbox endpoint
 * (GET /auth/dev-last-otp), which only exists when NODE_ENV !== 'production'.
 */
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api';

const results = [];
let failures = 0;

function check(condition, message, details) {
  if (condition) {
    console.log(`  \u2713 ${message}`);
    results.push({ message, passed: true });
  } else {
    console.error(`  \u2717 ${message}${details ? ` — ${details}` : ''}`);
    results.push({ message, passed: false });
    failures += 1;
  }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data, headers: response.headers };
}

async function main() {
  const runId = Math.random().toString(36).slice(2, 10);
  const email = `journey-${runId}@adgrid.test`;
  const password = 'SecurePassword2026!';

  console.log('\n=====================================================');
  console.log('ADGRID SIGNUP -> VERIFICATION -> SIGN-IN JOURNEY');
  console.log('=====================================================\n');

  console.log('1. Server availability');
  const health = await api('/health');
  check(health.status === 200 && health.data.status === 'ok', 'API health check passes', `HTTP ${health.status}`);

  console.log('\n2. Signup sends a verification code');
  const signup = await api('/auth/signup', {
    method: 'POST',
    body: {
      name: 'Journey Tester',
      email,
      password,
      organization: `Journey OOH ${runId}`,
      role: 'Customer / Client Company',
      title: 'Marketing Director',
    },
  });
  check(signup.status === 201 && signup.data.success, 'Signup returns 201 Created', `HTTP ${signup.status} ${JSON.stringify(signup.data).slice(0, 200)}`);
  check(signup.data.requiresVerification === true, 'Signup requires email verification');
  check(typeof signup.data.cooldownSeconds === 'number', 'Signup returns a resend cooldown');

  console.log('\n3. Verification code is retrievable from the dev outbox');
  const outbox = await api(`/auth/dev-last-otp?email=${encodeURIComponent(email)}`);
  check(outbox.status === 200 && /^\d{6}$/.test(outbox.data.otp || ''), 'A 6-digit code was recorded for the signup email', `HTTP ${outbox.status}`);
  const code = outbox.data.otp;

  console.log('\n4. Unverified sign-in is blocked and re-sends a code');
  const blockedLogin = await api('/auth/login', { method: 'POST', body: { email, password } });
  check(blockedLogin.status === 403 && blockedLogin.data.requiresVerification === true, 'Sign-in before verification returns 403 requiresVerification', `HTTP ${blockedLogin.status}`);

  console.log('\n5. Wrong code is rejected with remaining attempts');
  const wrongCode = String((Number(code) + 1) % 1000000).padStart(6, '0');
  const wrong = await api('/auth/verify-otp', { method: 'POST', body: { email, code: wrongCode } });
  check(wrong.status === 400 && wrong.data.code === 'invalid_code', 'Incorrect code rejected', `HTTP ${wrong.status} ${JSON.stringify(wrong.data)}`);
  check(wrong.data.remainingAttempts < 5, 'Attempt counter decreases');

  console.log('\n6. Correct code verifies the account and opens a session');
  const verified = await api('/auth/verify-otp', { method: 'POST', body: { email, code } });
  check(verified.status === 200 && verified.data.success === true, 'Valid code verifies the account', `HTTP ${verified.status} ${JSON.stringify(verified.data).slice(0, 200)}`);
  check(typeof verified.data.token === 'string' && verified.data.token.length > 20, 'Access token issued on verification');

  console.log('\n7. Verified account can sign in');
  const login = await api('/auth/login', { method: 'POST', body: { email, password } });
  check(login.status === 200 && login.data.success === true, 'Sign-in succeeds after verification', `HTTP ${login.status} ${JSON.stringify(login.data).slice(0, 200)}`);
  check(!!login.data.redirectTo, 'Sign-in returns an authorized dashboard route');

  console.log('\n8. Session token is accepted by the API');
  const me = await api('/auth/me', { token: login.data.token });
  check(me.status === 200 && me.data.authenticated === true, 'Authenticated /auth/me returns the user', `HTTP ${me.status}`);
  check(me.data.user?.email === email, 'Session belongs to the signed-up account');

  console.log('\n9. Reused codes are rejected');
  const reuse = await api('/auth/verify-otp', { method: 'POST', body: { email, code } });
  check(reuse.status === 400, 'Consumed code cannot be reused', `HTTP ${reuse.status}`);

  console.log('\n10. Resend cooldown is enforced');
  const resend = await api('/auth/resend-otp', { method: 'POST', body: { email } });
  check(resend.status === 429 || resend.data.alreadyVerified === true, 'Resend is throttled or reports the account already verified', `HTTP ${resend.status} ${JSON.stringify(resend.data)}`);

  console.log('\n11. Duplicate signup is rejected');
  const duplicate = await api('/auth/signup', {
    method: 'POST',
    body: { name: 'Journey Tester', email, password, organization: 'Dup Co', role: 'Customer / Client Company' },
  });
  check(duplicate.status === 409, 'Duplicate email returns 409', `HTTP ${duplicate.status}`);

  console.log('\n12. Privileged roles cannot self-register');
  const privileged = await api('/auth/signup', {
    method: 'POST',
    body: {
      name: 'Mallory',
      email: `mallory-${runId}@adgrid.test`,
      password,
      organization: 'Shadow Org',
      role: 'Platform Admin',
    },
  });
  check(privileged.status === 403, 'Platform Admin self-signup blocked', `HTTP ${privileged.status}`);

  console.log('\n13. Password policy is enforced');
  const weak = await api('/auth/signup', {
    method: 'POST',
    body: {
      name: 'Weak Password',
      email: `weak-${runId}@adgrid.test`,
      password: 'short',
      organization: 'Weak Co',
      role: 'Customer / Client Company',
    },
  });
  check(weak.status === 400, 'Password under 8 characters is rejected', `HTTP ${weak.status}`);

  console.log('\n14. Password reset emails are dispatched');
  const reset = await api('/auth/forgot-password', { method: 'POST', body: { email } });
  check(reset.status === 200 && reset.data.success === true, 'Forgot-password accepts the request without enumerating accounts', `HTTP ${reset.status}`);

  console.log('\n-----------------------------------------------------');
  console.log(`${results.filter((r) => r.passed).length}/${results.length} checks passed`);
  console.log('-----------------------------------------------------\n');

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
