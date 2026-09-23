import { z } from 'zod';

export const listNotificationsSchema = z.object({ query: z.object({ page: z.coerce.number().int().min(1).max(1000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), unreadOnly: z.enum(['true', 'false']).optional() }).strict() });
export const notificationIdSchema = z.object({ params: z.object({ id: z.string().uuid() }).strict() });
