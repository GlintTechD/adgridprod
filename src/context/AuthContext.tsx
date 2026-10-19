import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  UserAccount,
  UserRole,
  MarketplaceBillboard,
  SignupParams,
  SignupResult,
  TenantAccount,
} from '../types';
import { SignInModal } from '../components/common/SignInModal';

/**
 * Copy an auth screen is allowed to display.
 *
 * 4xx bodies hold guidance written for the user ("Invalid credentials", "Enter the
 * 6-digit code"). Anything at 500 or above is an internal failure, and its wording
 * belongs in the runtime log only: a sign-in or sign-up form that repeats what the
 * database or a dependency said is a free description of the stack for anyone
 * probing it. For those we return undefined so the caller renders its own fixed
 * sentence ("Sign up failed." / "Authentication failed.").
 */
function safeError(response: { status: number }, data: any): string | undefined {
  if (!response || response.status >= 500) {
    return undefined;
  }
  const message = typeof data?.error === 'string' ? data.error.trim() : '';
  return message || undefined;
}

/** Same rule for informational copy. */
function safeMessage(response: { status: number }, data: any): string | undefined {
  if (!response || response.status >= 500) {
    return undefined;
  }
  const message = typeof data?.message === 'string' ? data.message.trim() : '';
  return message || undefined;
}

export interface SignInModalOptions {
  title?: string;
  reason?: string;
  targetRole?: string;
  onSuccess?: () => void;
}

export interface RouteValidationResult {
  authorized: boolean;
  status: number;
  redirectTo?: string;
  error?: string;
  user?: UserAccount;
  /** The route is gated on an unverified email address. */
  requiresVerification?: boolean;
}

export interface LoginResult {
  success: boolean;
  status?: string;
  mfaRequired?: boolean;
  mfaToken?: string;
  /** The account exists but its email address is not verified yet. */
  requiresVerification?: boolean;
  /** Verification code could not be delivered; the user can request another. */
  deliveryFailed?: boolean;
  email?: string;
  cooldownSeconds?: number;
  user?: UserAccount;
  redirectTo?: string;
  error?: string;
  message?: string;
}

