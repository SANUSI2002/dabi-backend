// Browser-compatible adapter for the live /signup/caregiver component.
// No local-storage fallback: a failed submission must stay on the form.
const allow = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('Unexpected registration fields');
  }
};
export const mapCaregiverRegistration = (form) => {
  allow(form, ['account', 'caregiverType', 'connection', 'consent']);
  allow(form.account, ['firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'country', 'state', 'city', 'password', 'confirmPassword']);
  allow(form.connection, ['mode', 'relationship', 'inviteContact', 'patientId']);
  allow(form.consent, ['terms', 'privacy']);
  const { mode, relationship, inviteContact, patientId } = form.connection;
  return {
    account: { ...form.account }, caregiverType: form.caregiverType,
    connection: mode === 'invite' ? { mode, relationship, inviteContact } : { mode, relationship, patientReference: patientId },
    consent: { terms: form.consent.terms, privacy: form.consent.privacy },
  };
};
export const submitCaregiverRegistration = async (form, fetchImpl = globalThis.fetch) => {
  const response = await fetchImpl('/api/v1/auth/register/caregiver', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapCaregiverRegistration(form)),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message || 'Registration failed'), { status: response.status, errors: result.errors });
  return result;
};
