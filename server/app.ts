import 'dotenv/config';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';

import { prisma } from './db';
import {
  authenticateRequest,
  forwardAsyncErrors,
  GENERIC_SERVER_ERROR_MESSAGE,
  requireAuth,
  requirePermission,
  requireRole,
  requireTenant,
} from './middleware';
import {
  createRefreshTokenSession,
  createAndSendVerificationOtp,
  emailDiagnostics,
  generateBackupCodes,
  generateMfaSecret,
  generateQrCode,
  generateSecureToken,
  getAuthorizedDashboardForRole,
  getLatestDevOtp,
  hashPassword,
  hashToken,
  isDevEmailInspectionEnabled,
  isEmailDeliveryConfigured,
  recordAuditLog,
  revokeAllSessionsForUser,
  revokeRefreshTokenSession,
  rotateRefreshTokenSession,
  sendInvitationEmail,
  sendPasswordResetEmail,
  sendTestEmail,
  sendVerificationEmail,
  signAccessToken,
  signMfaToken,
  validatePasswordStrength,
  verifyMfaToken,
  verifyOtpCode,
  verifyPassword,
} from './auth';
import { authenticator } from 'otplib';
import { workspaceRouter } from './workspaces';
import { subscriptionsRouter } from './subscriptions';
import {
  ensureDemoAccountsProvisioned,
  getDemoConfigPayload,
  isDemoAuthEnabled,
  isDemoEmail,
  mayWriteDemoData,
  SHARED_DEMO_PASSWORD,
} from './demoProvisioning';


/**
 * A rejected promise nobody handles terminates the Node process, and most route
 * handlers below are `async` without a try/catch. Without these guards a single
 * database error therefore does not just fail one request: it kills the instance,
 * and on serverless every concurrent and subsequent invocation reports the same
 * generic FUNCTION_INVOCATION_FAILED — including routes that never touch the
 * database (GET /api, /api/health), which makes an outage undiagnosable from the
 * outside. Log the real cause instead, keep the instance serving traffic, and let
 * the next request retry. Standalone deployments are supervised by a process
 * manager and can treat these lines as the restart signal.
 */
process.on('unhandledRejection', (reason: any) => {
  console.error(
    '[ADGRID UnhandledRejection]',
    `${reason?.code ? `${reason.code}: ` : ''}${reason?.message || reason}`,
    reason?.stack ? `\n${reason.stack}` : ''
  );
});

process.on('uncaughtException', (error: any) => {
  console.error(
    '[ADGRID UncaughtException]',
    `${error?.code ? `${error.code}: ` : ''}${error?.message || error}`,
    error?.stack ? `\n${error.stack}` : ''
  );
});

// Idempotently ensure demo accounts are provisioned if demo auth is enabled
if (isDemoAuthEnabled()) {
  ensureDemoAccountsProvisioned().catch((err) => {
    console.warn('[Demo Provisioning] Startup initialization deferred:', err);
  });
}

const app = express();
// Must run before any route is attached, so a rejected async handler reaches the
// error middleware instead of hanging the request and killing the process.
forwardAsyncErrors(app);
app.set('trust proxy', 1);

// Port is configurable so extra instances (production-mode checks, tests) can
// run alongside the default dev server.
const PORT = Number(process.env.PORT || 3000);
const API_PREFIX = '/api';

/**
 * Real production: Vercel's production environment, or a production build that is
 * not a Vercel preview. Public endpoints describe less about the system here than
 * anywhere else, because this is the deployment an outsider can query.
 */
const IS_LIVE_PRODUCTION =
  process.env.VERCEL_ENV === 'production' ||
  (process.env.VERCEL === undefined && process.env.NODE_ENV === 'production');

// Dev-only shortcut: set SKIP_EMAIL_VERIFICATION=true in .env to auto-verify
// accounts on signup and skip the OTP gate entirely. Blocked in production.
const SKIP_EMAIL_VERIFICATION =
  !IS_LIVE_PRODUCTION && String(process.env.SKIP_EMAIL_VERIFICATION).toLowerCase() === 'true';

const IS_SERVERLESS =
  process.env.VERCEL === '1' ||
  process.env.VERCEL_ENV !== undefined ||
  process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;

// Rate limiters
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.', code: 'rate_limited' },
  skipSuccessfulRequests: false,
  validate: {
    xForwardedForHeader: false,
    default: false,
  },
});

const strictRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sensitive requests. Please wait a few minutes.', code: 'rate_limited' },
  skipSuccessfulRequests: false,
  validate: {
    xForwardedForHeader: false,
    default: false,
  },
});

// Verification-code attempts: generous enough for genuine users fumbling a
// code, tight enough to stop guessing. 6-digit codes also expire and allow a
// maximum of 5 wrong attempts each, so this is the outer bound.
const otpVerifyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please request a new code later.', code: 'rate_limited' },
  skipSuccessfulRequests: false,
  validate: { xForwardedForHeader: false, default: false },
});

// Middleware setup
if (process.env.NODE_ENV === 'production') {
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
      frameguard: false,
    })
  );
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (
        origin.includes('localhost') ||
        origin.includes('vercel.app') ||
        (process.env.APP_URL && origin === process.env.APP_URL) ||
        (process.env.VERCEL_URL && (origin === `https://${process.env.VERCEL_URL}` || origin === `http://${process.env.VERCEL_URL}`))
      ) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// Normalize route paths in case serverless gateway strips or rewrites /api prefix (Vercel runtime only)
if (IS_SERVERLESS) {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const forwardedUri = (req.headers['x-forwarded-uri'] || req.headers['x-original-url']) as string | undefined;
    const matchedPath = (req.headers['x-matched-path'] || req.headers['x-invoke-path']) as string | undefined;
    const incoming = req as Request & { query?: Record<string, any> };

    const rawUrl = req.url || '/';
    const isFunctionFileTarget =
      rawUrl.startsWith('/api/index') ||
      rawUrl.startsWith('/api/[...path]') ||
      rawUrl === '/api' ||
      rawUrl === '/api/' ||
      rawUrl === '/' ||
      rawUrl.startsWith('/?');

    if (isFunctionFileTarget) {
      if (forwardedUri && forwardedUri.startsWith('/api')) {
        req.url = forwardedUri;
      } else if (matchedPath && matchedPath.startsWith('/api')) {
        const qIdx = rawUrl.indexOf('?');
        const queryStr = qIdx !== -1 ? rawUrl.slice(qIdx) : '';
        req.url = `${matchedPath}${queryStr}`;
      } else if (incoming.query?.path) {
        const subPath = Array.isArray(incoming.query.path) ? incoming.query.path.join('/') : incoming.query.path;
        const qIdx = rawUrl.indexOf('?');
        const queryStr = qIdx !== -1 ? rawUrl.slice(qIdx) : '';
        req.url = `/api/${subPath}${queryStr}`;
      } else if (forwardedUri) {
        req.url = forwardedUri.startsWith('/') ? `/api${forwardedUri}` : `/api/${forwardedUri}`;
      } else if (matchedPath) {
        req.url = matchedPath.startsWith('/') ? `/api${matchedPath}` : `/api/${matchedPath}`;
      }
    } else if (!req.url.startsWith('/api')) {
      req.url = `/api${req.url.startsWith('/') ? req.url : `/${req.url}`}`;
    }
    next();
  });
}

// Attach authenticated session context to every request
app.use(authenticateRequest);

// Mount role-specific workspace API routes
app.use(API_PREFIX, workspaceRouter);
app.use(`${API_PREFIX}/subscriptions`, subscriptionsRouter);

// Root API status endpoint for deployment checks
app.get([API_PREFIX, `${API_PREFIX}/`], (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    name: 'ADGRID Platform API',
    runtime: process.env.VERCEL ? 'vercel-serverless' : 'node-express',
    timestamp: new Date().toISOString(),
  });
});

