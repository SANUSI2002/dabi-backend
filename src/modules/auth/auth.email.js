// Provider-neutral seam. Configure an email provider in deployment and replace
// this adapter; no reset secret is logged or returned through HTTP.
export const sendPasswordResetEmail = async ({ email, resetUrl }) => {
  if (!process.env.PASSWORD_RESET_EMAIL_FROM) return { delivered: false };
  void email;
  void resetUrl;
  return { delivered: false };
};