export interface AuthContextType {
  currentUser: UserAccount | null;
  tenant: TenantAccount | null;
  role: UserRole | null;
  permissions: string[];
  isAuthenticated: boolean;
  isLoading: boolean;
  token: string | null;
  login: (email: string, password?: string, portalType?: 'media' | 'agency' | 'central') => Promise<LoginResult>;
  signup: (params: SignupParams) => Promise<SignupResult>;
  signupAgency: (params: {
    agencyName: string;
    ownerFullName: string;
    email: string;
    password: string;
    phone?: string;
    city?: string;
    country?: string;
    notes?: string;
  }) => Promise<SignupResult>;
  signupMediaOwner: (params: {
    name: string;
    email: string;
    password: string;
    organization: string;
    city?: string;
    country?: string;
    licenseNumber?: string;
    title?: string;
  }) => Promise<SignupResult>;
  acceptInvitation: (params: {
    token: string;
    name?: string;
    password: string;
    phone?: string;
    title?: string;
  }) => Promise<LoginResult>;
  getInvitationInfo: (token: string) => Promise<{
    valid: boolean;
    email?: string;
    role?: string;
    tenantName?: string;
    error?: string;
  }>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
  verifyMFA: (mfaToken: string, code: string) => Promise<LoginResult>;
  /** Complete an emailed 6-digit code. Signs the session in on success. */
  verifyOtp: (email: string, code: string) => Promise<LoginResult>;
  resendOtp: (email: string) => Promise<{ success: boolean; message?: string; error?: string; cooldownSeconds?: number; alreadyVerified?: boolean }>;
  changeVerificationEmail: (currentEmail: string, newEmail: string) => Promise<{ success: boolean; message?: string; error?: string; email?: string; cooldownSeconds?: number }>;
  verifyEmail: (token: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  resendVerification: (email?: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  requestPasswordReset: (email: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  resetPassword: (token: string, password: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  validateRoute: (path: string) => Promise<RouteValidationResult>;
  activePurchaseBillboard: MarketplaceBillboard | null;
  setActivePurchaseBillboard: (billboard: MarketplaceBillboard | null) => void;
  openSignInModal: (options?: SignInModalOptions) => void;
  closeSignInModal: () => void;
  requireAuth: (action: () => void, options?: SignInModalOptions) => boolean;
  subscribedAlertIds: string[];
  isSubscribedToBillboard: (billboardId: string) => boolean;
  subscribeToBillboardAlert: (billboard: MarketplaceBillboard, options?: { noticeDays?: number; alertType?: string; email?: string }) => Promise<{ success: boolean; message?: string }>;
  unsubscribeFromBillboardAlert: (billboardId: string) => Promise<{ success: boolean; message?: string }>;
  refreshAlertSubscriptions: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [tenant, setTenant] = useState<TenantAccount | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('adgrid_token'));
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [activePurchaseBillboard, setActivePurchaseBillboard] = useState<MarketplaceBillboard | null>(null);
  // Sign In Popup Modal State
  const [signInModalState, setSignInModalState] = useState<{
    isOpen: boolean;
    title?: string;
    reason?: string;
    targetRole?: string;
    onSuccess?: () => void;
  }>({ isOpen: false });

  // Subscribed Billboard Availability Alerts State
  const [subscribedAlertIds, setSubscribedAlertIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('adgrid_subscribed_alerts');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const openSignInModal = useCallback((options?: SignInModalOptions) => {
    setSignInModalState({
      isOpen: true,
      title: options?.title || 'Sign In to ADGRID',
      reason: options?.reason,
      targetRole: options?.targetRole || 'Agency Admin',
      onSuccess: options?.onSuccess,
    });
  }, []);

  const closeSignInModal = useCallback(() => {
    setSignInModalState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const requireAuth = useCallback(
    (action: () => void, options?: SignInModalOptions): boolean => {
      if (currentUser) {
        action();
        return true;
      }
      openSignInModal({ ...options, onSuccess: action });
      return false;
    },
    [currentUser, openSignInModal]
  );

  // Sync token with storage
  useEffect(() => {
    if (token) {
      localStorage.setItem('adgrid_token', token);
      localStorage.setItem('adgrid_access_token', token);
    } else {
      localStorage.removeItem('adgrid_token');
      localStorage.removeItem('adgrid_access_token');
    }
  }, [token]);

  // Attempt to refresh the session token via rotation
  const refreshSession = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) return false;

      const data = await response.json();
      if (data.success && data.token && data.user) {
        setToken(data.token);
        setCurrentUser(data.user);
        if (data.user.tenant) {
          setTenant(data.user.tenant);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  // Initialize and verify session on application mount
  useEffect(() => {
    let isMounted = true;

    const initializeSession = async () => {
      setIsLoading(true);
      const storedToken = localStorage.getItem('adgrid_token');

      if (storedToken) {
        try {
          const response = await fetch('/api/auth/me', {
            headers: { Authorization: `Bearer ${storedToken}` },
          });

          if (response.ok) {
            const data = await response.json();
            if (isMounted && data.authenticated && data.user) {
              setCurrentUser(data.user);
              setTenant(data.tenant || data.user.tenant || null);
              setIsLoading(false);
              return;
            }
          }
        } catch {
          // Token expired or invalid, try refresh
        }
      }

      // Try rotating refresh cookie if available
      const refreshed = await refreshSession();
      if (!refreshed && isMounted) {
        setToken(null);
        setCurrentUser(null);
        setTenant(null);
      }

      if (isMounted) {
        setIsLoading(false);
      }
    };

    initializeSession();

    return () => {
      isMounted = false;
    };
  }, [refreshSession]);

  // Login handler
  const login = async (
    email: string,
    password?: string,
    portalType?: 'media' | 'agency' | 'central'
  ): Promise<LoginResult> => {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, portalType }),
      });

      const data = await response.json();

      if (data.status === 'MFA_REQUIRED') {
        return {
          success: true,
          status: 'MFA_REQUIRED',
          mfaRequired: true,
          mfaToken: data.mfaToken,
        };
      }

      if (response.ok && data.success && data.token && data.user) {
        setToken(data.token);
        setCurrentUser(data.user);
        setTenant(data.tenant || data.user.tenant || null);
        return {
          success: true,
          user: data.user,
          redirectTo: data.redirectTo || data.user.authorizedDashboard || '/admin/agency',
        };
      }

      return {
        success: false,
        error: safeError(response, data) || 'Authentication failed. Please verify your email and password.',
      };
    } catch {
      return {
        success: false,
        error: 'Unable to connect to authentication server. Please check your network.',
      };
    }
  };

  // MFA verification during login challenge
  const verifyMFA = async (mfaToken: string, code: string): Promise<LoginResult> => {
    try {
      const response = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfaToken, code: code.trim() }),
      });

