import { z } from 'zod';

// Standardised medical vocab for the dropdown fields. Kept strict so a typo or a
// bad client can't persist junk into the health record.
const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const GENOTYPES = ['AA', 'AS', 'SS', 'AC', 'SC', 'CC'];
const EMERGENCY_ACCESS_CATEGORIES = [
  'Appointments',
  'Prescriptions',
  'Vitals',
  'Labs',
  'Medical Records',
];

// PUT /api/v1/profile/update — the central settings hub. Every field is optional
// so the screen can send partial updates, but `.strict()` rejects any key that is
// not part of the profile (e.g. an attempt to flip two_factor_auth here, which is
// owned by the /security endpoint). At least one field must be present.
export const updateProfileSchema = z.object({
  body: z
    .object({
      // --- Personal Info ---
      full_name: z.string().min(2, 'Full name must be at least 2 characters').optional(),
      email: z.string().email('A valid email is required').optional(),
      phone_number: z.string().min(10, 'Phone number must be at least 10 digits').optional(),
      dob: z.string().date('Date of birth must be an ISO date, e.g. 1990-05-15').optional(),

      // --- Medical History ---
      blood_type: z.enum(BLOOD_TYPES, { message: 'Invalid blood type' }).optional(),
      genotype: z.enum(GENOTYPES, { message: 'Invalid genotype' }).optional(),
      chronic_conditions: z.string().optional(),

      // --- Allergies & Medications (free text, comma-separated on the client) ---
      known_allergies: z.string().optional(),
      current_medications: z.string().optional(),

      // --- Lifestyle ---
      smoking_status: z.string().optional(),
      alcohol_frequency: z.string().optional(),
      physical_activity: z.string().optional(),

      // --- Notifications ---
      appointment_reminders: z.boolean().optional(),
      prescription_alerts: z.boolean().optional(),
      health_tips_newsletter: z.boolean().optional(),

      // --- Consent ---
      data_sharing_consent: z.boolean().optional(),
      electronic_health_records: z.boolean().optional(),
      emergencyContactName: z.string().trim().min(2).max(120).optional(),
      emergencyContactPhone: z.string().trim().min(7).max(30).optional(),
      emergencyContactRelation: z.string().trim().min(2).max(80).optional(),

      // --- Emergency Access (which record categories a responder may view) ---
      emergency_access_permissions: z
        .array(z.enum(EMERGENCY_ACCESS_CATEGORIES, { message: 'Invalid emergency access category' }))
        .optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, {
      message: 'At least one field is required to update the profile',
    }),
});

// PUT /api/v1/profile/security — toggles two-factor auth.
export const updateSecuritySchema = z.object({
  body: z.object({
    two_factor_auth: z.boolean(),
  }).strict(),
});

// PUT /api/v1/profile/security/change-password — validated now; handler is a stub.
export const changePasswordSchema = z.object({
  body: z.object({
    current_password: z.string().min(8, 'Current password must be at least 8 characters'),
    new_password: z.string().min(8, 'New password must be at least 8 characters'),
  }).strict(),
});

// DELETE /api/v1/profile/delete-account — the UI forces the user to type "DELETE".
export const deleteAccountSchema = z.object({
  body: z.object({
    confirmation: z.literal('DELETE', {
      message: "You must type 'DELETE' exactly to confirm account deletion",
    }),
  }).strict(),
});
