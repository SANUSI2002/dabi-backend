const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export const passwordResetEmailConfigured = () => Boolean(
  process.env.RESEND_API_KEY?.trim()
  && process.env.PASSWORD_RESET_EMAIL_FROM?.trim()
  && !process.env.PASSWORD_RESET_EMAIL_FROM.includes('example.com')
  && (process.env.PASSWORD_RESET_EMAIL_FROM.trim() !== 'onboarding@resend.dev' || process.env.RESEND_TEST_RECIPIENT?.trim()),
);

export const passwordResetEmailAllowedFor = (email) => {
  if (process.env.PASSWORD_RESET_EMAIL_FROM?.trim() !== 'onboarding@resend.dev') return true;
  return email.trim().toLowerCase() === process.env.RESEND_TEST_RECIPIENT?.trim().toLowerCase();
};

export const verificationEmailConfigured = passwordResetEmailConfigured;
export const verificationEmailAllowedFor = passwordResetEmailAllowedFor;

export const sendEmailVerificationEmail = async ({ email, verificationUrl }) => {
  if (!verificationEmailConfigured() || !verificationEmailAllowedFor(email)) return { delivered: false };
  try {
    const response = await globalThis.fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.PASSWORD_RESET_EMAIL_FROM,
        to: [email],
        subject: 'Verify your Sabi Health email',
        text: `Welcome to Sabi Health. Confirm that you own this email address to activate your account. This link expires in 24 hours and can be used once.\n\n${verificationUrl}\n\nIf you did not register, ignore this email.`,
      }),
      signal: globalThis.AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`[auth] Email-verification provider returned HTTP ${response.status}.`);
      return { delivered: false };
    }
    return { delivered: true };
  } catch {
    console.error('[auth] Email-verification provider request failed.');
    return { delivered: false };
  }
};

export const sendPasswordResetEmail = async ({ email, resetUrl }) => {
  if (!passwordResetEmailConfigured()) return { delivered: false };

  try {
    const response = await globalThis.fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.PASSWORD_RESET_EMAIL_FROM,
        to: [email],
        subject: 'Reset your Sabi ID password',
        text: `Use this link to reset your Sabi ID password. It expires in 30 minutes and can be used once.\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
      }),
      signal: globalThis.AbortSignal.timeout(10_000),
    });
    // Provider errors can include request details. Never log the response body or reset URL.
    if (!response.ok) {
      console.error(`[auth] Password-reset email provider returned HTTP ${response.status}.`);
      return { delivered: false };
    }
    return { delivered: true };
  } catch {
    console.error('[auth] Password-reset email provider request failed.');
    return { delivered: false };
  }
};
