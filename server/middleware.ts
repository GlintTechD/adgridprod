import { NextFunction, Request, Response } from 'express';
import { prisma } from './db';
import { resolvePermissionsForRole, verifyAccessToken } from './auth';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string | null;
  status: string;
  /** Timestamp of the confirmed email address, or null when it is still unverified. */
  emailVerifiedAt: Date | null;
  permissions: string[];
  organization?: string;
}

export interface AuthenticatedTenant {
  id: string;
  name: string;
  type: string;
  status: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      tenant?: AuthenticatedTenant | null;
    }
  }
}

// Authentication middleware: resolves identity from JWT
export async function authenticateRequest(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let token: string | null = null;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (req.cookies && req.cookies.access_token) {
      token = req.cookies.access_token;
    }

    if (!token) {
      return next();
    }

    const decoded = verifyAccessToken(token);
    if (!decoded || !decoded.sub) {
      return next();
    }

    // Resolve user from database
    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      include: { tenant: true },
    });

    if (!user) {
      return next();
    }

    // Check account status (Section 9)
    if (user.status !== 'ACTIVE') {
      return next();
    }

    // Check organization tenant status (Section 9)
    if (user.tenant && user.tenant.status !== 'ACTIVE' && user.role !== 'Platform Admin') {
      return next();
    }

    const permissions = await resolvePermissionsForRole(user.role);

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      permissions,
      organization: user.tenant?.name || undefined,
    };

    if (user.tenant) {
      req.tenant = {
        id: user.tenant.id,
        name: user.tenant.name,
        type: user.tenant.type,
        status: user.tenant.status,
      };
    } else {
      req.tenant = null;
    }

    next();
  } catch (error) {
    console.error('Error in authenticateRequest middleware:', error);
    next();
  }
}

/**
 * Express 4 never forwards a rejected promise from an `async` handler to the error
 * middleware. The response simply hangs, and the rejection becomes an
 * unhandledRejection — which by default terminates Node. One database error would
 * therefore take down every concurrent request on the instance, and on serverless
 * that is reported as a generic FUNCTION_INVOCATION_FAILED against routes that
 * never touch the database.
 *
 * Wrapping the registration methods once covers the handlers in this codebase
 * without editing each of them: any async handler (or async middleware) that throws
 * is routed to `next(error)`, so the client gets a 500 JSON and the process lives.
 *
 * Must be called before routes are registered on the target.
 */
const ROUTE_REGISTRATION_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head', 'use'] as const;

export function forwardAsyncErrors(target: any): void {
  for (const method of ROUTE_REGISTRATION_METHODS) {
    const original = target[method];
    if (typeof original !== 'function') {
      continue;
    }

    target[method] = function (this: unknown, ...args: any[]) {
      return original.apply(
        this,
        args.map((arg) => {
          if (typeof arg !== 'function' || arg.constructor?.name !== 'AsyncFunction') {
            return arg;
          }

          return (req: Request, res: Response, next: NextFunction) => {
            const result = arg(req, res, next);

            if (result && typeof result.then === 'function') {
              // Consume the rejection so it never reaches the process handler.
              result.then(undefined, (error: unknown) => {
                const failure = error as { message?: string };
                if (res.headersSent) {
                  console.error('[ADGRID RouteError] after the response was sent:', failure?.message || error);
                  return;
                }
                next(error);
              });
            }

            return result;
          };
        })
      );
    };
  }
}

/**
 * Copy returned to clients when a request fails for a reason that is not their
 * fault (or is not safe to describe). Nothing here reveals what broke.
 */
export const GENERIC_SERVER_ERROR_MESSAGE = 'Request failed. Please try again.';

/**
 * Reports an unexpected server-side failure: the real cause goes to the runtime
 * log, the client gets fixed copy.
 *
 * Handlers used to write `res.status(500).json({ error: error.message })`, which
 * puts driver text, SQL fragments, table names, model paths and connection strings
 * on the wire. On a sign-in or sign-up form that is a free description of the
 * stack for anyone probing it. Call this instead of formatting the error yourself.
 */
export function sendInternalError(res: Response, error: unknown, copy?: string): Response {
  const failure = error as { code?: string | number; message?: string; stack?: string } | undefined;

  console.error(
    `[ADGRID Error] ${failure?.code ? `(${failure.code}) ` : ''}${failure?.message || failure}`,
    failure?.stack ? `\n${failure.stack}` : ''
  );

  return res.status(500).json({
    success: false,
    error: copy || GENERIC_SERVER_ERROR_MESSAGE,
    code: 'internal_error',
  });
}

// Reusable guard requiring authenticated session
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please sign in.',
      code: 'unauthenticated',
    });
  }
  next();
}

// Role guard helper
export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required.',
        code: 'unauthenticated',
      });
    }

    // Platform Admin has global override
    if (req.user.role === 'Platform Admin') {
      return next();
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Access Denied: Role '${req.user.role}' is not authorized for this resource.`,
        code: 'forbidden',
        requiredRoles: allowedRoles,
      });
    }

    next();
  };
}

// Granular permission guard helper
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required.',
        code: 'unauthenticated',
      });
    }

    if (req.user.role === 'Platform Admin') {
      return next();
    }

    if (!req.user.permissions.includes(permission)) {
      return res.status(403).json({
        success: false,
        error: `Access Denied: Missing permission '${permission}'.`,
        code: 'insufficient_permissions',
        requiredPermission: permission,
      });
    }

    next();
  };
}

// Strict tenant isolation guard helper
// Ensures a user can never access or modify another organization's records
export function requireTenant(
  getResourceTenantId?: (req: Request) => string | undefined | null
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required.',
        code: 'unauthenticated',
      });
    }

    // Platform Admins can manage cross-tenant records
    if (req.user.role === 'Platform Admin') {
      return next();
    }

    if (!req.user.tenantId) {
      return res.status(403).json({
        success: false,
        error: 'User is not assigned to any active organization.',
        code: 'no_tenant',
      });
    }

    if (getResourceTenantId) {
      const targetTenantId = getResourceTenantId(req);
      if (targetTenantId && targetTenantId !== req.user.tenantId) {
        return res.status(403).json({
          success: false,
          error: 'Access Denied: Tenant boundary violation. You cannot access another organization’s data.',
          code: 'tenant_isolation_violation',
        });
      }
    }

    next();
  };
}
