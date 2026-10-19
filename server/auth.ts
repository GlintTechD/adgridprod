import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { prisma } from './db';

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'adgrid-dev-access-secret-32-chars-long';
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const APP_URL = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || (IS_PRODUCTION ? '' : 'onboarding@resend.dev');
// Local development aid: lets developers read the code that was emailed instead
// of waiting on an inbox. Never enabled in production.
// Client-safe sentence for every outbound-email failure. The detailed cause
// (provider status, response body, host) is logged and must not be returned:
// signup and resend-code are unauthenticated, so their responses are free to read.
const EMAIL_DELIVERY_PROBLEM =
  'We could not send the verification email just now. You can request another code shortly.';

const DEV_EMAIL_INSPECTION =
  !IS_PRODUCTION && String(process.env.ALLOW_DEV_EMAIL_INSPECTION ?? 'true').toLowerCase() !== 'false';
export interface TokenUserPayload {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string | null;
  permissions: string[];
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function validatePasswordStrength(password: string): boolean {
  return password.length >= 8;
}

export function signAccessToken(user: TokenUserPayload): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      permissions: user.permissions,
    },
    JWT_ACCESS_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL } as any
  );
}

export function verifyAccessToken(token: string): any {
  try {
    return jwt.verify(token, JWT_ACCESS_SECRET);
  } catch {
    return null;
  }
}

export function signMfaToken(userId: string, email: string): string {
  return jwt.sign(
    { sub: userId, email, type: 'mfa_challenge' },
    JWT_ACCESS_SECRET,
    { expiresIn: '5m' } as any
  );
}

export function verifyMfaToken(token: string): { sub: string; email: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_ACCESS_SECRET) as any;
    if (decoded?.type === 'mfa_challenge') {
      return { sub: decoded.sub, email: decoded.email };
    }
    return null;
  } catch {
    return null;
  }
}

export const EXACT_ROLE_DASHBOARD_MAP: Record<string, string> = {
  'Media Owner': '/admin/media-owner',
  'Agency Admin': '/admin/agency',
  'Campaign Manager': '/admin/agency',
  'Operations Manager': '/admin/agency',
  'Account Manager': '/admin/agency',
  'Finance Manager': '/admin/agency',
  'Field Manager': '/admin/agency',
  'Agency Staff': '/admin/agency',
  'Customer / Client Company': '/admin/client',
  'Field Agent': '/admin/field-agent',
  'Vendor': '/admin/vendor',
  'Platform Admin': '/admin/platform',
};

// Map roles to authorized dashboard URLs (Section 12 & 13)
// Strictly returns null for unknown/invalid roles to prevent unauthorized access
export function getAuthorizedDashboardForRole(role: string): string | null {
  if (!role) return null;
  return EXACT_ROLE_DASHBOARD_MAP[role] || null;
}