      const data = await response.json();
      if (response.ok && data.success && data.token && data.user) {
        setToken(data.token);
        setCurrentUser(data.user);
        setTenant(data.tenant || data.user.tenant || null);
        return {
          success: true,
          user: data.user,
          redirectTo: data.redirectTo || data.user.authorizedDashboard,
        };
      }

      return {
        success: false,
        error: safeError(response, data) || 'Invalid authenticator code. Please try again.',
      };
    } catch {
      return {
        success: false,
        error: 'MFA service unavailable. Please try again.',
      };
    }
  };

  // Sign up handler (generic)
  const signup = async (params: SignupParams): Promise<SignupResult> => {
    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      const responseBody = await response.text();
      let data: any = {};
      try {
        data = responseBody ? JSON.parse(responseBody) : {};
      } catch {
        return {
          success: false,
          error: 'Sign up failed. Please try again.',
        };
      }

      // The account may have been created even though the verification email
      // could not be delivered. In that case the user must still reach the
      // verification screen (where they can request a new code) rather than
      // being left with an error and no way forward.
      if (!response.ok) {
        if (data.requiresVerification && data.email) {
          return {
            success: false,
            requiresVerification: true,
            deliveryFailed: true,
            email: data.email,
            cooldownSeconds: data.cooldownSeconds || 0,
            error:
              safeError(response, data) ||
              'Your account was created, but we could not send the verification email. Use "Resend code" to try again.',
          };
        }

        return {
          success: false,
          error: safeError(response, data) || 'Sign up failed. Please try again.',
        };
      }

      if (data.requiresVerification) {
        return {
          success: true,
          requiresVerification: true,
          email: data.email || params.email.trim(),
          cooldownSeconds: data.cooldownSeconds || 60,
          message: data.message || 'Verification code sent to your email.',
        };
      }

      if (data.pendingApproval) {
        return {
          success: true,
          pendingApproval: true,
          message: data.message || 'Application submitted. Your agency is awaiting approval.',
        };
      }

      if (response.ok && data.success && data.token && data.user) {
        setToken(data.token);
        setCurrentUser(data.user);
        setTenant(data.tenant || data.user.tenant || null);
        return {
          success: true,
          user: data.user,
          redirectTo: data.redirectTo || data.user.authorizedDashboard || '/admin/media-owner',
        };
      }

      return {
        success: false,
        error: safeError(response, data) || 'Registration failed. Please check your inputs.',
      };
    } catch {
      return {
        success: false,
        error: 'Registration server error. Please check your connection.',
      };
    }
  };

  // Marketing Agency registration handler (Section 3: PENDING approval by Media Owner)
  const signupAgency = async (params: {
    agencyName: string;
    ownerFullName: string;
    email: string;
    password: string;
    phone?: string;
    city?: string;
    country?: string;
    notes?: string;
  }): Promise<SignupResult> => {
    try {
      const response = await fetch('/api/auth/register-agency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      const data = await response.json();

      // A 503 means the agency record was created but the verification email
      // could not be delivered yet: still route the owner to verification.
      if (!response.ok) {
        if (data.requiresVerification && data.email) {
          return {
            success: false,
            pendingApproval: true,
            requiresVerification: true,
            deliveryFailed: true,
            email: data.email,
            cooldownSeconds: 0,
            error:
              safeError(response, data) ||
              'Your application was submitted, but we could not send the verification email. Use "Resend code" to try again.',
          };
        }

        return {
          success: false,
          error: safeError(response, data) || 'Sign up failed. Please try again.',
        };
      }

      if (response.ok && data.success && data.token && data.user) {
        setToken(data.token);
        setCurrentUser(data.user);
        setTenant(data.user.tenant || null);
        return {
          success: true,
          user: data.user,
          redirectTo: data.redirectTo || '/admin/agency',
        };
      }

      if (response.ok && data.success) {
        return {
          success: true,
          pendingApproval: true,
          message: data.message || 'Application submitted. Your agency is awaiting approval.',
        };
      }

      return {
        success: false,
        error: safeError(response, data) || 'Failed to submit agency registration.',
      };
    } catch {
      return {
        success: false,
        error: 'Registration server error. Please check your network connection.',
      };
    }
  };

  // Media Owner registration handler (Section 1: creates ACTIVE concessionaire)
  const signupMediaOwner = async (params: {
    name: string;
    email: string;
    password: string;
    organization: string;
    city?: string;
    country?: string;
    licenseNumber?: string;
    title?: string;
  }): Promise<SignupResult> => {
    try {
      const response = await fetch('/api/auth/register-media-owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      const data = await response.json();

      // Account created but the verification email could not be delivered yet.
      if (!response.ok) {
        if (data.requiresVerification && data.email) {
          return {
            success: false,
            requiresVerification: true,
            deliveryFailed: true,
            email: data.email,
            cooldownSeconds: 0,
            error:
              safeError(response, data) ||
              'Your account was created, but we could not send the verification email. Use "Resend code" to try again.',
          };
        }

        return {
          success: false,
          error: safeError(response, data) || 'Sign up failed. Please try again.',
        };
      }

      if (data.requiresVerification) {
        return {
          success: true,
          requiresVerification: true,
          email: data.email || params.email.trim(),
          cooldownSeconds: data.cooldownSeconds || 60,
          message: data.message || 'Verification code sent to your email.',
        };
      }

      if (response.ok && data.success && data.token && data.user) {
        setToken(data.token);
        setCurrentUser(data.user);
        setTenant(data.user.tenant || null);
        return {
          success: true,
          user: data.user,
          redirectTo: '/admin/media-owner',
        };
      }

      return {
        success: false,
        error: safeError(response, data) || 'Media Owner registration failed.',
      };
    } catch {
      return {
        success: false,
        error: 'Registration server error. Please check your network connection.',
      };
    }
  };

  // Invitation info inspector (Section 10)
  const getInvitationInfo = async (tokenString: string) => {
    try {
      const response = await fetch(`/api/auth/invitation-info?token=${encodeURIComponent(tokenString)}`);
      const data = await response.json();
      return {
        valid: response.ok && !!data.valid,
        email: data.email,
        role: data.role,
        tenantName: data.tenantName,
        error: safeError(response, data),
      };
    } catch {
      return { valid: false, error: 'Could not connect to invitation service.' };
    }
  };

  // Accept invitation handler (Section 7, 8 & 10)
  const acceptInvitation = async (params: {
    token: string;
    name?: string;
    password: string;
    phone?: string;
    title?: string;
  }): Promise<LoginResult> => {
    try {
      const response = await fetch('/api/auth/accept-invitation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      const data = await response.json();

      if (response.ok && data.success && data.token && data.user) {
        setToken(data.token);
        setCurrentUser(data.user);
        setTenant(data.user.tenant || null);
        return {
          success: true,
          user: data.user,
          redirectTo: data.redirectTo || data.user.authorizedDashboard,
        };
      }

      return {
        success: false,
        error: safeError(response, data) || 'Failed to accept invitation.',
      };
    } catch {
      return {
        success: false,
        error: 'Unable to connect to server. Please try again.',
      };
    }
  };

  // Logout handler
  const logout = async (): Promise<void> => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      // ignore
    } finally {
      setToken(null);
      setCurrentUser(null);
      setTenant(null);
      localStorage.removeItem('adgrid_token');
      localStorage.removeItem('adgrid_access_token');
      localStorage.removeItem('adgrid_user');
    }
  };

  // Logout all sessions handler
  const logoutAll = async (): Promise<void> => {
    try {
      await fetch('/api/auth/logout-all', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      // ignore
    } finally {
      setToken(null);
      setCurrentUser(null);
      setTenant(null);
      localStorage.removeItem('adgrid_token');
      localStorage.removeItem('adgrid_access_token');
      localStorage.removeItem('adgrid_user');
    }
  };

  // Email verification
  const verifyOtp = async (email: string, code: string): Promise<LoginResult> => {
    try {
      const response = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), code: code.trim() }),
      });

      const data = await response.json();
      if (response.ok && data.success) {
        if (data.pendingApproval) {
          return {
            success: true,
            status: 'PENDING',
            message: data.message,
            redirectTo: '/agency/login',
          };
        }

        if (data.token && data.user) {
          setToken(data.token);
          setCurrentUser(data.user);
          setTenant(data.tenant || data.user.tenant || null);
          return {
            success: true,
            user: data.user,
            redirectTo: data.redirectTo || data.user.authorizedDashboard || '/admin',
            message: data.message,
          };
        }
      }

      return {
        success: false,
        error: safeError(response, data) || 'Verification failed. Please check the code and try again.',
      };
    } catch {
      return {
        success: false,
        error: 'Unable to connect to verification server. Please check your network.',
      };
    }
  };

  // Resend 6-digit OTP code
  const resendOtp = async (email: string) => {
    try {
      const res = await fetch('/api/auth/resend-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = await res.json();
      return {
        success: res.ok && data.success,
        message: data.message,
        error: safeError(res, data),
        cooldownSeconds: data.cooldownSeconds,
        alreadyVerified: data.alreadyVerified,
      };
    } catch {
      return { success: false, error: 'Failed to request new verification code.' };
    }
  };

  // Change unverified email address and request fresh 6-digit OTP
  const changeVerificationEmail = async (currentEmail: string, newEmail: string) => {
    try {
      const res = await fetch('/api/auth/change-verification-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentEmail: currentEmail.trim().toLowerCase(),
          newEmail: newEmail.trim().toLowerCase(),
        }),
      });
      const data = await res.json();
      return {
        success: res.ok && data.success,
        message: data.message,
        error: safeError(res, data),
        email: data.email,
        cooldownSeconds: data.cooldownSeconds,
      };
    } catch {
      return { success: false, error: 'Failed to update email address. Please check your connection.' };
    }
  };

  // Check verification status
  const checkVerificationStatus = async (email: string) => {
    try {
      const res = await fetch(`/api/auth/verification-status?email=${encodeURIComponent(email.trim().toLowerCase())}`);
      const data = await res.json();
      return { verified: !!data.verified, email: data.email, status: data.status };
    } catch {
      return { verified: false, email };
    }
  };

  // Email verification (supports token string or { email, code } object)
  const verifyEmail = async (verifyToken: string) => {
    try {
      const res = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: verifyToken }),
      });
      const data = await res.json();
      return { success: res.ok && data.success, message: safeMessage(res, data), error: safeError(res, data) };
    } catch {
      return { success: false, error: 'Verification service error.' };
    }
  };

  // Resend email verification
  const resendVerification = async (email?: string) => {
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ email: email || currentUser?.email }),
      });
      const data = await res.json();
      return { success: res.ok && data.success, message: safeMessage(res, data), error: safeError(res, data) };
    } catch {
      return { success: false, error: 'Service error.' };
    }
  };

  // Password reset request
  const requestPasswordReset = async (email: string) => {
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      return { success: res.ok && data.success, message: safeMessage(res, data), error: safeError(res, data) };
    } catch {
      return { success: false, error: 'Service error.' };
    }
  };

  // Password reset execution
  const resetPassword = async (resetToken: string, newPassword: string) => {
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: newPassword }),
      });
      const data = await res.json();
      return { success: res.ok && data.success, message: safeMessage(res, data), error: safeError(res, data) };
    } catch {
      return { success: false, error: 'Service error.' };
    }
  };

  // Password change execution
  const changePassword = async (currentPassword: string, newPassword: string) => {
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      return { success: res.ok && data.success, message: safeMessage(res, data), error: safeError(res, data) };
    } catch {
      return { success: false, error: 'Service error.' };
    }
  };

  const validateRoute = async (path: string): Promise<RouteValidationResult> => {
    try {
      const response = await fetch('/api/auth/validate-access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ targetPath: path }),
      });

      const data = await response.json();
      return {
        authorized: !!data.authorized,
        status: data.status || response.status,
        redirectTo: data.redirectTo,
        error: safeError(response, data),
        requiresVerification: !!data.requiresVerification,
        user: data.user,
      };
    } catch {
      // Fail closed for protected routes when network fails
      if (path.startsWith('/admin/')) {
        return {
          authorized: false,
          status: 401,
          redirectTo: '/admin',
          error: 'Connection to authentication gateway failed.',
        };
      }
      return { authorized: true, status: 200 };
    }
  };

  // Availability Alert Sync
  const refreshAlertSubscriptions = useCallback(async () => {
    const activeToken = localStorage.getItem('adgrid_access_token') || localStorage.getItem('adgrid_token');
    if (!activeToken) return;
    try {
      const res = await fetch('/api/billboards/alerts/mine', {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.billboardIds)) {
          setSubscribedAlertIds(data.billboardIds);
          localStorage.setItem('adgrid_subscribed_alerts', JSON.stringify(data.billboardIds));
        }
      }
    } catch {
      // ignore network errors
    }
  }, []);

  useEffect(() => {
    if (currentUser) {
      refreshAlertSubscriptions();
    } else {
      setSubscribedAlertIds([]);
      localStorage.removeItem('adgrid_subscribed_alerts');
    }
  }, [currentUser, refreshAlertSubscriptions]);

  const isSubscribedToBillboard = useCallback(
    (billboardId: string) => {
      return subscribedAlertIds.includes(billboardId);
    },
    [subscribedAlertIds]
  );

  const subscribeToBillboardAlert = useCallback(
    async (
      billboard: MarketplaceBillboard,
      options?: { noticeDays?: number; alertType?: string; email?: string }
    ) => {
      const activeToken = localStorage.getItem('adgrid_access_token') || localStorage.getItem('adgrid_token');
      if (!activeToken || !currentUser) {
        return { success: false, message: 'Please sign in to subscribe to availability alerts.' };
      }

      try {
        const res = await fetch(`/api/billboards/${billboard.id}/notify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${activeToken}`,
          },
          body: JSON.stringify({
            billboardName: billboard.name,
            noticeDays: options?.noticeDays || 14,
            alertType: options?.alertType || 'AVAILABLE_SOON',
            email: options?.email || currentUser.email,
          }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          setSubscribedAlertIds((prev) => {
            const next = Array.from(new Set([...prev, billboard.id]));
            localStorage.setItem('adgrid_subscribed_alerts', JSON.stringify(next));
            return next;
          });
          return { success: true, message: data.message };
        }
        return { success: false, message: safeError(res, data) || 'Failed to subscribe to alerts.' };
      } catch (err: any) {
        return { success: false, message: err.message || 'Network error' };
      }
    },
    [currentUser]
  );

  const unsubscribeFromBillboardAlert = useCallback(
    async (billboardId: string) => {
      const activeToken = localStorage.getItem('adgrid_access_token') || localStorage.getItem('adgrid_token');
      if (!activeToken) return { success: false };
      try {
        const res = await fetch(`/api/billboards/${billboardId}/notify`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${activeToken}` },
        });
        const data = await res.json();
        setSubscribedAlertIds((prev) => {
          const next = prev.filter((id) => id !== billboardId);
          localStorage.setItem('adgrid_subscribed_alerts', JSON.stringify(next));
          return next;
        });
        return { success: true, message: data.message };
      } catch (err: any) {
        return { success: false, message: err.message };
      }
    },
    []
  );

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        tenant,
        role: (currentUser?.role as UserRole) || null,
        permissions: currentUser?.permissions || [],
        isAuthenticated: !!currentUser,
        isLoading,
        token,
        login,
        signup,
        signupAgency,
        signupMediaOwner,
        acceptInvitation,
        getInvitationInfo,
        logout,
        logoutAll,
        refreshSession,
        verifyMFA,
        verifyEmail,
        resendVerification,
        verifyOtp,
        resendOtp,
        changeVerificationEmail,
        requestPasswordReset,
        resetPassword,
        changePassword,
        validateRoute,
        activePurchaseBillboard,
        setActivePurchaseBillboard,
        openSignInModal,
        closeSignInModal,
        requireAuth,
        subscribedAlertIds,
        isSubscribedToBillboard,
        subscribeToBillboardAlert,
        unsubscribeFromBillboardAlert,
        refreshAlertSubscriptions,
      }}
    >
      {children}
      <SignInModal
        isOpen={signInModalState.isOpen}
        title={signInModalState.title}
        reason={signInModalState.reason}
        targetRole={signInModalState.targetRole}
        onClose={closeSignInModal}
        onSuccess={signInModalState.onSuccess}
      />
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