// Health check endpoint verifying real database connectivity
app.get(`${API_PREFIX}/health`, async (_req: Request, res: Response) => {
  try {
    const userCount = await prisma.user.count();
    res.json({
      status: 'ok',
      db: 'connected',
      // A row count on a public endpoint reports how many accounts exist and how
      // fast the platform is growing. Previews still report it, because the setup
      // verifier reads it to prove the seed worked.
      ...(IS_LIVE_PRODUCTION ? {} : { users: userCount }),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    // The full cause belongs to the runtime log, never the response: this endpoint
    // is public and driver messages quote SQL, table names and connection strings.
    console.error('[ADGRID Health] Database check failed:', error?.code ? `(${error.code})` : '', error?.message || error);

    // Machine-readable, curated cause. Enough for an operator to branch on, and it
    // cannot reveal what the database actually said.
    const message = typeof error?.message === 'string' ? error.message : '';
    const reason = message.startsWith('[Database]')
      ? 'not_configured'
      : /can'?t reach database server|econn|etimedout|enotfound|p1001|timeout/i.test(message)
        ? 'unreachable'
        : error?.code
          ? 'query_failed'
          : 'unavailable';

    res.status(503).json({
      status: 'degraded',
      db: 'error',
      reason,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Deployment configuration report (no secrets). Safe to expose: it answers
 * "is this environment actually able to send verification codes and accept
 * social sign-in?" which is the difference between a working and broken launch.
 */
app.get(`${API_PREFIX}/health/config`, async (_req: Request, res: Response) => {
  const email = emailDiagnostics();
  const isProduction = process.env.NODE_ENV === 'production';
  const warnings: string[] = [];

  let databaseConnected = false;
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    databaseConnected = true;
  } catch (error: any) {
    warnings.push(`Database check failed: ${error?.message || 'unknown error'}`);
  }

  if (!email.configured) {
    warnings.push(
      isProduction
        ? 'RESEND_API_KEY/RESEND_FROM_EMAIL are not set: verification codes, password resets and invitations cannot be delivered.'
        : 'Email provider not configured - development outbox mode is active.'
    );
  }

  if (email.usingSharedTestSender && isProduction) {
    warnings.push(
      'RESEND_FROM_EMAIL uses the shared onboarding@resend.dev sender. Resend only delivers those to the account owner - verify your own domain and switch the sender before launch.'
    );
  }

  if (!process.env.JWT_ACCESS_SECRET && isProduction) {
    warnings.push('JWT_ACCESS_SECRET is not set: the built-in development secret is being used to sign sessions.');
  }

  if (!isProduction && email.devOutboxEnabled) {
    warnings.push(
      'Development mode: emailed verification codes are readable at /api/auth/dev-last-otp. Never expose this deployment publicly.'
    );
  }

  if (!process.env.APP_URL && !process.env.VERCEL_URL && isProduction) {
    warnings.push('APP_URL is not set: emailed verification and password-reset links will point at localhost.');
  }

  return res.json({
    status: warnings.length === 0 ? 'ok' : 'attention',
    environment: process.env.NODE_ENV || 'development',
    appUrl: process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null),
    database: {
      connected: databaseConnected,
      mode: process.env.PRISMA_DRIVER_ADAPTER === 'pg' ? 'pg driver adapter' : 'DATABASE_URL',
    },
    email,
    // Social sign-in is not part of this build: email + 6-digit code is the
    // sign-in flow. The key stays in the payload so deployment checks and
    // dashboards that read it keep working.
    supabaseAuth: {
      enabled: false,
      autoProvision: 'none',
      redirectUrl: null,
      anonKeyPresent: false,
      jwtSecretPresent: false,
    },
    warnings,
  });
});

/**
 * Send a real test email through Resend (Platform Admin only) so an operator can
 * confirm the sending domain, key and network path all work in production.
 */
app.post(
  `${API_PREFIX}/health/config/test-email`,
  requireAuth,
  requireRole(['Platform Admin']),
  async (req: Request, res: Response) => {
    const to = String(req.body?.to || req.user!.email).trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ success: false, error: 'A valid destination email address is required.' });
    }

    const result = await sendTestEmail(to);

    await recordAuditLog({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'EMAIL_DELIVERY_TESTED',
      entity: 'EmailProvider',
      metadata: { to, success: result.success, error: result.error || null },
      req,
    });

    if (!result.success) {
      return res.status(503).json({
        success: false,
        code: result.code || 'email_delivery_failed',
        error: result.error,
      });
    }

    return res.json({
      success: true,
      message: `Test email sent to ${to}.`,
      providerMessageId: result.providerMessageId,
    });
  }
);

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================

const signupSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  organization: z.string().min(2),
  role: z.string(),
  title: z.string().optional(),
  city: z.string().optional(),
  invitationToken: z.string().optional(),
});