// Canonical granular permissions per role
export const ROLE_DEFAULT_PERMISSIONS: Record<string, string[]> = {
  'Platform Admin': [
    'platform:superadmin', 'platform.manage', 'governance:all', 'audit:all', 'audit.read',
    'tenants:all', 'security:all', 'users.manage', 'users.read',
    'campaigns:manage', 'operations:manage', 'finance:all', 'inventory:manage', 'billboards:create', 'billboards:export'
  ],
  'Agency Admin': [
    'agency:all', 'campaigns:manage', 'campaign.read', 'campaign.create', 'campaign.update', 'campaign.delete',
    'operations:manage', 'finance:view', 'finance.read', 'verification:approve',
    'clients:manage', 'client.read', 'client.create', 'reports:view',
    'bookings:manage', 'booking.create', 'booking.approve', 'locations:view', 'field-teams:manage', 'jobs:manage',
    'users.invite', 'users.read', 'users.manage'
  ],
  'Campaign Manager': [
    'campaigns:manage', 'campaign.read', 'campaign.create', 'campaign.update',
    'bookings:manage', 'booking.create', 'locations:view', 'reports:view', 'jobs:view'
  ],
  'Operations Manager': [
    'operations:manage', 'field-teams:manage', 'jobs:manage', 'jobs.execute', 'jobs.verify',
    'field-audit:manage', 'locations:view', 'evidence:manage', 'campaigns:view'
  ],
  'Account Manager': [
    'clients:manage', 'client.read', 'client.create', 'client.update',
    'campaigns:manage', 'campaign.read', 'reports:view', 'bookings:view'
  ],
  'Finance Manager': [
    'finance:all', 'finance.read', 'finance.manage', 'invoices:manage', 'settlements:manage', 'reports:view'
  ],
  'Field Manager': [
    'field-audit:manage', 'jobs:verify', 'jobs.verify', 'evidence:manage', 'field-teams:manage'
  ],
  'Agency Staff': [
    'campaigns:view', 'campaign.read', 'jobs:view', 'locations:view'
  ],
  'Customer / Client Company': [
    'client:tracker', 'client:campaigns', 'client.read', 'campaign.read',
    'client:purchase', 'booking.create', 'client:invoices', 'client:evidence', 'reports:view'
  ],
  'Media Owner': [
    'inventory:manage', 'inventory.read', 'inventory.create', 'inventory.update',
    'billboards:create', 'billboards:export', 'bookings:view', 'revenue:view', 'yield:optimize'
  ],
  'Vendor': [
    'jobs:assigned', 'jobs.assigned', 'jobs:update', 'jobs.execute', 'earnings:view', 'evidence:upload'
  ],
  'Field Agent': [
    'mobile-os:access', 'jobs:execute', 'jobs.execute', 'evidence:upload', 'gps:verify'
  ],
};

export async function resolvePermissionsForRole(role: string): Promise<string[]> {
  try {
    const dbPermissions = await prisma.rolePermission.findMany({
      where: { role },
      select: { permission: true },
    });
    if (dbPermissions.length > 0) {
      return dbPermissions.map((p) => p.permission);
    }
  } catch (error) {
    console.error('Failed to load role permissions from DB:', error);
  }
  return ROLE_DEFAULT_PERMISSIONS[role] || ['campaigns:view'];
}

// Database-backed Refresh Token Session management
export async function createRefreshTokenSession(
  userId: string,
  req?: Request
): Promise<string> {
  const rawToken = generateSecureToken(32);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const userAgent = req?.headers['user-agent'] || undefined;
  const ip = (req?.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req?.socket?.remoteAddress || undefined;

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      userAgent,
      ip,
    },
  });

  return rawToken;
}

export async function rotateRefreshTokenSession(
  rawOldToken: string,
  req?: Request
): Promise<{ success: boolean; newRawToken?: string; user?: any; error?: string }> {
  const oldHash = hashToken(rawOldToken);

  const existingRecord = await prisma.refreshToken.findUnique({
    where: { tokenHash: oldHash },
    include: { user: { include: { tenant: true } } },
  });

  if (!existingRecord) {
    return { success: false, error: 'Invalid refresh token.' };
  }

  // Detect replay attack: token already revoked!
  if (existingRecord.revokedAt) {
    // Revoke ALL active sessions for this user to protect compromised account
    await prisma.refreshToken.updateMany({
      where: { userId: existingRecord.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await recordAuditLog({
      actorId: existingRecord.userId,
      action: 'REPLAY_ATTACK_DETECTED',
      entity: 'RefreshToken',
      entityId: existingRecord.id,
      metadata: { reason: 'Revoked refresh token was re-submitted. Revoked all sessions for security.' },
      req,
    });

    return {
      success: false,
      error: 'Security alert: Refresh token has already been used. All sessions have been terminated.',
    };
  }

  // Check expiration
  if (existingRecord.expiresAt < new Date()) {
    return { success: false, error: 'Refresh token has expired.' };
  }

  // Generate new token and rotate
  const newRawToken = generateSecureToken(32);
  const newHash = hashToken(newRawToken);
  const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const userAgent = req?.headers['user-agent'] || existingRecord.userAgent || undefined;
  const ip = (req?.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req?.socket?.remoteAddress || existingRecord.ip || undefined;

  // Revoke old token and create new one in a transaction
  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: existingRecord.id },
      data: {
        revokedAt: new Date(),
        replacedByTokenHash: newHash,
      },
    }),
    prisma.refreshToken.create({
      data: {
        userId: existingRecord.userId,
        tokenHash: newHash,
        expiresAt: newExpiresAt,
        userAgent,
        ip,
      },
    }),
  ]);

  return {
    success: true,
    newRawToken,
    user: existingRecord.user,
  };
}

