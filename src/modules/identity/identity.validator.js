import { z } from 'zod';

export const switchOrganizationSchema = z.object({
  body: z.object({ organizationId: z.string().uuid() }).strict(),
});

export const membershipIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }).strict(),
});

export const managedOrganizationSchema = z.object({
  params: z.object({ organizationId: z.string().uuid() }).strict(),
});

export const inviteMembershipSchema = z.object({
  params: z.object({ organizationId: z.string().uuid() }).strict(),
  body: z.object({
    email: z.string().email().max(320),
    roleCodes: z.array(z.string().min(1).max(64)).min(1).max(4).refine((roles) => new Set(roles).size === roles.length),
  }).strict(),
});

export const managedMembershipSchema = z.object({
  params: z.object({ organizationId: z.string().uuid(), id: z.string().uuid() }).strict(),
});

export const identityInvitationCreateSchema = z.object({ body: z.object({ email: z.string().email().max(320), roleCode: z.string().min(1).max(64) }).strict() });
export const identityInvitationTokenSchema = z.object({ body: z.object({ id: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict() });
export const identityInvitationAcceptSchema = z.object({ body: z.object({ id: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(1).max(128), fullName: z.string().trim().min(1).max(160).optional() }).strict() });
export const identityInvitationIdSchema = z.object({ params: z.object({ id: z.string().uuid() }).strict() });
export const tenantInvitationIdSchema = z.object({ params: z.object({ organizationId: z.string().uuid(), id: z.string().uuid() }).strict() });