// Public Registration
const handleRegistration = async (req: Request, res: Response) => {
  const parsed = signupSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: 'Invalid registration inputs. Name, email, organization and password are required.',
      details: parsed.error.issues,
    });
  }

  const { name, email, password, organization, role, title, city, invitationToken } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  // Enforce Section 6 & 7: Only public roles allowed through public signup
  const PUBLIC_ALLOWED_ROLES = [
    'Media Owner',
    'Agency Admin',
    'Customer / Client Company',
    'Vendor',
  ];

  if (!PUBLIC_ALLOWED_ROLES.includes(role) && !invitationToken) {
    return res.status(403).json({
      success: false,
      error: `Privileged role '${role}' cannot be self-assigned. It must be provisioned by a platform administrator.`,
      code: 'privileged_role_forbidden',
    });
  }

  // Check duplicate email
  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existingUser) {
    return res.status(409).json({
      success: false,
      error: 'An account with this email address already exists. Please sign in.',
      code: 'email_already_exists',
    });
  }

  let tenantId: string | null = null;
  let assignedRole = role;

  // If registering via invitation (Clients, Field Agents, staff)
  if (invitationToken) {
    const inviteHash = hashToken(invitationToken);
    const invite = await prisma.invitation.findUnique({
      where: { tokenHash: inviteHash },
      include: { tenant: true },
    });

    if (!invite || invite.expiresAt < new Date() || invite.acceptedAt) {
      return res.status(400).json({
        success: false,
        error: 'Invalid, used, or expired organization invitation link.',
        code: 'invalid_invitation',
      });
    }

    tenantId = invite.tenantId;
    assignedRole = invite.role; // Strictly enforced by the invitation

    // Mark invitation as accepted (single-use lifecycle)
    await prisma.invitation.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });
  } else {
    // Determine tenant type from role
    const tenantTypeMap: Record<string, string> = {
      'Media Owner': 'MEDIA_OWNER',
      'Agency Admin': 'AGENCY',
      'Customer / Client Company': 'CLIENT',
      'Vendor': 'VENDOR',
    };

    // Section 3: Agency self-registration MUST be created with status = PENDING
    const isAgencySelfReg = assignedRole === 'Agency Admin';
    const tenantStatus = isAgencySelfReg ? 'PENDING' : 'ACTIVE';

    const newTenant = await prisma.tenant.create({
      data: {
        name: organization.trim(),
        type: tenantTypeMap[assignedRole] || 'AGENCY',
        city: city || 'Lagos',
        country: 'Nigeria',
        status: tenantStatus,
        setupCompleted: !isAgencySelfReg,
      },
    });

    tenantId = newTenant.id;
  }

  // Hash password
  const passwordHash = await hashPassword(password);

  // Split name for firstName/lastName
  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0] || name.trim();
  const lastName = nameParts.slice(1).join(' ') || undefined;

  // Section 3: Agency Owner self-registration MUST have user status = PENDING
  const isAgencyPending = assignedRole === 'Agency Admin' && !invitationToken;
  const userStatus = isAgencyPending ? 'PENDING' : 'PENDING_VERIFICATION';

  // Create user
  const newUser = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name: name.trim(),
      firstName,
      lastName,
      passwordHash,
      role: assignedRole,
      title: title || (assignedRole === 'Media Owner' ? 'Managing Director & Concessionaire' : 'Executive Administrator'),
      tenantId,
      status: userStatus,
      emailVerifiedAt: null,
      avatarUrl: assignedRole === 'Media Owner'
        ? 'https://images.unsplash.com/photo-1567532939604-b6b5b0db2604?auto=format&fit=crop&w=300&q=80'
        : 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=300&q=80',
    },
    include: { tenant: true },
  });

  // ── Dev shortcut: skip OTP entirely and issue a session immediately ──────
  if (SKIP_EMAIL_VERIFICATION) {
    console.warn(`[Auth] SKIP_EMAIL_VERIFICATION is ON — auto-verifying ${newUser.email} without OTP.`);

    // Promote the account to ACTIVE right away
    const verifiedUser = await prisma.user.update({
      where: { id: newUser.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
      include: { tenant: true },
    });

    await recordAuditLog({
      actorId: verifiedUser.id,
      actorRole: verifiedUser.role,
      tenantId: verifiedUser.tenantId,
      action: 'REGISTER_AUTO_VERIFIED',
      entity: 'User',
      entityId: verifiedUser.id,
      metadata: { email: verifiedUser.email, role: verifiedUser.role, reason: 'SKIP_EMAIL_VERIFICATION=true' },
      req,
    });

    const accessToken = signAccessToken({
      id: verifiedUser.id,
      email: verifiedUser.email,
      name: verifiedUser.name,
      role: verifiedUser.role,
      tenantId: verifiedUser.tenantId,
      permissions: [],
    });

    const rawRefreshToken = await createRefreshTokenSession(verifiedUser.id, req);
    const dashboard = getAuthorizedDashboardForRole(verifiedUser.role);

    res.cookie('refresh_token', rawRefreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      success: true,
      requiresVerification: false,
      token: accessToken,
      redirectTo: dashboard,
      user: {
        id: verifiedUser.id,
        name: verifiedUser.name,
        email: verifiedUser.email,
        role: verifiedUser.role,
        organization: verifiedUser.tenant?.name,
        title: verifiedUser.title,
        avatarUrl: verifiedUser.avatarUrl,
        tenantId: verifiedUser.tenantId,
        authorizedDashboard: dashboard,
        status: verifiedUser.status,
      },
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Generate and send a 6-digit verification code through Resend. Delivery
  // problems are reported here rather than being swallowed: the account exists,
  // but the caller must know the code did not go out.
  const otpRes = await createAndSendVerificationOtp(newUser, 'SIGN_UP');
  if (!otpRes.success) {
    return res.status(503).json({
      success: false,
      requiresVerification: true,
      email: newUser.email,
      code: 'email_delivery_failed',
      error: 'Your account was created, but we could not deliver the verification email. Please request a new code.',
    });
  }

  // Section 3 & 14: IMPORTANT: Agency Owner self-registration MUST NOT create an active session
  if (isAgencyPending) {
    await recordAuditLog({
      actorId: newUser.id,
      actorRole: newUser.role,
      tenantId: newUser.tenantId,
      action: 'AGENCY_APPLICATION_SUBMITTED',
      entity: 'Tenant',
      entityId: newUser.tenantId,
      metadata: { agencyName: organization, ownerEmail: newUser.email },
      req,
    });

    return res.status(201).json({
      success: true,
      pendingApproval: true,
      requiresVerification: true,
      email: newUser.email,
      message: 'Application submitted. A 6-digit verification code has been sent to your email.',
    });
  }

  // Record audit log
  await recordAuditLog({
    actorId: newUser.id,
    actorRole: newUser.role,
    tenantId: newUser.tenantId,
    action: 'REGISTER_PENDING_VERIFICATION',
    entity: 'User',
    entityId: newUser.id,
    metadata: { email: newUser.email, role: newUser.role },
    req,
  });

  // No session is issued until the emailed code is confirmed: the account stays
  // PENDING_VERIFICATION and /auth/verify-otp completes the sign-in.
  return res.status(201).json({
    success: true,
    requiresVerification: true,
    email: newUser.email,
    cooldownSeconds: otpRes.cooldownSeconds || 60,
    message: 'Account created successfully. A 6-digit verification code has been sent to your email address.',
    role: newUser.role,
    user: {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role,
      tenantId: newUser.tenantId,
      status: newUser.status,
    },
  });
};

app.post(`${API_PREFIX}/auth/register`, authRateLimit, handleRegistration);
app.post(`${API_PREFIX}/auth/signup`, authRateLimit, handleRegistration);

// Dedicated Media Owner Registration endpoint (Section 1)
app.post(`${API_PREFIX}/auth/register-media-owner`, authRateLimit, async (req: Request, res: Response) => {
  const { name, email, password, organization, city, country, licenseNumber, title } = req.body || {};

  if (!name || !email || !password || !organization) {
    return res.status(400).json({
      success: false,
      error: 'Name, email, password, and concessionaire organization name are required.',
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    return res.status(409).json({
      success: false,
      error: 'An account with this email address already exists. Please sign in.',
    });
  }

  const newTenant = await prisma.tenant.create({
    data: {
      name: String(organization).trim(),
      type: 'MEDIA_OWNER',
      status: 'ACTIVE',
      city: city || 'Lagos',
      country: country || 'Nigeria',
      licenseNumber: licenseNumber || 'LASAA/OOH/VOL.4/2024-REG',
      setupCompleted: true,
    },
  });

  const passwordHash = await hashPassword(String(password));
  const nameParts = String(name).trim().split(/\s+/);

  const newUser = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name: String(name).trim(),
      firstName: nameParts[0] || String(name).trim(),
      lastName: nameParts.slice(1).join(' ') || undefined,
      passwordHash,
      role: 'Media Owner',
      title: title || 'Managing Director & Concessionaire',
      tenantId: newTenant.id,
      status: 'PENDING_VERIFICATION',
      emailVerifiedAt: null,
      avatarUrl: 'https://images.unsplash.com/photo-1567532939604-b6b5b0db2604?auto=format&fit=crop&w=300&q=80',
    },
    include: { tenant: true },
  });

  // ── Dev shortcut: skip OTP entirely and issue a session immediately ──────
  if (SKIP_EMAIL_VERIFICATION) {
    console.warn(`[Auth] SKIP_EMAIL_VERIFICATION is ON — auto-verifying media owner ${newUser.email} without OTP.`);

    const verifiedUser = await prisma.user.update({
      where: { id: newUser.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
      include: { tenant: true },
    });

    await recordAuditLog({
      actorId: verifiedUser.id,
      actorRole: verifiedUser.role,
      tenantId: verifiedUser.tenantId,
      action: 'REGISTER_AUTO_VERIFIED',
      entity: 'User',
      entityId: verifiedUser.id,
      metadata: { email: verifiedUser.email, role: verifiedUser.role, reason: 'SKIP_EMAIL_VERIFICATION=true' },
      req,
    });

    const accessToken = signAccessToken({
      id: verifiedUser.id,
      email: verifiedUser.email,
      name: verifiedUser.name,
      role: verifiedUser.role,
      tenantId: verifiedUser.tenantId,
      permissions: [],
    });

    const rawRefreshToken = await createRefreshTokenSession(verifiedUser.id, req);

    res.cookie('refresh_token', rawRefreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      success: true,
      requiresVerification: false,
      token: accessToken,
      redirectTo: '/admin/media-owner',
      user: {
        id: verifiedUser.id,
        name: verifiedUser.name,
        email: verifiedUser.email,
        role: verifiedUser.role,
        organization: verifiedUser.tenant?.name,
        title: verifiedUser.title,
        avatarUrl: verifiedUser.avatarUrl,
        tenantId: verifiedUser.tenantId,
        authorizedDashboard: '/admin/media-owner',
        status: verifiedUser.status,
      },
    });
  }

  // Email a 6-digit code; the account stays unverified until it is confirmed.
  const otpRes = await createAndSendVerificationOtp(newUser, 'SIGN_UP');
  if (!otpRes.success) {
    return res.status(503).json({
      success: false,
      requiresVerification: true,
      email: newUser.email,
      code: 'email_delivery_failed',
      error: 'Your account was created, but we could not deliver the verification email. Please request a new code.',
    });
  }

  await recordAuditLog({
    actorId: newUser.id,
    actorRole: newUser.role,
    tenantId: newUser.tenantId,
    action: 'MEDIA_OWNER_REGISTERED_PENDING_VERIFICATION',
    entity: 'Tenant',
    entityId: newTenant.id,
    metadata: { email: newUser.email, organization: newTenant.name },
    req,
  });

  // No session until the code is verified (POST /auth/verify-otp).
  return res.status(201).json({
    success: true,
    requiresVerification: true,
    email: newUser.email,
    cooldownSeconds: otpRes.cooldownSeconds || 60,
    message: 'Account created. A 6-digit verification code has been sent to your email address.',
    user: {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role,
      tenantId: newUser.tenantId,
      status: newUser.status,
    },
  });
});

// Dedicated Marketing Agency Registration endpoint (Section 3)
app.post(`${API_PREFIX}/auth/register-agency`, authRateLimit, async (req: Request, res: Response) => {
  const { agencyName, ownerFullName, email, phone, password, city, country, notes } = req.body || {};

  if (!agencyName || !ownerFullName || !email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Agency name, owner full name, work email, and password are required.',
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    return res.status(409).json({
      success: false,
      error: 'An account with this email address already exists. Please sign in.',
    });
  }

  // Create PENDING Agency Tenant (Section 3)
  const newTenant = await prisma.tenant.create({
    data: {
      name: String(agencyName).trim(),
      type: 'AGENCY',
      status: 'PENDING',
      city: city || 'Lagos',
      country: country || 'Nigeria',
      phone: phone || undefined,
      licenseNumber: notes || undefined,
      setupCompleted: false,
    },
  });

  const passwordHash = await hashPassword(String(password));
  const nameParts = String(ownerFullName).trim().split(/\s+/);

  // Create PENDING Agency Owner (Section 3)
  const newUser = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name: String(ownerFullName).trim(),
      firstName: nameParts[0] || String(ownerFullName).trim(),
      lastName: nameParts.slice(1).join(' ') || undefined,
      passwordHash,
      role: 'Agency Admin',
      title: 'Managing Director & Partner',
      phone: phone || undefined,
      tenantId: newTenant.id,
      status: 'PENDING',
      emailVerifiedAt: null,
      avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=300&q=80',
    },
    include: { tenant: true },
  });

  // ── Dev shortcut: skip OTP entirely and issue a session immediately ──────
  if (SKIP_EMAIL_VERIFICATION) {
    console.warn(`[Auth] SKIP_EMAIL_VERIFICATION is ON — auto-verifying agency ${newUser.email} without OTP.`);

    const verifiedUser = await prisma.user.update({
      where: { id: newUser.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
      include: { tenant: true },
    });

    await prisma.tenant.update({
      where: { id: newTenant.id },
      data: { status: 'ACTIVE' },
    });

    await recordAuditLog({
      actorId: verifiedUser.id,
      actorRole: verifiedUser.role,
      tenantId: newTenant.id,
      action: 'AGENCY_APPLICATION_AUTO_VERIFIED',
      entity: 'Tenant',
      entityId: newTenant.id,
      metadata: { agencyName: newTenant.name, ownerEmail: newUser.email, reason: 'SKIP_EMAIL_VERIFICATION=true' },
      req,
    });

    const accessToken = signAccessToken({
      id: verifiedUser.id,
      email: verifiedUser.email,
      name: verifiedUser.name,
      role: verifiedUser.role,
      tenantId: verifiedUser.tenantId,
      permissions: [],
    });

    const rawRefreshToken = await createRefreshTokenSession(verifiedUser.id, req);

    res.cookie('refresh_token', rawRefreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      success: true,
      pendingApproval: false,
      requiresVerification: false,
      token: accessToken,
      redirectTo: '/admin/agency',
      user: {
        id: verifiedUser.id,
        name: verifiedUser.name,
        email: verifiedUser.email,
        role: verifiedUser.role,
        organization: verifiedUser.tenant?.name,
        title: verifiedUser.title,
        avatarUrl: verifiedUser.avatarUrl,
        tenantId: verifiedUser.tenantId,
        authorizedDashboard: '/admin/agency',
        status: verifiedUser.status,
      },
    });
  }

  // The owner must confirm the emailed code before the application is complete.
  const otpRes = await createAndSendVerificationOtp(newUser, 'SIGN_UP');
  if (!otpRes.success) {
    return res.status(503).json({
      success: false,
      requiresVerification: true,
      email: newUser.email,
      code: 'email_delivery_failed',
      error: 'Your application was submitted, but we could not deliver the verification email. Please request a new code.',
    });
  }

  await recordAuditLog({
    actorId: newUser.id,
    actorRole: newUser.role,
    tenantId: newTenant.id,
    action: 'AGENCY_APPLICATION_SUBMITTED',
    entity: 'Tenant',
    entityId: newTenant.id,
    metadata: { agencyName: newTenant.name, ownerEmail: newUser.email },
    req,
  });

  // DO NOT create session, DO NOT issue token, DO NOT set cookie — the agency
  // still needs approval, and the owner still needs to verify the address.
  return res.status(201).json({
    success: true,
    pendingApproval: true,
    requiresVerification: true,
    email: newUser.email,
    cooldownSeconds: otpRes.cooldownSeconds || 60,
    message: 'Application submitted. A 6-digit verification code has been sent to your email.',
  });
});