export async function revokeRefreshTokenSession(rawToken: string, req?: Request): Promise<void> {
  const hash = hashToken(rawToken);
  const session = await prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
  if (session && !session.revokedAt) {
    await prisma.refreshToken.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    await recordAuditLog({
      actorId: session.userId,
      action: 'LOGOUT',
      entity: 'RefreshToken',
      entityId: session.id,
      metadata: { reason: 'User session logged out' },
      req,
    });
  }
}

export async function revokeAllSessionsForUser(userId: string, req?: Request): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await recordAuditLog({
    actorId: userId,
    action: 'LOGOUT_ALL',
    entity: 'User',
    entityId: userId,
    metadata: { reason: 'All user sessions revoked' },
    req,
  });
}

// Audit logging helper
export interface AuditLogParams {
  actorId?: string | null;
  actorRole?: string | null;
  tenantId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, any> | null;
  req?: Request;
}

export async function recordAuditLog(params: AuditLogParams): Promise<void> {
  try {
    const ip = params.req
      ? (params.req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || params.req.socket?.remoteAddress
      : undefined;
    const userAgent = params.req?.headers['user-agent'] || undefined;

    await prisma.auditLog.create({
      data: {
        actorId: params.actorId || undefined,
        actorRole: params.actorRole || undefined,
        tenantId: params.tenantId || undefined,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId || undefined,
        metadata: params.metadata ? JSON.stringify(params.metadata) : undefined,
        ip,
        userAgent,
      },
    });
  } catch (err) {
    console.error('AuditLog error:', err);
  }
}

// In-memory record of sent emails for automated testing and auditing
export interface SentEmailRecord {
  to: string;
  subject: string;
  html: string;
  sentAt: Date;
  /** Development only: the 6-digit code contained in the email, if any. */
  otp?: string;
  /** Resend message id, when the provider accepted the message. */
  providerMessageId?: string;
}
export const sentEmailAuditTrail: SentEmailRecord[] = [];

export interface SendEmailResult {
  success: boolean;
  error?: string;
  /** Machine-readable failure reason so routes can respond precisely. */
  code?: 'email_not_configured' | 'email_rejected_by_provider' | 'email_network_error';
  providerMessageId?: string;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  /** Development aid: the code this email carries, exposed via the dev outbox. */
  otp?: string;
}

const RESEND_RETRY_DELAYS_MS = [400, 1200];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Turn Resend's response into an operator-actionable message.
function describeResendFailure(status: number, details: string): string {
  const trimmed = details.slice(0, 400);
  switch (status) {
    case 401:
      return `Resend rejected the API key (401). Check RESEND_API_KEY. Response: ${trimmed}`;
    case 403:
      return `Resend refused to send (403). The RESEND_FROM_EMAIL domain is most likely not verified for this API key. Response: ${trimmed}`;
    case 422:
      return `Resend rejected the message payload (422). Confirm RESEND_FROM_EMAIL is a valid sender such as "ADGRID <no-reply@your-domain.com>". Response: ${trimmed}`;
    case 429:
      return `Resend rate limited this send (429). Response: ${trimmed}`;
    default:
      if (status >= 500) {
        return `Resend is unavailable (${status}). Response: ${trimmed}`;
      }
      return `Resend error (${status}): ${trimmed}`;
  }
}

/**
 * Send a transactional email through Resend.
 *
 * Failures are reported precisely (never a bare "fetch failed") so that routes
 * and operators can tell an unverified sending domain apart from a transient
 * provider outage. Transient failures are retried with a short backoff.
 */
export async function sendEmail({ to, subject, html, otp }: SendEmailParams): Promise<SendEmailResult> {
  if (!RESEND_API_KEY) {
    if (IS_PRODUCTION) {
      const error =
        'Email delivery is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL to send transactional email.';
      console.error('[Email Service]', error);
      return { success: false, error, code: 'email_not_configured' };
    }
    console.log(`[Email Service - dev mode] Email queued to ${to}: ${subject}`);
    sentEmailAuditTrail.push({ to, subject, html, sentAt: new Date(), otp });
    return { success: true };
  }

  if (!RESEND_FROM_EMAIL) {
    const error =
      'Email delivery is not configured. Set RESEND_FROM_EMAIL to a sender on a domain verified in Resend.';
    console.error('[Email Service]', error);
    return { success: false, error, code: 'email_not_configured' };  }

  let lastError = 'Email delivery failed.';

  for (let attempt = 0; attempt <= RESEND_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [to], subject, html }),
      });

      if (response.ok) {
        const payload: any = await response.json().catch(() => null);
        const providerMessageId = payload?.id;
        sentEmailAuditTrail.push({
          to,
          subject,
          html,
          sentAt: new Date(),
          otp,
          providerMessageId,
        });
        console.log(
          `[Email Service] Sent "${subject}" to ${to}${providerMessageId ? ` (resend id ${providerMessageId})` : ''}`
        );
        return { success: true, providerMessageId };
      }

      const details = await response.text().catch(() => '');
      lastError = describeResendFailure(response.status, details);

      // In non-production environments, fall back to the dev outbox when the
      // shared onboarding@resend.dev sender is rejected (403) because the
      // recipient is not the Resend account owner. This allows local signup to
      // complete without a verified domain — the OTP appears in server logs.
      if (!IS_PRODUCTION && response.status === 403) {
        console.warn(`[Email Service] Resend refused (403) in dev mode — falling back to dev outbox for ${to}: ${details}`);
        if (otp) {
          console.log(`[Email Service - dev mode] Verification code for ${to}: ${otp} (valid for 10 minutes)`);
        }
        sentEmailAuditTrail.push({ to, subject, html, sentAt: new Date(), otp });
        return { success: true };
      }

      // Only provider-side hiccups are worth retrying; auth/payload errors are not.
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === RESEND_RETRY_DELAYS_MS.length) {
        console.error(`[Email Service] Failed to send "${subject}" to ${to}: ${lastError}`);
        return { success: false, error: EMAIL_DELIVERY_PROBLEM, code: 'email_rejected_by_provider' };
      }
    } catch (error: any) {
      const reason = error?.cause?.code || error?.code || error?.cause?.message;
      lastError = `Could not reach Resend${reason ? ` (${reason})` : ''}. Check that the server has outbound access to ${RESEND_API_URL}.`;
      if (attempt === RESEND_RETRY_DELAYS_MS.length) {
        console.error(`[Email Service] Failed to send "${subject}" to ${to}: ${lastError}`);
        return { success: false, error: EMAIL_DELIVERY_PROBLEM, code: 'email_network_error' };
      }
    }

    await sleep(RESEND_RETRY_DELAYS_MS[attempt]);  }

  console.error(`[Email Service] Failed to send "${subject}" to ${to}: ${lastError}`);
  return { success: false, error: EMAIL_DELIVERY_PROBLEM, code: 'email_network_error' };
}

