import { z } from 'zod';

const uuid = z.string().uuid();
const coordinates = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
}).strict();
const delivery = z.object({
  recipientName: z.string().trim().min(2).max(120),
  recipientPhone: z.string().trim().regex(/^\+?[1-9]\d{6,14}$/),
  address: z.string().trim().min(5).max(500),
  coordinates,
}).strict();

export const create = z.object({
  body: z.object({
    reservationId: uuid,
    idempotencyKey: z.string().trim().min(16).max(128),
    fulfilments: z.array(z.object({
      pharmacyId: uuid,
      fulfilmentMethod: z.enum(['PICKUP', 'DELIVERY']),
    }).strict()).min(1).max(50),
    delivery: delivery.optional(),
  }).strict().superRefine((value, context) => {
    const requiresDelivery = value.fulfilments.some((item) => item.fulfilmentMethod === 'DELIVERY');
    if (requiresDelivery && !value.delivery) {
      context.addIssue({ code: 'custom', path: ['delivery'], message: 'Delivery details are required' });
    }
    if (!requiresDelivery && value.delivery) {
      context.addIssue({ code: 'custom', path: ['delivery'], message: 'Delivery details are not allowed for pickup-only orders' });
    }
  }),
});

export const id = z.object({ params: z.object({ id: uuid }).strict() });