// Invitation Inspection endpoint (Section 10)
app.get(`${API_PREFIX}/auth/invitation-info`, async (req: Request, res: Response) => {
  const token = req.query?.token as string;
  if (!token) {
    return res.status(400).json({ success: false, valid: false, error: 'Invitation token is required.' });
  }

  const tokenHash = hashToken(String(token));
  const invite = await prisma.invitation.findUnique({
    where: { tokenHash },
    include: { tenant: true },
  });

  if (!invite) {
    return res.status(404).json({ success: false, valid: false, error: 'Invitation not found or link is invalid.' });
  }

  if (invite.acceptedAt) {
    return res.status(400).json({
      success: false,
      valid: false,
      error: 'This invitation has already been accepted and cannot be reused.',
    });
  }

  if (invite.expiresAt < new Date()) {
    return res.status(400).json({
      success: false,
      valid: false,
      error: 'This invitation link has expired. Please request a new invitation from your agency administrator.',
    });
  }

  return res.json({
    success: true,
    valid: true,
    email: invite.email,
    role: invite.role,
    tenantName: invite.tenant.name,
    tenantId: invite.tenantId,
    dashboard: getAuthorizedDashboardForRole(invite.role),
  });
});

// Invitation Acceptance endpoint (Section 7, 8 & 10)
app.post(`${API_PREFIX}/auth/accept-invitation`, strictRateLimit, async (req: Request, res: Response) => {
  const { token, name, password, phone, title } = req.body || {};
  if (!token || !password) {
    return res.status(400).json({ success: false, error: 'Invitation token and password are required.' });
  }

  if (String(password).length < 6) {
    return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long.' });
  }

  const tokenHash = hashToken(String(token));
  const invite = await prisma.invitation.findUnique({
    where: { tokenHash },
    include: { tenant: true },
  });

  if (!invite) {
    return res.status(404).json({ success: false, error: 'Invalid invitation link.' });
  }

  if (invite.acceptedAt) {
    return res.status(400).json({ success: false, error: 'This invitation has already been used and cannot be reused.' });
  }

  if (invite.expiresAt < new Date()) {
    return res.status(400).json({ success: false, error: 'This invitation link has expired. Please request a new invitation.' });
  }

  const passwordHash = await hashPassword(String(password));
  const normalizedEmail = invite.email.trim().toLowerCase();
  const userName = name ? String(name).trim() : normalizedEmail.split('@')[0];

  let user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (user) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        name: userName || user.name,
        role: invite.role, // strictly role from invitation
        tenantId: invite.tenantId,
        status: 'ACTIVE',
        phone: phone || user.phone,
        title: title || user.title,
        emailVerifiedAt: new Date(),
      },
      include: { tenant: true },
    });
  } else {
    const nameParts = userName.split(/\s+/);
    user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: userName,
        firstName: nameParts[0] || userName,
        lastName: nameParts.slice(1).join(' ') || undefined,
        passwordHash,
        role: invite.role,
        tenantId: invite.tenantId,
        status: 'ACTIVE',
        phone: phone || undefined,
        title: title || (invite.role === 'Field Agent' ? 'Field Verification Operative' : 'Enterprise Brand Client'),
        emailVerifiedAt: new Date(),
        avatarUrl: invite.role === 'Field Agent'
          ? 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=300&q=80'
          : 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=300&q=80',
      },
      include: { tenant: true },
    });
  }

  // Mark invitation accepted
  await prisma.invitation.update({
    where: { id: invite.id },
    data: { acceptedAt: new Date() },
  });

  const dashboard = getAuthorizedDashboardForRole(user.role);
  if (!dashboard) {
    return res.status(403).json({ success: false, error: 'Invalid role assignment.' });
  }

  const rawRefreshToken = await createRefreshTokenSession(user.id, req);
  const accessToken = signAccessToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    permissions: [],
  });

  await recordAuditLog({
    actorId: user.id,
    actorRole: user.role,
    tenantId: user.tenantId,
    action: 'INVITATION_ACCEPTED',
    entity: 'User',
    entityId: user.id,
    metadata: { email: user.email, role: user.role, organization: invite.tenant.name },
    req,
  });

  res.cookie('refresh_token', rawRefreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.json({
    success: true,
    token: accessToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organization: invite.tenant.name,
      title: user.title,
      avatarUrl: user.avatarUrl,
      tenantId: user.tenantId,
      authorizedDashboard: dashboard,
    },
    redirectTo: dashboard,
  });
});

// Public Demo Configuration endpoint for login UI selector
app.get(`${API_PREFIX}/auth/demo-config`, (_req: Request, res: Response) => {
  res.json(getDemoConfigPayload());
});

