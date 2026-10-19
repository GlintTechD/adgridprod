import React, { useState, useEffect, useRef } from 'react';
import {
  ShieldCheck,
  Mail,
  Loader2,
  ArrowLeft,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Edit2,
  Sparkles,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface VerifyEmailPageProps {
  initialEmail?: string;
  onSuccessRedirect?: (dashboardUrl: string) => void;
  onNavigateTo?: (path: string) => void;
  onBackToSignIn?: () => void;
}

export const VerifyEmailPage: React.FC<VerifyEmailPageProps> = ({
  initialEmail = '',
  onSuccessRedirect,
  onNavigateTo,
  onBackToSignIn,
}) => {
  const { verifyOtp, resendOtp, changeVerificationEmail } = useAuth();

  // Extract email from query parameter or prop
  const [email, setEmail] = useState<string>(() => {
    if (initialEmail) return initialEmail;
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('email') || '';
    }
    return '';
  });

  const [otp, setOtp] = useState<string[]>(['', '', '', '', '', '']);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState<number>(60);
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [newEmailInput, setNewEmailInput] = useState('');

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Focus first input box on mount
  useEffect(() => {
    if (inputRefs.current[0]) {
      inputRefs.current[0].focus();
    }
  }, []);

  // Cooldown countdown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  // Mask email for privacy: e.g. akannipromise1@gmail.com -> ak***1@gmail.com
  const maskEmail = (raw: string) => {
    if (!raw || !raw.includes('@')) return raw;
    const [local, domain] = raw.split('@');
    if (local.length <= 2) return `${local[0]}***@${domain}`;
    const first = local.slice(0, 2);
    const last = local.slice(-1);
    return `${first}***${last}@${domain}`;
  };

  const handleInputChange = (index: number, value: string) => {
    // Only accept numeric digits
    const cleaned = value.replace(/\D/g, '');
    if (!cleaned && value !== '') return;

    const newOtp = [...otp];
    newOtp[index] = cleaned ? cleaned.slice(-1) : '';
    setOtp(newOtp);
    setErrorMessage(null);

    // Auto-advance focus to next input
    if (cleaned && index < 5 && inputRefs.current[index + 1]) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit if all 6 digits are filled
    const fullCode = newOtp.join('');
    if (fullCode.length === 6) {
      void handleVerifyCode(fullCode);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!otp[index] && index > 0 && inputRefs.current[index - 1]) {
        inputRefs.current[index - 1]?.focus();
        const newOtp = [...otp];
        newOtp[index - 1] = '';
        setOtp(newOtp);
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pastedData) return;

    const digits = pastedData.split('');
    const newOtp = ['', '', '', '', '', ''];
    digits.forEach((digit, idx) => {
      if (idx < 6) newOtp[idx] = digit;
    });
    setOtp(newOtp);
    setErrorMessage(null);

    // Focus the box after the last pasted digit
    const nextIdx = Math.min(digits.length, 5);
    inputRefs.current[nextIdx]?.focus();

    if (pastedData.length === 6) {
      void handleVerifyCode(pastedData);
    }
  };

  const handleVerifyCode = async (codeToVerify?: string) => {
    const code = codeToVerify || otp.join('');
    setErrorMessage(null);

    if (code.length !== 6) {
      setErrorMessage('Please enter all 6 digits of the verification code.');
      return;
    }

    if (!email) {
      setErrorMessage('Please provide the email address associated with your account.');
      setIsEditingEmail(true);
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await verifyOtp(email, code);

      if (result.success) {
        setSuccessMessage('Email verified successfully! Redirecting...');
        setTimeout(() => {
          if (onSuccessRedirect) {
            onSuccessRedirect(result.redirectTo || '/admin');
          } else if (onNavigateTo) {
            onNavigateTo(result.redirectTo || '/admin');
          } else {
            window.location.href = result.redirectTo || '/admin';
          }
        }, 800);
      } else {
        setErrorMessage(result.error || 'Invalid code. Please try again.');
        // Clear inputs on failed attempt for fast retry
        setOtp(['', '', '', '', '', '']);
        inputRefs.current[0]?.focus();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Verification failed. Please check your connection.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0 || isResending) return;
    if (!email) {
      setErrorMessage('Please enter your email address to request a verification code.');
      setIsEditingEmail(true);
      return;
    }

    setIsResending(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const result = await resendOtp(email);
      if (result.success) {
        setSuccessMessage('A new 6-digit verification code has been sent to your email.');
        setCooldown(result.cooldownSeconds || 60);
        setOtp(['', '', '', '', '', '']);
        inputRefs.current[0]?.focus();
      } else {
        setErrorMessage(result.error || 'Failed to resend code. Please try again.');
        if (result.cooldownSeconds) {
          setCooldown(result.cooldownSeconds);
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Service unreachable. Please check your connection.');
    } finally {
      setIsResending(false);
    }
  };

  const handleSaveNewEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newEmailInput.trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    if (email && trimmed === email) {
      setIsEditingEmail(false);
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(`Updating email address to ${trimmed}...`);
    setOtp(['', '', '', '', '', '']);

    try {
      if (email) {
        // User is changing an existing pending verification email
        const res = await changeVerificationEmail(email, trimmed);
        if (res.success) {
          setEmail(trimmed);
          setIsEditingEmail(false);
          setSuccessMessage(res.message || `Verification code sent to ${trimmed}.`);
          setCooldown(res.cooldownSeconds || 60);
          inputRefs.current[0]?.focus();
        } else {
          setErrorMessage(res.error || 'Could not update email address.');
        }
      } else {
        // No current email set, request OTP for this new email
        const res = await resendOtp(trimmed);
        if (res.success) {
          setEmail(trimmed);
          setIsEditingEmail(false);
          setSuccessMessage(`Verification code sent to ${trimmed}.`);
          setCooldown(res.cooldownSeconds || 60);
          inputRefs.current[0]?.focus();
        } else {
          setErrorMessage(res.error || 'Could not send verification code to this address.');
        }
      }
    } catch {
      setErrorMessage('Network error while requesting code.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#faf9f6] text-[#1a1c1a] flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        {/* Brand identity */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <img src="/branding/adgrid-mark.png" alt="ADGRID" className="h-10 w-auto" />
          <span className="font-extrabold text-2xl tracking-tight text-[#181716]">
            ADGRID<span className="text-[#ef5a24]">.</span>
          </span>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-xl shadow-zinc-200/50 border border-[#eae7e1] p-8 sm:p-10 relative overflow-hidden">
          {/* Top accent border */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#ef5a24] via-amber-500 to-[#ef5a24]" />

          {/* Heading */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-orange-50 border border-orange-100 text-[#ef5a24] mb-4">
              <Mail className="w-7 h-7" />
            </div>
            <h1 className="text-2xl font-extrabold text-[#181716] tracking-tight">
              Verify your email
            </h1>
            <p className="mt-2 text-sm text-zinc-600 max-w-sm mx-auto">
              We&apos;ve sent a 6-digit verification code to your email address.
            </p>
          </div>

          {/* Email Destination & Edit */}
          <div className="mb-6 p-3.5 rounded-xl bg-[#f4f3f0] border border-[#eae7e1] flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-white border border-zinc-200 flex items-center justify-center text-zinc-600 shrink-0">
                <ShieldCheck className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                  Target Account
                </p>
                <p className="text-sm font-bold text-[#181716] truncate" title={email}>
                  {email ? maskEmail(email) : 'No email specified'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setNewEmailInput(email);
                setIsEditingEmail(!isEditingEmail);
                setErrorMessage(null);
              }}
              className="text-xs font-semibold text-[#ef5a24] hover:text-[#d94e1d] flex items-center gap-1 transition-colors px-2 py-1 rounded-lg hover:bg-orange-50/80 cursor-pointer"
            >
              <Edit2 className="w-3.5 h-3.5" />
              <span>Change</span>
            </button>
          </div>

          {/* Change Email Inline Form */}
          {isEditingEmail && (
            <form onSubmit={handleSaveNewEmail} className="mb-6 p-4 rounded-xl bg-orange-50/50 border border-orange-200/80 animate-in fade-in duration-200">
              <label htmlFor="newEmail" className="block text-xs font-bold text-zinc-700 mb-1.5">
                Update destination email address
              </label>
              <div className="flex gap-2">
                <input
                  id="newEmail"
                  type="email"
                  value={newEmailInput}
                  onChange={(e) => setNewEmailInput(e.target.value)}
                  placeholder="name@company.com"
                  required
                  className="flex-1 px-3 py-2 text-sm bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#ef5a24] focus:border-transparent"
                />
                <button
                  type="submit"
                  className="px-4 py-2 bg-[#ef5a24] text-white text-xs font-bold rounded-xl hover:bg-[#d94e1d] transition-colors cursor-pointer"
                >
                  Update
                </button>
              </div>
            </form>
          )}

          {/* Feedback messages */}
          {errorMessage && (
            <div className="mb-6 p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-medium flex items-start gap-2.5 animate-in fade-in duration-150">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div className="mb-6 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium flex items-start gap-2.5 animate-in fade-in duration-150">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* 6-Digit OTP Inputs */}
          <div className="mb-8">
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider text-center mb-3">
              Enter 6-Digit Code
            </label>
            <div className="flex justify-between gap-2 sm:gap-3" onPaste={handlePaste}>
              {otp.map((digit, idx) => (
                <input
                  key={idx}
                  ref={(el) => { inputRefs.current[idx] = el; }}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleInputChange(idx, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(idx, e)}
                  disabled={isSubmitting}
                  aria-label={`Digit ${idx + 1}`}
                  className={`w-11 h-14 sm:w-12 sm:h-16 text-center text-2xl font-mono font-extrabold bg-[#faf9f6] border rounded-xl transition-all duration-150 focus:outline-none ${
                    digit
                      ? 'border-[#ef5a24] bg-white text-[#181716] shadow-sm'
                      : 'border-zinc-300 text-zinc-800 focus:border-[#ef5a24] focus:bg-white focus:ring-2 focus:ring-[#ef5a24]/20'
                  } ${isSubmitting ? 'opacity-60 cursor-not-allowed' : ''}`}
                />
              ))}
            </div>
          </div>

          {/* Submit Button */}
          <button
            type="button"
            onClick={() => handleVerifyCode()}
            disabled={isSubmitting || otp.join('').length !== 6}
            className={`w-full py-3.5 px-4 rounded-xl text-sm font-bold text-white transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer ${
              otp.join('').length === 6 && !isSubmitting
                ? 'bg-[#ef5a24] hover:bg-[#d94e1d] shadow-orange-500/20 hover:shadow-orange-500/30'
                : 'bg-zinc-300 text-zinc-500 cursor-not-allowed shadow-none'
            }`}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Verifying code...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>Verify Email</span>
              </>
            )}
          </button>

          {/* Resend Code Section */}
          <div className="mt-6 pt-6 border-t border-[#eae7e1] text-center">
            <p className="text-xs text-zinc-600 mb-2">
              Didn&apos;t receive the code? Check your spam folder or request a new one.
            </p>
            {cooldown > 0 ? (
              <div className="inline-flex items-center gap-2 text-xs font-semibold text-zinc-500 px-3 py-1.5 rounded-lg bg-zinc-100">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Resend code in {cooldown}s</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleResend}
                disabled={isResending}
                className="text-xs font-bold text-[#ef5a24] hover:text-[#d94e1d] transition-colors inline-flex items-center gap-1.5 hover:underline cursor-pointer disabled:opacity-50"
              >
                {isResending ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Sending code...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Resend code</span>
                  </>
                )}
              </button>
            )}
          </div>

          {/* Back to sign in */}
          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={() => {
                if (onBackToSignIn) {
                  onBackToSignIn();
                } else if (onNavigateTo) {
                  onNavigateTo('/admin');
                } else {
                  window.location.href = '/admin';
                }
              }}
              className="text-xs font-semibold text-zinc-500 hover:text-zinc-800 transition-colors inline-flex items-center gap-1.5 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to sign in</span>
            </button>
          </div>
        </div>

        {/* Security watermark footer */}
        <p className="mt-8 text-center text-xs text-zinc-400">
          Protected by ADGRID Multi-Tenant Cryptographic Authority
        </p>
      </div>
    </div>
  );
};

export default VerifyEmailPage;
