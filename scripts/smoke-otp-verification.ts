import crypto from 'crypto';
// Reuse the application's Prisma client so this suite runs against the same
// database and connection strategy as the server (including the local
// embedded Postgres used by `npm run dev:db`).
import { prisma } from '../server/db';
const BASE_URL = 'http://localhost:3000/api';

const results: { name: string; passed: boolean; details?: string }[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    results.push({ name: message, passed: true });
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    results.push({ name: message, passed: false });
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runOtpVerificationSuite() {
  console.log('\n=====================================================');
  console.log('ADGRID EMAIL 6-DIGIT OTP VERIFICATION TEST SUITE');
  console.log('=====================================================\n');

  const runId = crypto.randomBytes(4).toString('hex');
  const testEmail = `advertiser-${runId}@adgrid.africa`;
  const testPassword = 'SecurePassword2026!';
  const testOrg = `OOH Agency ${runId}`;

  // --------------------------------------------------------------------------
  // TEST 1: REGISTRATION FLOW
  // --------------------------------------------------------------------------
  console.log('1. REGISTRATION FLOW & 6-DIGIT OTP ISSUANCE');

  const regRes = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Adewale Adeleke',
      email: testEmail,
      password: testPassword,
      organization: testOrg,
      role: 'Customer / Client Company',
      title: 'Marketing Director',
    }),
  });

  const regData = await regRes.json();
  assert(regRes.status === 201 && regData.success, 'Registration creates account and returns 201 Created');
  assert(regData.requiresVerification === true, 'Response requires email verification before access');
  assert(regData.cooldownSeconds === 60, 'Response includes 60s resend cooldown');

  // Verify in DB that user is unverified and pending verification
  const createdUser = await prisma.user.findUnique({ where: { email: testEmail } });
  assert(!!createdUser, 'User record created in database');
  assert(createdUser?.emailVerifiedAt === null, 'User emailVerifiedAt is null on creation');
  assert(createdUser?.status === 'PENDING_VERIFICATION', 'User status is PENDING_VERIFICATION');

  // Verify OTP record created in DB
  const otpRecord = await prisma.emailVerificationOtp.findFirst({
    where: { userId: createdUser!.id, email: testEmail, invalidatedAt: null, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  assert(!!otpRecord, '6-digit OTP record stored securely in database');
  assert(otpRecord?.purpose === 'SIGN_UP', 'OTP purpose set to SIGN_UP');
  assert(otpRecord?.failedAttempts === 0, 'Failed attempts initialized to 0');
  assert(otpRecord?.maxAttempts === 5, 'Max attempts limit set to 5');
  assert(!!otpRecord?.expiresAt && otpRecord.expiresAt > new Date(), 'OTP expiration set in the future (~10 minutes)');

  // --------------------------------------------------------------------------
  // TEST 2: SIGN-IN FLOW WITH UNVERIFIED ACCOUNT BLOCKS ACCESS & TRIGGERS OTP
  // --------------------------------------------------------------------------
  console.log('\n2. SIGN-IN FLOW WITH UNVERIFIED ACCOUNT');

  const unverifiedLoginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
    }),
  });

  const unverifiedLoginData = await unverifiedLoginRes.json();
  assert(unverifiedLoginRes.status === 403, 'Sign-in with unverified account is rejected with 403 Forbidden');
  assert(unverifiedLoginData.requiresVerification === true, 'Sign-in response indicates requiresVerification: true');
  assert(unverifiedLoginData.code === 'email_not_verified', 'Sign-in response error code is email_not_verified');

  // --------------------------------------------------------------------------
  // TEST 3: INVALID INPUT & ATTEMPT COUNTER ON OTP VERIFICATION
  // --------------------------------------------------------------------------
  console.log('\n3. OTP VALIDATION RULES, INCORRECT CODES & ATTEMPT LIMITS');

  // Test non-numeric or non-6-digit format
  const badFormatRes = await fetch(`${BASE_URL}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, code: '12ABC' }),
  });
  const badFormatData = await badFormatRes.json();
  assert(badFormatRes.status === 400 && badFormatData.code === 'invalid_format', 'Non-numeric or wrong length OTP rejected with 400 invalid_format');

  // Test incorrect 6-digit code
  const wrongCodeRes = await fetch(`${BASE_URL}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, code: '000000' }),
  });
  const wrongCodeData = await wrongCodeRes.json();
  assert(wrongCodeRes.status === 400 && wrongCodeData.code === 'invalid_code', 'Incorrect OTP code rejected with invalid_code');
  assert(wrongCodeData.remainingAttempts !== undefined, 'Response returns remaining attempts counter');

  // Inspect that failedAttempts incremented in DB
  const updatedOtpRecord = await prisma.emailVerificationOtp.findUnique({ where: { id: otpRecord!.id } });
  assert(updatedOtpRecord?.failedAttempts === 1, 'Database failedAttempts incremented to 1');

  // --------------------------------------------------------------------------
  // TEST 4: RESEND OTP & COOLDOWN ENFORCEMENT
  // --------------------------------------------------------------------------
  console.log('\n4. RESEND OTP & COOLDOWN ENFORCEMENT');

  // Resend immediately -> must trigger cooldown 429
  const immediateResendRes = await fetch(`${BASE_URL}/auth/resend-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail }),
  });
  const immediateResendData = await immediateResendRes.json();
  assert(immediateResendRes.status === 429 && immediateResendData.code === 'cooldown_active', 'Immediate resend rejected with 429 cooldown_active');
  assert(immediateResendData.cooldownSeconds > 0, 'Remaining cooldown seconds returned');

  // --------------------------------------------------------------------------
  // TEST 5: CHANGE DESTINATION EMAIL ADDRESS
  // --------------------------------------------------------------------------
  console.log('\n5. CHANGE DESTINATION EMAIL ADDRESS');

  const updatedTestEmail = `advertiser-updated-${runId}@adgrid.africa`;

  const changeEmailRes = await fetch(`${BASE_URL}/auth/change-verification-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentEmail: testEmail,
      newEmail: updatedTestEmail,
    }),
  });
  const changeEmailData = await changeEmailRes.json();
  assert(changeEmailRes.status === 200 && changeEmailData.success, 'Change destination email succeeds with 200 OK');
  assert(changeEmailData.email === updatedTestEmail, 'Updated email returned in response');

  // Verify that the user record in database now has the updated email
  const userAfterEmailChange = await prisma.user.findUnique({ where: { email: updatedTestEmail } });
  assert(!!userAfterEmailChange && userAfterEmailChange.id === createdUser!.id, 'User record in database updated to new email');

  // Verify that old OTP was invalidated
  const oldOtpInvalidated = await prisma.emailVerificationOtp.findUnique({ where: { id: otpRecord!.id } });
  assert(oldOtpInvalidated?.invalidatedAt !== null, 'Previous OTP code was marked invalidated');

  // Get the newly issued OTP for updatedTestEmail
  const newOtpRecord = await prisma.emailVerificationOtp.findFirst({
    where: { email: updatedTestEmail, invalidatedAt: null, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  assert(!!newOtpRecord, 'Fresh OTP generated and associated with updated email');

  // --------------------------------------------------------------------------
  // TEST 6: SUCCESSFUL OTP VERIFICATION
  // --------------------------------------------------------------------------
  console.log('\n6. SUCCESSFUL OTP VERIFICATION & SESSION ISSUANCE');

  // Find the raw OTP that was sent via the dev inspection endpoint
  const otpRes = await fetch(`${BASE_URL}/auth/dev-last-otp?email=${encodeURIComponent(updatedTestEmail)}`);
  const otpData = await otpRes.json();
  assert(otpRes.status === 200 && !!otpData.otp, 'Sent OTP retrieved from email delivery audit record');
  const validOtp = otpData.otp!;

  // Verify code
  const verifyRes = await fetch(`${BASE_URL}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: updatedTestEmail,
      code: validOtp,
    }),
  });
  const verifyData = await verifyRes.json();
  assert(verifyRes.status === 200 && verifyData.success, 'Valid 6-digit OTP verification returns 200 OK');
  assert(!!verifyData.token, 'Verified authentication session accessToken issued');
  assert(verifyData.user.email === updatedTestEmail, 'Verified user payload returned in response');

  // Verify DB state
  const verifiedUserDb = await prisma.user.findUnique({ where: { id: createdUser!.id } });
  assert(verifiedUserDb?.emailVerifiedAt !== null, 'User emailVerifiedAt timestamp persisted in database');
  assert(verifiedUserDb?.status === 'ACTIVE', 'User status transitioned to ACTIVE');

  const consumedOtpDb = await prisma.emailVerificationOtp.findUnique({ where: { id: newOtpRecord!.id } });
  assert(consumedOtpDb?.consumedAt !== null, 'OTP record marked as consumedAt in database');

  // --------------------------------------------------------------------------
  // TEST 7: RE-USING CONSUMED CODE REJECTED WITH CLEAR MESSAGE
  // --------------------------------------------------------------------------
  console.log('\n7. RE-USING CONSUMED OTP CODE REJECTED');

  const reuseRes = await fetch(`${BASE_URL}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: updatedTestEmail,
      code: validOtp,
    }),
  });
  const reuseData = await reuseRes.json();
  assert(reuseRes.status === 400, 'Reusing consumed OTP rejected with 400 Bad Request');
  assert(reuseData.code === 'code_already_used', 'Error code clearly identifies code_already_used');

  // --------------------------------------------------------------------------
  // TEST 8: VERIFIED USER CAN NOW SIGN IN WITHOUT OTP
  // --------------------------------------------------------------------------
  console.log('\n8. VERIFIED USER SIGNS IN DIRECTLY');

  const directLoginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: updatedTestEmail,
      password: testPassword,
    }),
  });
  const directLoginData = await directLoginRes.json();
  assert(directLoginRes.status === 200 && directLoginData.success, 'Verified user signs in directly without OTP requirement');
  assert(!!directLoginData.token, 'Valid session token issued');
  assert(!directLoginData.requiresVerification, 'No requiresVerification flag on verified login');

  // --------------------------------------------------------------------------
  // TEST 9: UNVERIFIED ACCOUNT BLOCKED FROM PROTECTED APIs & DASHBOARDS
  // --------------------------------------------------------------------------
  console.log('\n9. DIRECT ACCESS CONTROL & MIDDLEWARE ENFORCEMENT');

  // Create an unverified user and sign an unverified token
  const unverifiedUserId = `unv-test-${runId}`;
  const unverifiedUserEmail = `unv-${runId}@adgrid.test`;
  await prisma.user.create({
    data: {
      id: unverifiedUserId,
      email: unverifiedUserEmail,
      name: 'Unverified Hacker',
      passwordHash: 'dummy',
      role: 'Customer / Client Company',
      status: 'PENDING_VERIFICATION',
      emailVerifiedAt: null,
    },
  });

  const { signAccessToken } = await import('../server/auth.ts');
  const forgedToken = signAccessToken({
    id: unverifiedUserId,
    email: unverifiedUserEmail,
    name: 'Unverified Hacker',
    role: 'Customer / Client Company',
    tenantId: null,
    permissions: [],
  });

  // Call validate-access with unverified token
  const validateAccessRes = await fetch(`${BASE_URL}/auth/validate-access`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${forgedToken}`,
    },
    body: JSON.stringify({ targetPath: '/admin/client' }),
  });
  const validateAccessData = await validateAccessRes.json();
  assert(validateAccessRes.status === 403, 'Unverified token blocked from protected workspace with 403 Forbidden');
  assert(validateAccessData.requiresVerification === true, 'validate-access responds with requiresVerification: true');
  assert(validateAccessData.redirectTo.startsWith('/verify-email'), 'validate-access redirects to /verify-email');

  // Call protected resource /api/bookings with unverified token
  const protectedApiRes = await fetch(`${BASE_URL}/bookings`, {
    headers: {
      Authorization: `Bearer ${forgedToken}`,
    },
  });
  const protectedApiData = await protectedApiRes.json();
  assert(protectedApiRes.status === 403, 'Protected API call with unverified token rejected with 403 Forbidden');
  assert(protectedApiData.code === 'email_not_verified', 'Error code is email_not_verified');

  console.log('\n=====================================================');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`OTP TEST SUMMARY: ${passed} Passed, ${failed} Failed out of ${results.length} total tests.`);
  console.log('=====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runOtpVerificationSuite()
  .catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