// Sign In
app.post(`${API_PREFIX}/auth/login`, authRateLimit, async (req: Request, res: Response) => {
  const { email, password, portalType } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Email and password are required.',
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  // If logging in with a predefined demo account while demo auth is enabled, ensure account is provisioned
  if (isDemoEmail(normalizedEmail) && isDemoAuthEnabled()) {
    await ensureDemoAccountsProvisioned().catch((err) => {
      console.warn('[Demo Login] Idempotent account provisioning check:', err);
    });
  }

  // Find user in database
  let user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    include: { tenant: true },
  });

  if (!user) {
    await recordAuditLog({
      action: 'LOGIN_FAILED',
      entity: 'User',
      metadata: { email: normalizedEmail, reason: 'User not found' },
      req,
    });
    return res.status(401).json({
      success: false,
      error: 'Invalid credentials. No authorized platform account found for this email.',
      code: 'invalid_credentials',
    });
  }

  // Verify password with bcrypt
  let passwordMatches = await verifyPassword(String(password), user.passwordHash);

  // Strict, isolated demo password verification ONLY for pre-configured demo accounts when DEMO_AUTH_ENABLED is active
  if (
    !passwordMatches &&
    isDemoAuthEnabled() &&
    isDemoEmail(normalizedEmail) &&
    password === SHARED_DEMO_PASSWORD
  ) {
    passwordMatches = true;
    // The resync exists so a hand-seeded demo row converges on a real bcrypt hash.
    // It is a write to whichever account matched that email, so it stays off
    // deployed environments: a genuine user whose address is on the demo list would
    // otherwise have their password replaced with the shared one on first demo login.
    if (mayWriteDemoData()) {
      hashPassword(SHARED_DEMO_PASSWORD).then((newHash) => {
        prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } }).catch(() => {});
      });
    }
  }

  if (!passwordMatches) {
    await recordAuditLog({
      actorId: user.id,
      actorRole: user.role,
      tenantId: user.tenantId,
      action: 'LOGIN_FAILED',
      entity: 'User',
      entityId: user.id,
      metadata: { reason: 'Incorrect password' },
      req,
    });
    return res.status(401).json({
      success: false,
      error: 'Invalid credentials. Please verify your password.',
      code: 'invalid_credentials',
    });
  }

  // Section 3 of OTP requirements: Unverified email prevents access & triggers OTP
  if (!user.emailVerifiedAt || user.status === 'PENDING_VERIFICATION') {
    if (SKIP_EMAIL_VERIFICATION) {
      console.warn(`[Auth] SKIP_EMAIL_VERIFICATION is ON — auto-verifying ${user.email} on login.`);
      user = await prisma.user.update({
        where: { id: user.id },
        data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
        include: { tenant: true },
      });
    } else {
      const otpRes = await createAndSendVerificationOtp(user, 'SIGN_IN');

      // Only claim a code was sent when delivery actually succeeded.
      const message = otpRes.success
        ? 'Please verify your email address to continue. A 6-digit verification code has been sent to your email.'
        : otpRes.code === 'cooldown_active'
          ? 'Please verify your email address to continue. Use the verification code we already sent, or request a new one once the cooldown ends.'
          : 'Please verify your email address to continue. We could not send a new verification code just now - open the verification screen to request another one.';

      await recordAuditLog({
        actorId: user.id,
        actorRole: user.role,
        tenantId: user.tenantId,
        action: otpRes.success ? 'OTP_SENT_ON_LOGIN' : 'OTP_SEND_FAILED_ON_LOGIN',
        entity: 'User',
        entityId: user.id,
        metadata: { code: otpRes.code || null },
        req,
      });

      return res.status(403).json({
        success: false,
        requiresVerification: true,
        email: user.email,
        cooldownSeconds: otpRes.cooldownSeconds || 60,
        codeSent: otpRes.success,
        error: message,
        code: 'email_not_verified',
      });
    }
  }

  // Section 4 & 5: Check account state (PENDING / REJECTED / SUSPENDED)
  if (user.status === 'PENDING') {
    return res.status(403).json({
      success: false,
      error: 'Your agency application is awaiting approval by the Media Owner network.',
      code: 'account_pending_approval',
    });
  }

  if (user.status === 'REJECTED') {
    return res.status(403).json({
      success: false,
      error: 'Your agency application was not approved by the media concessionaire network.',
      code: 'account_rejected',
    });
  }

  if (user.status === 'SUSPENDED' || user.status === 'DISABLED') {
    await recordAuditLog({
      actorId: user.id,
      action: 'LOGIN_BLOCKED',
      entity: 'User',
      entityId: user.id,
      metadata: { status: user.status },
      req,
    });
    return res.status(403).json({
      success: false,
      error: `Your account is ${user.status.toLowerCase()}. Please contact platform operations.`,
      code: 'account_inactive',
    });
  }

  // Section 5 & 9: Check organization tenant state
  if (user.tenant) {
    if (user.tenant.status === 'PENDING') {
      return res.status(403).json({
        success: false,
        error: 'Your agency organization is awaiting approval by the Media Owner network.',
        code: 'tenant_pending_approval',
      });
    }
    if (user.tenant.status === 'REJECTED') {
      return res.status(403).json({
        success: false,
        error: 'Your agency organization application has been rejected.',
        code: 'tenant_rejected',
      });
    }
    if (user.tenant.status === 'SUSPENDED') {
      return res.status(403).json({
        success: false,
        error: 'Your organization has been suspended.',
        code: 'tenant_suspended',
      });
    }
  }

  // Section 1: Media Owner authentication must NOT be mixed with Agency authentication
  if (portalType === 'media' && user.role !== 'Media Owner' && user.role !== 'Platform Admin') {
    return res.status(403).json({
      success: false,
      error: 'This portal is restricted to Media Owner concessionaires. Marketing Agencies must sign in at /agency/login.',
      code: 'portal_mismatch',
    });
  }

  const AGENCY_ROLES_LIST = [
    'Agency Admin',
    'Campaign Manager',
    'Operations Manager',
    'Account Manager',
    'Finance Manager',
    'Field Manager',
    'Agency Staff',
  ];

  if (portalType === 'agency' && !AGENCY_ROLES_LIST.includes(user.role) && user.role !== 'Platform Admin') {
    return res.status(403).json({
      success: false,
      error: 'This portal is reserved for Marketing Agency accounts. Media Owners should sign in at /media/login.',
      code: 'portal_mismatch',
    });
  }

  // Section 13: Strict role dashboard validation
  const dashboard = getAuthorizedDashboardForRole(user.role);
  if (!dashboard) {
    return res.status(403).json({
      success: false,
      error: `Access Denied: Unrecognized or unauthorized role '${user.role}'.`,
      code: 'unauthorized_role',
    });
  }

  // Check MFA challenge
  if (user.mfaEnabled && user.mfaSecret) {
    const mfaToken = signMfaToken(user.id, user.email);
    return res.status(200).json({
      success: true,
      status: 'MFA_REQUIRED',
      mfaRequired: true,
      mfaToken,
    });
  }

  // Update last login timestamp
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  // Create session
  const rawRefreshToken = await createRefreshTokenSession(user.id, req);

  const accessToken = signAccessToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    permissions: [],
  });

  // Record audit log
  await recordAuditLog({
    actorId: user.id,
    actorRole: user.role,
    tenantId: user.tenantId,
    action: 'LOGIN',
    entity: 'User',
    entityId: user.id,
    metadata: { method: 'password', role: user.role },
    req,
  });

  // Set httpOnly cookies for session management
  res.cookie('refresh_token', rawRefreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.cookie('access_token', accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 15 * 60 * 1000,
  });

  return res.json({
    success: true,
    token: accessToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organization: user.tenant?.name || 'ADGRID Network',
      title: user.title,
      avatarUrl: user.avatarUrl,
      tenantId: user.tenantId,
      authorizedDashboard: dashboard,
    },
    redirectTo: dashboard,
  });
});

// MFA Verification during login challenge
app.post(`${API_PREFIX}/auth/mfa/verify`, authRateLimit, async (req: Request, res: Response) => {
  const { mfaToken, code } = req.body || {};
  if (!mfaToken || !code) {
    return res.status(400).json({
      success: false,
      error: 'MFA challenge token and verification code are required.',
    });
  }

  const payload = verifyMfaToken(String(mfaToken));
  if (!payload || !payload.sub) {
    return res.status(401).json({
      success: false,
      error: 'MFA challenge session expired or invalid. Please sign in again.',
      code: 'mfa_token_expired',
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { tenant: true },
  });

  if (!user || !user.mfaSecret) {
    return res.status(401).json({
      success: false,
      error: 'User not found or MFA is not configured.',
    });
  }

  const inputCode = String(code).trim();
  const validTotp = authenticator.check(inputCode, user.mfaSecret);

  let validBackup = false;
  if (!validTotp && user.mfaBackupCodes) {
    try {
      const backupCodes: string[] = JSON.parse(user.mfaBackupCodes);
      const codeIndex = backupCodes.indexOf(inputCode.toUpperCase());
      if (codeIndex !== -1) {
        validBackup = true;
        // Remove used single-use backup code
        backupCodes.splice(codeIndex, 1);
        await prisma.user.update({
          where: { id: user.id },
          data: { mfaBackupCodes: JSON.stringify(backupCodes) },
        });
      }
    } catch {
      // ignore JSON parse error
    }
  }

  if (!validTotp && !validBackup) {
    await recordAuditLog({
      actorId: user.id,
      action: 'MFA_FAILED',
      entity: 'User',
      entityId: user.id,
      metadata: { reason: 'Invalid TOTP or backup code' },
      req,
    });
    return res.status(401).json({
      success: false,
      error: 'Invalid MFA verification code. Please check your authenticator app or backup codes.',
      code: 'invalid_mfa_code',
    });
  }

  // Update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const rawRefreshToken = await createRefreshTokenSession(user.id, req);
  const dashboard = getAuthorizedDashboardForRole(user.role);

  const accessToken = signAccessToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    permissions: [],
  });

  await recordAuditLog({
    actorId: user.id,
    actorRole: user.role,
    tenantId: user.tenantId,
    action: 'LOGIN_MFA',
    entity: 'User',
    entityId: user.id,
    metadata: { method: validBackup ? 'backup_code' : 'totp' },
    req,
  });

  res.cookie('refresh_token', rawRefreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.json({
    success: true,
    token: accessToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organization: user.tenant?.name || 'ADGRID Network',
      title: user.title,
      avatarUrl: user.avatarUrl,
      tenantId: user.tenantId,
      authorizedDashboard: dashboard,
    },
    redirectTo: dashboard,
  });
});

// Enable MFA: Generate Secret & QR Code
app.post(`${API_PREFIX}/auth/mfa/enable`, requireAuth, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { secret, otpauth } = generateMfaSecret(user.email);
  const qrCodeDataUrl = await generateQrCode(otpauth);

  // Store secret temporarily pending confirmation
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaSecret: secret },
  });

  return res.json({
    success: true,
    secret,
    otpauthUrl: otpauth,
    qrCodeDataUrl,
  });
});

// Confirm MFA setup with code verification
app.post(`${API_PREFIX}/auth/mfa/confirm`, requireAuth, async (req: Request, res: Response) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Verification code is required' });

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user || !user.mfaSecret) {
    return res.status(400).json({ error: 'MFA setup has not been initiated.' });
  }

  const isValid = authenticator.check(String(code).trim(), user.mfaSecret);
  if (!isValid) {
    return res.status(400).json({ error: 'Invalid verification code. Please check your authenticator app.' });
  }

  const backupCodes = generateBackupCodes(10);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaEnabled: true,
      mfaBackupCodes: JSON.stringify(backupCodes),
    },
  });

  await recordAuditLog({
    actorId: user.id,
    actorRole: user.role,
    tenantId: user.tenantId,
    action: 'MFA_ENABLED',
    entity: 'User',
    entityId: user.id,
    req,
  });

  return res.json({
    success: true,
    message: 'MFA successfully enabled.',
    backupCodes,
  });
});

