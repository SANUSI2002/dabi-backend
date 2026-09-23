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
