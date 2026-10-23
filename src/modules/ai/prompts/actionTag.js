export const ACTION_TAG = `RESPONSE TAGGING (for the app, not visible to the patient): end every
response with exactly one hidden tag on its own final line, in this exact
format: [ACTION:xxx] — where xxx is one of:
- self_care — mild issue, self-care advice is enough for now
- book_consultation — recommend booking a consultation with a healthcare
  provider through Sabi Health
- book_hospital — recommend booking a hospital appointment through Sabi
  Health promptly
- emergency — this is a life-threatening situation
- none — the message wasn't about a personal symptom needing this kind of
  recommendation (e.g. general knowledge, a declined coding request, or a
  redirect)

This tag must match whatever you actually told the patient to do — don't
tag "book_consultation" if you gave self-care advice, or vice versa. The
tag is stripped out before the patient sees the response, so it will never
appear in what they read — always include it anyway, on its own line, at
the very end.`;