// Disable MFA
app.post(`${API_PREFIX}/auth/mfa/disable`, requireAuth, async (req: Request, res: Response) => {
  const { password, code } = req.body || {};
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const validPassword = password && (await verifyPassword(String(password), user.passwordHash));
  const validCode = code && user.mfaSecret && authenticator.check(String(code).trim(), user.mfaSecret);

  if (!validPassword && !validCode) {
    return res.status(400).json({
      error: 'Valid account password or authenticator code is required to disable MFA.',
    });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaEnabled: false,
      mfaSecret: null,
      mfaBackupCodes: null,
    },
  });

  await recordAuditLog({
    actorId: user.id,
    actorRole: user.role,
    tenantId: user.tenantId,
    action: 'MFA_DISABLED',
    entity: 'User',
    entityId: user.id,
    req,
  });

  return res.json({ success: true, message: 'MFA has been disabled.' });
});

// Refresh Token: Session rotation and replay detection
app.post(`${API_PREFIX}/auth/refresh`, async (req: Request, res: Response) => {
  const rawToken = req.cookies?.refresh_token || req.body?.refreshToken;
  if (!rawToken) {
    return res.status(401).json({ success: false, error: 'No refresh token provided.' });
  }

  let result: { success: boolean; newRawToken?: string; user?: any; error?: string };
  try {
    result = await rotateRefreshTokenSession(String(rawToken), req);
  } catch (err: any) {
    console.error('[ADGRID Auth] Refresh token rotation error:', err?.message || err);
    return res.status(401).json({
      success: false,
      error: 'Session could not be refreshed. Please sign in again.',
      code: 'session_expired',
    });
  }

  if (!result.success || !result.newRawToken || !result.user) {
    return res.status(401).json({
      success: false,
      error: result.error || 'Refresh session invalid or expired.',
      code: 'session_expired',
    });
  }

  const user = result.user;
  const dashboard = getAuthorizedDashboardForRole(user.role);

  const newAccessToken = signAccessToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    permissions: [],
  });

  res.cookie('refresh_token', result.newRawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.json({
    success: true,
    token: newAccessToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organization: user.tenant?.name || 'ADGRID Network',
      title: user.title,
      avatarUrl: user.avatarUrl,
      tenantId: user.tenantId,
      authorizedDashboard: dashboard,
    },
    redirectTo: dashboard,
  });
});

// Logout current session
app.post(`${API_PREFIX}/auth/logout`, async (req: Request, res: Response) => {
  const rawToken = req.cookies?.refresh_token || req.body?.refreshToken;
  if (rawToken) {
    await revokeRefreshTokenSession(String(rawToken), req);
  }

  res.clearCookie('refresh_token');
  res.clearCookie('access_token');
  return res.json({ success: true, message: 'Logged out successfully.' });
});

// Logout all sessions (Section 11)
app.post(`${API_PREFIX}/auth/logout-all`, requireAuth, async (req: Request, res: Response) => {
  await revokeAllSessionsForUser(req.user!.id, req);
  res.clearCookie('refresh_token');
  res.clearCookie('access_token');
  return res.json({ success: true, message: 'All active sessions have been logged out.' });
});

// Get current authenticated user profile
app.get(`${API_PREFIX}/auth/me`, requireAuth, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: { tenant: true },
  });

  if (!user) {
    return res.status(404).json({ authenticated: false, error: 'User not found.' });
  }

  const dashboard = getAuthorizedDashboardForRole(user.role);

  return res.json({
    authenticated: true,
    user: {
      id: user.id,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      organization: user.tenant?.name || 'ADGRID Network',
      title: user.title,
      avatarUrl: user.avatarUrl,
      tenantId: user.tenantId,
      status: user.status,
      emailVerified: !!user.emailVerifiedAt,
      mfaEnabled: user.mfaEnabled,
      permissions: req.user!.permissions,
      authorizedDashboard: dashboard,
    },
    tenant: user.tenant,
  });
});

// Verify email address
const handleVerifyEmail = async (req: Request, res: Response) => {
  const { token, code, otp, email } = { ...(req.query || {}), ...(req.body || {}) };

  // 1. Process 6-digit OTP verification
  if (code || otp) {
    const rawOtp = String(code || otp).trim();
    const targetEmail = String(email || '').trim().toLowerCase();

    if (!targetEmail) {
      return res.status(400).json({
        success: false,
        error: 'Email address is required to verify code.',
        code: 'missing_email',
      });
    }

    const verificationResult = await verifyOtpCode(targetEmail, rawOtp, 'EMAIL_VERIFICATION');
    if (!verificationResult.success) {
      const status = verificationResult.code === 'cooldown_active' ? 429 : 400;
      return res.status(status).json(verificationResult);
    }

    const verifiedUser = verificationResult.user;
    await recordAuditLog({
      actorId: verifiedUser.id,
      action: 'EMAIL_VERIFIED_OTP',
      entity: 'User',
      entityId: verifiedUser.id,
      metadata: { email: verifiedUser.email },
      req,
    });

    // If an agency owner is awaiting concessionaire approval
    if (verifiedUser.status === 'PENDING') {
      return res.json({
        success: true,
        pendingApproval: true,
        message: 'Email verified successfully! Your marketing agency application is awaiting approval by the Media Owner network.',
        user: {
          id: verifiedUser.id,
          name: verifiedUser.name,
          email: verifiedUser.email,
          role: verifiedUser.role,
          status: verifiedUser.status,
          emailVerifiedAt: verifiedUser.emailVerifiedAt,
        },
      });
    }

    // Active verified user: issue full authenticated session
    const rawRefreshToken = await createRefreshTokenSession(verifiedUser.id, req);
    const dashboard = getAuthorizedDashboardForRole(verifiedUser.role) || '/admin';

    const accessToken = signAccessToken({
      id: verifiedUser.id,
      email: verifiedUser.email,
      name: verifiedUser.name,
      role: verifiedUser.role,
      tenantId: verifiedUser.tenantId,
      permissions: [],
    });

    res.cookie('refresh_token', rawRefreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      success: true,
      message: 'Email address verified successfully.',
      token: accessToken,
      accessToken,
      user: {
        id: verifiedUser.id,
        name: verifiedUser.name,
        email: verifiedUser.email,
        role: verifiedUser.role,
        tenantId: verifiedUser.tenantId,
        tenant: verifiedUser.tenant,
        status: verifiedUser.status,
        emailVerifiedAt: verifiedUser.emailVerifiedAt,
        authorizedDashboard: dashboard,
      },
      redirectTo: dashboard,
    });
  }

  // 2. Legacy link-based verification token fallback
  if (!token) {
    return res.status(400).json({
      success: false,
      error: 'Verification code or token is required.',
      code: 'missing_code',
    });
  }

  const tokenHash = hashToken(String(token));
  const record = await prisma.emailToken.findUnique({
    where: { tokenHash },
    include: { user: { include: { tenant: true } } },
  });

  if (!record || record.type !== 'VERIFY_EMAIL') {
    return res.status(400).json({ success: false, error: 'Invalid verification token.' });
  }

  if (record.consumedAt) {
    return res.status(400).json({ success: false, error: 'Verification token has already been used.' });
  }

  if (record.expiresAt < new Date()) {
    return res.status(400).json({ success: false, error: 'Verification token has expired. Please request a new one.' });
  }

  // Mark token consumed and user verified
  const [_, updatedUser] = await prisma.$transaction([
    prisma.emailToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: record.userId },
      data: {
        emailVerifiedAt: new Date(),
        status: record.user.status === 'PENDING_VERIFICATION' ? 'ACTIVE' : record.user.status,
      },
      include: { tenant: true },
    }),
  ]);

  await recordAuditLog({
    actorId: record.userId,
    action: 'EMAIL_VERIFIED_TOKEN',
    entity: 'User',
    entityId: record.userId,
    req,
  });

  // Issue session for verified user
  const rawRefreshToken = await createRefreshTokenSession(updatedUser.id, req);
  const dashboard = getAuthorizedDashboardForRole(updatedUser.role) || '/admin';
  const accessToken = signAccessToken({
    id: updatedUser.id,
    email: updatedUser.email,
    name: updatedUser.name,
    role: updatedUser.role,
    tenantId: updatedUser.tenantId,
    permissions: [],
  });

  return res.json({
    success: true,
    message: 'Email address verified successfully.',
    token: accessToken,
    accessToken,
    user: {
      id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      role: updatedUser.role,
      tenantId: updatedUser.tenantId,
      tenant: updatedUser.tenant,
      status: updatedUser.status,
      emailVerifiedAt: updatedUser.emailVerifiedAt,
      authorizedDashboard: dashboard,
    },
    redirectTo: dashboard,
  });
};

app.post(`${API_PREFIX}/auth/verify-otp`, otpVerifyRateLimit, handleVerifyEmail);
app.post(`${API_PREFIX}/auth/verify-email`, otpVerifyRateLimit, handleVerifyEmail);
app.get(`${API_PREFIX}/auth/verify-email`, otpVerifyRateLimit, handleVerifyEmail);