/**
 * Development-only outbox lookup: returns the most recent code emailed to an
 * address so local signup/sign-in can be completed without an inbox. Always
 * empty in production.
 */
export function getLatestDevOtp(email: string): SentEmailRecord | null {
  if (!DEV_EMAIL_INSPECTION) return null;
  const normalized = String(email || '').trim().toLowerCase();
  const records = sentEmailAuditTrail.filter(
    (record) => record.to.trim().toLowerCase() === normalized && !!record.otp
  );
  return records.length > 0 ? records[records.length - 1] : null;
}

export const isDevEmailInspectionEnabled = () => DEV_EMAIL_INSPECTION;
export const isEmailDeliveryConfigured = () => Boolean(RESEND_API_KEY && RESEND_FROM_EMAIL);

/**
 * Non-secret view of the email configuration, for deployment verification.
 * Never returns the API key - only whether it is present and where mail is sent from.
 */
export function emailDiagnostics() {
  const fromMatch = RESEND_FROM_EMAIL.match(/<([^>]+)>/);
  const fromAddress = (fromMatch ? fromMatch[1] : RESEND_FROM_EMAIL).trim();

  return {
    provider: 'resend',
    apiUrl: RESEND_API_URL,
    configured: isEmailDeliveryConfigured(),
    apiKeyPresent: Boolean(RESEND_API_KEY),
    fromAddress: fromAddress || null,
    fromDomain: fromAddress.includes('@') ? fromAddress.split('@')[1] : null,
    // onboarding@resend.dev only delivers to the Resend account owner's inbox.
    usingSharedTestSender: fromAddress.endsWith('@resend.dev'),
    devOutboxEnabled: DEV_EMAIL_INSPECTION,
    retries: RESEND_RETRY_DELAYS_MS.length,
  };
}

