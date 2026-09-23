// Provider-neutral seam. Production delivery is intentionally not configured;
// callers receive no token through HTTP, while tests can mock this function.
export const sendCaregiverInvite = async ({ email, token, relationshipId }) => {
  void email; void token; void relationshipId;
  return { delivered: false };
};