// Map an OTP dispatch failure onto an HTTP response. Provider and
// configuration problems are server-side (503), not client mistakes (400).
function otpFailureResponse(result: { error?: string; code?: string; cooldownSeconds?: number }) {
  if (result.code === 'cooldown_active') {
    return { status: 429, body: { ...result, success: false } };
  }

  const providerFailure = [
    'email_not_configured',
    'email_rejected_by_provider',
    'email_network_error',
    'email_delivery_failed',
  ].includes(String(result.code));

  if (providerFailure) {
    return {
      status: 503,
      body: {
        success: false,
        code: 'email_delivery_failed',
        error:
          result.error ||
          'We could not deliver the verification email right now. Please request a new code shortly.',
      },
    };
  }

  return { status: 400, body: { ...result, success: false } };
}

// Development-only: read back the verification code that was emailed, so local
// signup/sign-in can be completed without access to the inbox. Hard-disabled in
// production (and via ALLOW_DEV_EMAIL_INSPECTION=false).
app.get(`${API_PREFIX}/auth/dev-last-otp`, async (req: Request, res: Response) => {
  if (!isDevEmailInspectionEnabled()) {
    return res.status(404).json({ success: false, error: 'Not found.' });
  }

  const email = String(req.query?.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, error: 'Email is required.' });
  }

  const record = getLatestDevOtp(email);
  if (!record) {
    return res.status(404).json({
      success: false,
      error: 'No development verification code has been recorded for this email address.',
    });
  }

  return res.json({
    success: true,
    email,
    otp: record.otp,
    subject: record.subject,
    sentAt: record.sentAt.toISOString(),
    deliveredByProvider: isEmailDeliveryConfigured(),
  });
});

// Dedicated Resend OTP endpoint
app.post(`${API_PREFIX}/auth/resend-otp`, strictRateLimit, async (req: Request, res: Response) => {
  const email = String(req.body?.email || req.user?.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, error: 'Email address is required.', code: 'missing_email' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Prevent email enumeration
    return res.json({
      success: true,
      message: 'If an account exists with this email address, a verification code has been sent.',
      cooldownSeconds: 60,
    });
  }

  if (user.emailVerifiedAt && user.status === 'ACTIVE') {
    return res.json({
      success: true,
      alreadyVerified: true,
      message: 'This email address is already verified. You can sign in directly.',
    });
  }

  const result = await createAndSendVerificationOtp(user, 'EMAIL_VERIFICATION');
  if (!result.success) {
    const failure = otpFailureResponse(result);
    return res.status(failure.status).json(failure.body);
  }

  return res.json({
    success: true,
    message: result.message,
    cooldownSeconds: result.cooldownSeconds || 60,
    deliveryConfigured: isEmailDeliveryConfigured() || undefined,
    devOtp: isDevEmailInspectionEnabled() ? getLatestDevOtp(email)?.otp : undefined,
  });
});

// Compatibility endpoint: use the same single OTP verification flow.
app.post(`${API_PREFIX}/auth/resend-verification`, strictRateLimit, async (req: Request, res: Response) => {
  const email = (req.body?.email || req.user?.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, error: 'Email is required.' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (user && !user.emailVerifiedAt) {
    const result = await createAndSendVerificationOtp(user, 'EMAIL_VERIFICATION');
    if (!result.success) {
      const failure = otpFailureResponse(result);
      return res.status(failure.status).json(failure.body);
    }
    return res.json({
      success: true,
      message: result.message,
      cooldownSeconds: result.cooldownSeconds || 60,
    });
  }

  return res.json({
    success: true,
    message: 'If the email is registered and unverified, a new verification code has been sent.',
    cooldownSeconds: 60,
  });
});

// Update unverified destination email address and restart verification with fresh 6-digit OTP
app.post(`${API_PREFIX}/auth/change-verification-email`, strictRateLimit, async (req: Request, res: Response) => {
  const currentEmail = String(req.body?.currentEmail || '').trim().toLowerCase();
  const newEmail = String(req.body?.newEmail || '').trim().toLowerCase();

  if (!currentEmail || !newEmail) {
    return res.status(400).json({
      success: false,
      error: 'Both current email and new email are required.',
      code: 'missing_fields',
    });
  }

  if (currentEmail === newEmail) {
    return res.status(400).json({
      success: false,
      error: 'New email must be different from current email.',
      code: 'same_email',
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid email address.',
      code: 'invalid_email',
    });
  }

  const existingUser = await prisma.user.findUnique({ where: { email: currentEmail } });
  if (!existingUser) {
    return res.status(404).json({
      success: false,
      error: 'Account not found with this email address.',
      code: 'user_not_found',
    });
  }

  // Only unverified accounts can change verification email
  if (existingUser.emailVerifiedAt && existingUser.status === 'ACTIVE') {
    return res.status(400).json({
      success: false,
      error: 'This account email is already verified. You can sign in directly.',
      code: 'already_verified',
    });
  }

  // Check if new email is taken by another account
  const targetTaken = await prisma.user.findUnique({ where: { email: newEmail } });
  if (targetTaken) {
    return res.status(409).json({
      success: false,
      error: 'An account with this email address already exists. Please sign in or use another email.',
      code: 'email_taken',
    });
  }

  // Invalidate previous OTP codes
  await prisma.emailVerificationOtp.updateMany({
    where: {
      userId: existingUser.id,
      invalidatedAt: null,
      consumedAt: null,
    },
    data: { invalidatedAt: new Date() },
  });

  // Update user email
  const updatedUser = await prisma.user.update({
    where: { id: existingUser.id },
    data: { email: newEmail },
  });

  // Issue and send fresh OTP to new email address
  const otpRes = await createAndSendVerificationOtp(updatedUser, 'EMAIL_VERIFICATION', true);
  if (!otpRes.success) {
    const failure = otpFailureResponse(otpRes);
    return res.status(failure.status).json({
      ...failure.body,
      error: otpRes.error || 'Failed to dispatch a verification code to the updated email address.',
    });
  }

  await recordAuditLog({
    actorId: updatedUser.id,
    action: 'VERIFICATION_EMAIL_CHANGED',
    entity: 'User',
    entityId: updatedUser.id,
    metadata: { previousEmail: currentEmail, newEmail },
    req,
  });

  return res.json({
    success: true,
    message: `Destination email updated to ${newEmail}. A fresh 6-digit verification code has been sent.`,
    email: newEmail,
    cooldownSeconds: otpRes.cooldownSeconds || 60,
  });
});

// Verification status lookup endpoint
app.get(`${API_PREFIX}/auth/verification-status`, async (req: Request, res: Response) => {
  const email = String(req.query?.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, error: 'Email is required.' });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, status: true, emailVerifiedAt: true },
  });

  return res.json({
    success: true,
    email,
    verified: !!user?.emailVerifiedAt,
    status: user?.status || 'NOT_FOUND',
  });
});

// Forgot password: issue single-use secure reset token
app.post(`${API_PREFIX}/auth/forgot-password`, strictRateLimit, async (req: Request, res: Response) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ success: false, error: 'Email is required.' });

  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    const rawResetToken = generateSecureToken(32);
    await prisma.emailToken.create({
      data: {
        userId: user.id,
        type: 'RESET_PASSWORD',
        tokenHash: hashToken(rawResetToken),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });

    await sendPasswordResetEmail(user.email, rawResetToken);

    await recordAuditLog({
      actorId: user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      entity: 'User',
      entityId: user.id,
      req,
    });
  }

  return res.json({
    success: true,
    message: 'If an account exists for this email, a password reset link has been sent.',
  });
});

// Reset password with single-use token and session revocation
app.post(`${API_PREFIX}/auth/reset-password`, strictRateLimit, async (req: Request, res: Response) => {
  const { token, password } = req.body || {};
  if (!token || !password) {
    return res.status(400).json({ success: false, error: 'Token and new password are required.' });
  }

  if (!validatePasswordStrength(String(password))) {
    return res.status(400).json({
      success: false,
      error: 'Password must be at least 8 characters long.',
    });
  }

  const tokenHash = hashToken(String(token));
  const record = await prisma.emailToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!record || record.type !== 'RESET_PASSWORD') {
    return res.status(400).json({ success: false, error: 'Invalid or unrecognized reset token.' });
  }

  if (record.consumedAt) {
    return res.status(400).json({ success: false, error: 'Reset token has already been used.' });
  }

  if (record.expiresAt < new Date()) {
    return res.status(400).json({ success: false, error: 'Password reset token has expired. Please request a new one.' });
  }

  const newHash = await hashPassword(String(password));

  // Update password, mark token consumed, and revoke all existing sessions (Section 9!)
  await prisma.$transaction([
    prisma.emailToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: newHash },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await recordAuditLog({
    actorId: record.userId,
    action: 'PASSWORD_RESET',
    entity: 'User',
    entityId: record.userId,
    metadata: { reason: 'Password reset completed via token' },
    req,
  });

  return res.json({
    success: true,
    message: 'Password reset successfully. All previous sessions have been revoked. Please sign in.',
  });
});

// Change password for authenticated session
app.post(`${API_PREFIX}/auth/change-password`, requireAuth, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'Current password and new password are required.' });
  }

  if (!validatePasswordStrength(String(newPassword))) {
    return res.status(400).json({ success: false, error: 'New password must be at least 8 characters long.' });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

  const matches = await verifyPassword(String(currentPassword), user.passwordHash);
  if (!matches) {
    return res.status(400).json({ success: false, error: 'Current password does not match.' });
  }

  const newHash = await hashPassword(String(newPassword));
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash },
  });

  await recordAuditLog({
    actorId: user.id,
    action: 'PASSWORD_CHANGED',
    entity: 'User',
    entityId: user.id,
    req,
  });

  return res.json({ success: true, message: 'Password changed successfully.' });
});