/** Send a real email through the configured provider so operators can verify delivery. */
export async function sendTestEmail(to: string) {
  const subject = 'ADGRID production email check';
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1c1a;">
      <h2 style="color:#ef5a24;margin:0 0 8px;">ADGRID email delivery is working</h2>
      <p style="font-size:14px;line-height:1.6;">
        This message was sent from your deployed ADGRID environment through Resend at
        ${new Date().toISOString()}.
      </p>
      <p style="font-size:14px;line-height:1.6;">
        If you are reading it, verification codes, password resets and invitation emails
        will reach your users.
      </p>
    </div>
  `;

  return sendEmail({ to, subject, html });
}

// Cryptographically secure 6-digit numeric OTP generator (preserves leading zeros)
export function generateSecureOtp(): string {
  const num = crypto.randomInt(0, 1000000);
  return num.toString().padStart(6, '0');
}

// Deterministic cryptographic hash of OTP
export function hashOtp(otp: string): string {
  return crypto.createHmac('sha256', JWT_ACCESS_SECRET).update(`adgrid-otp:${otp}`).digest('hex');
}

export const OTP_EXPIRATION_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_COOLDOWN_MS = 60 * 1000; // 60 seconds
export const OTP_MAX_ATTEMPTS = 5;

// 6-digit OTP email template conforming to Section 5 requirements
export async function sendOtpEmail(email: string, name: string, otp: string): Promise<SendEmailResult> {
  const subject = 'Verify your ADGRID email address';
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verify your ADGRID email address</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #faf9f6; margin: 0; padding: 24px; color: #1a1c1a;">
      <table width="100%" border="0" cellspacing="0" cellpadding="0">
        <tr>
          <td align="center">
            <div style="max-width: 520px; background: #ffffff; border-radius: 16px; border: 1px solid #eae7e1; padding: 36px 32px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04); text-align: left;">
              <div style="margin-bottom: 24px; text-align: center;">
                <div style="display: inline-block; font-size: 26px; font-weight: 800; color: #ef5a24; letter-spacing: -0.03em;">ADGRID</div>
                <div style="font-size: 11px; text-transform: uppercase; color: #71717a; letter-spacing: 0.1em; margin-top: 3px;">Out-of-Home Infrastructure</div>
              </div>
              <h1 style="font-size: 20px; font-weight: 700; color: #181716; margin-bottom: 12px; text-align: center;">Verify your ADGRID email address</h1>
              <p style="font-size: 14px; line-height: 1.6; color: #4b5563; margin-bottom: 20px;">
                Hello${name ? ' ' + name.split(' ')[0] : ''},<br><br>
                Thank you for joining ADGRID.
              </p>
              <p style="font-size: 14px; line-height: 1.6; color: #4b5563; margin-bottom: 16px;">
                Your email verification code is:
              </p>
              
              <div style="background-color: #f4f3f0; border: 1.5px dashed #ef5a24; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0;">
                <div style="font-family: 'Courier New', Courier, monospace; font-size: 38px; font-weight: 800; letter-spacing: 10px; color: #181716; padding-left: 10px;">${otp}</div>
                <div style="font-size: 12px; font-weight: 600; color: #71717a; margin-top: 8px;">Single-use verification code</div>
              </div>

              <p style="font-size: 13px; line-height: 1.6; color: #4b5563; margin-bottom: 20px;">
                This code expires in 10 minutes. Enter it on the ADGRID verification page to verify your email address.
              </p>
              <p style="font-size: 12px; line-height: 1.5; color: #6b7280; border-top: 1px solid #f4f3f0; padding-top: 16px; margin-top: 24px;">
                If you did not request this code, you can safely ignore this email.<br><br>
                <strong>The ADGRID Team</strong>
              </p>
            </div>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const result = await sendEmail({ to: email, subject, html, otp });

  // Without a provider configured, local development would have no way to read
  // the code. Surface it in the terminal (never in production).
  if (!IS_PRODUCTION && !isEmailDeliveryConfigured() && result.success) {
    console.log(
      `[Email Service - dev mode] Verification code for ${email}: ${otp} (valid for 10 minutes)`
    );
  }

  return result;
}

export async function createAndSendVerificationOtp(
  user: { id: string; email: string; name: string },
  purpose: 'SIGN_UP' | 'SIGN_IN' | 'EMAIL_VERIFICATION' = 'SIGN_UP',
  forceBypassCooldown = false
): Promise<{ success: boolean; message?: string; cooldownSeconds?: number; error?: string; code?: string }> {
  const normalizedEmail = user.email.trim().toLowerCase();

  // Check resend cooldown (60 seconds)
  if (!forceBypassCooldown) {
    const recentActiveOtp = await prisma.emailVerificationOtp.findFirst({
      where: {
        userId: user.id,
        email: normalizedEmail,
        invalidatedAt: null,
        consumedAt: null,
        createdAt: { gte: new Date(Date.now() - OTP_COOLDOWN_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (recentActiveOtp) {
      const elapsedMs = Date.now() - recentActiveOtp.createdAt.getTime();
      const remainingSec = Math.max(1, Math.ceil((OTP_COOLDOWN_MS - elapsedMs) / 1000));
      return {
        success: false,
        error: `Please wait ${remainingSec} second${remainingSec === 1 ? '' : 's'} before requesting a new verification code.`,
        code: 'cooldown_active',
        cooldownSeconds: remainingSec,
      };
    }
  }

  // Invalidate any existing unused OTPs for this user and email
  await prisma.emailVerificationOtp.updateMany({
    where: {
      userId: user.id,
      email: normalizedEmail,
      invalidatedAt: null,
      consumedAt: null,
    },
    data: {
      invalidatedAt: new Date(),
    },
  });

  // Generate 6-digit numeric OTP
  const rawOtp = generateSecureOtp();
  const otpHash = hashOtp(rawOtp);
  const expiresAt = new Date(Date.now() + OTP_EXPIRATION_MS);

  // Store hashed OTP in database
  const otpRecord = await prisma.emailVerificationOtp.create({
    data: {
      userId: user.id,
      email: normalizedEmail,
      otpHash,
      purpose,
      expiresAt,
      failedAttempts: 0,
      maxAttempts: OTP_MAX_ATTEMPTS,
    },
  });

  // Deliver email through Resend (or local audit log if in test/mock mode)
  const emailResult = await sendOtpEmail(normalizedEmail, user.name, rawOtp);
  if (!emailResult.success) {
    await prisma.emailVerificationOtp.update({
      where: { id: otpRecord.id },
      data: { invalidatedAt: new Date() },
    });
    return {
      success: false,
      // The code carries the classification for callers; the provider's own words
      // are for the log line above, never for a client.
      error: EMAIL_DELIVERY_PROBLEM,
      code: emailResult.code || 'email_delivery_failed',
    };
  }

  return {
    success: true,
    message: 'A 6-digit verification code has been sent to your email address.',
    cooldownSeconds: 60,
  };
}

export async function verifyOtpCode(
  email: string,
  rawOtp: string,
  _purpose?: string
): Promise<{
  success: boolean;
  user?: any;
  error?: string;
  code?: string;
  remainingAttempts?: number;
}> {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const sanitizedOtp = String(rawOtp || '').trim();

  if (!/^\d{6}$/.test(sanitizedOtp)) {
    return {
      success: false,
      error: 'Please enter a valid 6-digit numeric verification code.',
      code: 'invalid_format',
    };
  }

  const computedHash = hashOtp(sanitizedOtp);

  // Find the active OTP for this email
  const activeOtp = await prisma.emailVerificationOtp.findFirst({
    where: {
      email: normalizedEmail,
      invalidatedAt: null,
      consumedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    include: { user: { include: { tenant: true } } },
  });

  if (!activeOtp) {
    // Check if this exact code was already used / consumed
    const consumedOtp = await prisma.emailVerificationOtp.findFirst({
      where: {
        email: normalizedEmail,
        consumedAt: { not: null },
        otpHash: computedHash,
      },
    });
    if (consumedOtp) {
      return {
        success: false,
        error: 'This verification code has already been used. Please sign in or request a new code.',
        code: 'code_already_used',
      };
    }

    // Check if this code was invalidated (replaced or attempts exceeded)
    const invalidatedOtp = await prisma.emailVerificationOtp.findFirst({
      where: {
        email: normalizedEmail,
        invalidatedAt: { not: null },
        otpHash: computedHash,
      },
    });
    if (invalidatedOtp) {
      return {
        success: false,
        error: 'This verification code has been invalidated because a newer code was requested or attempts were exceeded. Please use the most recent code.',
        code: 'code_invalidated',
      };
    }

    return {
      success: false,
      error: 'No active verification code found for this email address. Please request a new code.',
      code: 'no_active_code',
    };
  }

  // Check if expired
  if (activeOtp.expiresAt < new Date()) {
    await prisma.emailVerificationOtp.update({
      where: { id: activeOtp.id },
      data: { invalidatedAt: new Date() },
    });
    return {
      success: false,
      error: 'This verification code has expired. Please request a new one.',
      code: 'code_expired',
    };
  }

  // Check if max attempts already exceeded
  if (activeOtp.failedAttempts >= activeOtp.maxAttempts) {
    await prisma.emailVerificationOtp.update({
      where: { id: activeOtp.id },
      data: { invalidatedAt: new Date() },
    });
    return {
      success: false,
      error: 'Maximum attempts exceeded. This verification code has been invalidated. Please request a new code.',
      code: 'max_attempts_exceeded',
      remainingAttempts: 0,
    };
  }

  // Compare cryptographic hash
  if (computedHash !== activeOtp.otpHash) {
    const updated = await prisma.emailVerificationOtp.update({
      where: { id: activeOtp.id },
      data: { failedAttempts: { increment: 1 } },
    });

    const remaining = Math.max(0, activeOtp.maxAttempts - updated.failedAttempts);

    if (remaining <= 0) {
      await prisma.emailVerificationOtp.update({
        where: { id: activeOtp.id },
        data: { invalidatedAt: new Date() },
      });
      return {
        success: false,
        error: 'Maximum attempts exceeded. This verification code has been invalidated. Please request a new code.',
        code: 'max_attempts_exceeded',
        remainingAttempts: 0,
      };
    }

    return {
      success: false,
      error: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      code: 'invalid_code',
      remainingAttempts: remaining,
    };
  }

  // Match! Atomic consumption and user verification
  const verification = await prisma.$transaction(async (tx) => {
    // Conditional consumption makes concurrent verification requests single-use.
    const consumed = await tx.emailVerificationOtp.updateMany({
      where: {
        id: activeOtp.id,
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    if (consumed.count !== 1) return null;

    return tx.user.update({
      where: { id: activeOtp.userId },
      data: {
        emailVerifiedAt: new Date(),
        status: activeOtp.user.status === 'PENDING_VERIFICATION' ? 'ACTIVE' : activeOtp.user.status,
      },
      include: { tenant: true },
    });
  });

  if (!verification) {
    return {
      success: false,
      error: 'This verification code has already been used. Please request a new code.',
      code: 'code_already_used',
    };
  }

  return {
    success: true,
    user: verification,
  };
}

export async function sendVerificationEmail(email: string, rawToken: string) {
  const link = `${APP_URL}/verify-email?token=${encodeURIComponent(rawToken)}`;
  await sendEmail({
    to: email,
    subject: 'Verify your ADGRID Cloud email',
    html: `
      <h2>Welcome to ADGRID Cloud</h2>
      <p>Please click the link below to verify your corporate email address:</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#ef5a24;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Verify Email Address</a></p>
      <p>Or copy and paste this link: ${link}</p>
      <p>This verification link will expire in 24 hours.</p>
    `,
  });}

export async function sendPasswordResetEmail(email: string, rawToken: string) {
  const link = `${APP_URL}/reset-password?token=${encodeURIComponent(rawToken)}`;
  await sendEmail({
    to: email,
    subject: 'Reset your ADGRID Cloud password',
    html: `
      <h2>ADGRID Cloud Password Reset</h2>
      <p>A password reset was requested for your account. Click the link below to set a new password:</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#ef5a24;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Reset Password</a></p>
      <p>Or copy and paste this link: ${link}</p>
      <p>This link expires in 1 hour and can only be used once.</p>
    `,
  });
}

export async function sendInvitationEmail(email: string, tenantName: string, role: string, rawToken: string) {
  const link = `${APP_URL}/accept-invitation?token=${encodeURIComponent(rawToken)}`;
  await sendEmail({
    to: email,
    subject: `You have been invited to join ${tenantName} on ADGRID`,
    html: `
      <h2>ADGRID Organization Invitation</h2>
      <p>You have been invited to join <strong>${tenantName}</strong> as a <strong>${role}</strong>.</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#ef5a24;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Accept Invitation</a></p>
      <p>Or paste this link into your browser: ${link}</p>
      <p>This invitation link expires in 7 days.</p>
    `,
  });
}

export async function sendAgencyApprovalEmail(email: string, agencyName: string, approved: boolean) {
  const loginLink = `${APP_URL}/agency/login`;
  await sendEmail({
    to: email,
    subject: approved
      ? `Your Marketing Agency application for ${agencyName} has been approved`
      : `Update regarding your Marketing Agency application for ${agencyName}`,
    html: approved
      ? `
        <h2>Agency Application Approved</h2>
        <p>Your Marketing Agency registration for <strong>${agencyName}</strong> has been approved by the Media Owner network.</p>
        <p>You may now sign in to your Agency Workspace:</p>
        <p><a href="${loginLink}" style="display:inline-block;padding:10px 18px;background:#ef5a24;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Sign In to Agency Workspace</a></p>
        <p>Or visit: ${loginLink}</p>
      `
      : `
        <h2>Agency Application Update</h2>
        <p>Your application for <strong>${agencyName}</strong> was not approved by the media concessionaire network.</p>
        <p>If you have questions, please contact platform operations.</p>
      `,
  });
}

// MFA Helpers
export function generateMfaSecret(email: string) {
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(email, 'ADGRID', secret);
  return { secret, otpauth };
}

export async function generateQrCode(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl);
}

export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(4).toString('hex').toUpperCase()
  );
}