// Validate route access helper
app.post(`${API_PREFIX}/auth/validate-access`, async (req: Request, res: Response) => {
  const { targetPath } = req.body || {};
  const path = String(targetPath || '/');
  const user = req.user;

  if (!user) {
    if (path === '/admin' || path === '/admin/') {
      return res.json({ authorized: true, status: 200, showLogin: true });
    }
    if (path.startsWith('/admin/media-owner')) {
      return res.status(401).json({
        authorized: false,
        status: 401,
        redirectTo: '/media/login',
        error: 'Authentication required. Please sign in to the Media Owner portal.',
      });
    }
    if (path.startsWith('/admin/agency')) {
      return res.status(401).json({
        authorized: false,
        status: 401,
        redirectTo: '/agency/login',
        error: 'Authentication required. Please sign in to your Marketing Agency workspace.',
      });
    }
    if (path.startsWith('/admin/')) {
      return res.status(401).json({
        authorized: false,
        status: 401,
        redirectTo: '/admin',
        error: 'Authentication required. Redirecting to central login.',
      });
    }
    return res.json({ authorized: true, status: 200, isPublic: true });
  }

  // Email verification check: send the user to the screen where they can enter
  // or re-request their 6-digit code instead of a generic rejection.
  if (user.status === 'PENDING_VERIFICATION' || !user.emailVerifiedAt) {
    return res.status(403).json({
      authorized: false,
      status: 403,
      requiresVerification: true,
      email: user.email,
      redirectTo: `/verify-email?email=${encodeURIComponent(user.email)}`,
      error: 'Please verify your email address to access this workspace.',
    });
  }

  // Account status check (Section 9)
  if (user.status !== 'ACTIVE') {
    return res.status(403).json({
      authorized: false,
      status: 403,
      redirectTo: user.role === 'Media Owner' ? '/media/login' : '/agency/login',
      error: `Your account is ${user.status.toLowerCase()}. Access denied.`,
    });
  }

  // Tenant status check (Section 9)
  if (req.tenant && req.tenant.status !== 'ACTIVE' && user.role !== 'Platform Admin') {
    return res.status(403).json({
      authorized: false,
      status: 403,
      redirectTo: '/agency/login',
      error: 'Your organization is pending approval or inactive.',
    });
  }

  const dashboard = getAuthorizedDashboardForRole(user.role);
  if (!dashboard) {
    return res.status(403).json({
      authorized: false,
      status: 403,
      redirectTo: '/admin',
      error: `Access Denied: Unrecognized role '${user.role}'.`,
    });
  }

  if (path === '/admin' || path === '/admin/') {
    return res.json({
      authorized: true,
      status: 200,
      alreadyAuthenticated: true,
      redirectTo: dashboard,
      user,
    });
  }

  // Check role authorization for protected dashboards
  if (user.role === 'Platform Admin') {
    return res.json({ authorized: true, status: 200, user, dashboardRoute: '/admin/platform' });
  }

  let authorized = true;
  if (path.startsWith('/admin/agency')) {
    authorized = ['Agency Admin', 'Account Manager', 'Campaign Manager', 'Operations Manager', 'Finance Manager', 'Field Manager', 'Agency Staff'].includes(user.role);
  } else if (path.startsWith('/admin/client')) {
    authorized = user.role === 'Customer / Client Company';
  } else if (path.startsWith('/admin/media-owner')) {
    authorized = user.role === 'Media Owner';
  } else if (path.startsWith('/admin/vendor')) {
    authorized = user.role === 'Vendor';
  } else if (path.startsWith('/admin/field-agent')) {
    authorized = user.role === 'Field Agent';
  } else if (path.startsWith('/admin/platform')) {
    authorized = user.role === 'Platform Admin';
  }

  if (!authorized) {
    return res.status(403).json({
      authorized: false,
      status: 403,
      redirectTo: dashboard,
      error: `Access Denied: Role '${user.role}' is not authorized for ${path}. Redirected to authorized workspace.`,
      user,
    });
  }

  return res.json({
    authorized: true,
    status: 200,
    user,
    dashboardRoute: dashboard,
  });
});

// ==========================================
// MULTI-TENANT ISOLATED ENDPOINTS (Section 5)
// ==========================================

// Get current tenant organization details
app.get(`${API_PREFIX}/tenant/me`, requireAuth, requireTenant(), async (req: Request, res: Response) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user!.tenantId! },
    include: {
      _count: {
        select: { users: true, invitations: true },
      },
    },
  });

  return res.json({ success: true, tenant });
});

// Get users in the authenticated user's organization (strictly tenant-isolated!)
app.get(`${API_PREFIX}/tenant/users`, requireAuth, requireTenant(), async (req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: { tenantId: req.user!.tenantId! },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      title: true,
      avatarUrl: true,
      status: true,
      emailVerifiedAt: true,
      createdAt: true,
      lastLoginAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({ success: true, users, count: users.length });
});

// Invite a user to join the authenticated organization (Section 16)
app.post(
  `${API_PREFIX}/tenant/invite`,
  requireAuth,
  requireTenant(),
  async (req: Request, res: Response) => {
    // Only organization admins / managers can invite
    const ALLOWED_INVITERS = ['Platform Admin', 'Agency Admin', 'Media Owner'];
    if (!ALLOWED_INVITERS.includes(req.user!.role)) {
      return res.status(403).json({
        success: false,
        error: 'Only organization administrators can invite new members.',
      });
    }

    const { email, role } = req.body || {};
    if (!email || !role) {
      return res.status(400).json({ success: false, error: 'Email and role are required for invitation.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const rawInviteToken = generateSecureToken(32);
    const tokenHash = hashToken(rawInviteToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invitation = await prisma.invitation.create({
      data: {
        email: normalizedEmail,
        role: String(role),
        tenantId: req.user!.tenantId!,
        tokenHash,
        expiresAt,
        invitedById: req.user!.id,
      },
      include: { tenant: true },
    });

    await sendInvitationEmail(normalizedEmail, invitation.tenant.name, invitation.role, rawInviteToken);

    await recordAuditLog({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      tenantId: req.user!.tenantId,
      action: 'INVITATION_CREATED',
      entity: 'Invitation',
      entityId: invitation.id,
      metadata: { invitedEmail: normalizedEmail, role },
      req,
    });

    return res.status(201).json({
      success: true,
      message: `Invitation generated for ${normalizedEmail}.`,
      invitationId: invitation.id,
      // A raw invitation token is a key into the organization. It is handed back in
      // development only, for test convenience; in production it travels solely in
      // the email, so it cannot end up in a client log, a proxy cache or a screenshot.
      ...(process.env.NODE_ENV !== 'production' ? { inviteToken: rawInviteToken } : {}),
    });
  }
);

// Get audit logs for the organization (tenant-isolated!)
app.get(
  `${API_PREFIX}/tenant/audit-logs`,
  requireAuth,
  requireTenant(),
  async (req: Request, res: Response) => {
    const isPlatformAdmin = req.user!.role === 'Platform Admin';

    const logs = await prisma.auditLog.findMany({
      where: isPlatformAdmin ? {} : { tenantId: req.user!.tenantId! },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return res.json({ success: true, logs });
  }
);

// Global Error Handler
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  // The real cause — message, driver code, stack — stays in the runtime log.
  console.error(
    `[ADGRID Error] ${req.method} ${req.originalUrl}`,
    err?.code ? `(${err.code})` : '',
    err?.message || err,
    err?.stack || ''
  );

  res.status(err?.status || 500).json({
    success: false,
    error: GENERIC_SERVER_ERROR_MESSAGE,
    code: 'internal_error',
  });
});

export async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ADGRID Platform Server running on http://0.0.0.0:${PORT}`);

    // Startup diagnostics: email verification and password resets are only
    // deliverable when a provider is configured. Say so loudly instead of
    // letting users discover it through missing codes.
    if (isEmailDeliveryConfigured()) {
      console.log('[Email Service] Resend configured - transactional email is live.');
    } else if (process.env.NODE_ENV === 'production') {
      console.error(
        '[Email Service] ERROR: RESEND_API_KEY/RESEND_FROM_EMAIL are not configured. ' +
          'Signup verification codes and password reset emails will fail.'
      );
    } else {
      console.log(
        '[Email Service] Development mode: emails are printed to this console and stored in the ' +
          `dev outbox (GET ${API_PREFIX}/auth/dev-last-otp?email=...).`
      );
    }

    if (SKIP_EMAIL_VERIFICATION) {
      console.warn(
        '[Auth] ⚠️ DEV MODE: SKIP_EMAIL_VERIFICATION is enabled. Signups and logins auto-verify immediately without OTP.'
      );
    }

    console.log(
      `[Database] Prisma using ${process.env.PRISMA_DRIVER_ADAPTER === 'pg' ? 'pg driver adapter (local Postgres)' : 'DATABASE_URL connection'}`
    );
  });
}

export default app;
