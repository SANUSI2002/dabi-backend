import { z } from 'zod';

const uuid = z.string().uuid();
const money = z.number().int().min(0).max(1000000000);
const coordinates = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
}).strict();

export const update = z.object({
  body: z.object({
    platformFeeMinor: money,
    deliveryRatePerKmMinor: money,
    currency: z.literal('NGN'),
  }).strict(),
});

export const preview = z.object({
  params: z.object({ id: uuid }).strict(),
  body: z.object({
    fulfilments: z.array(z.object({
      pharmacyId: uuid,
      fulfilmentMethod: z.enum(['PICKUP', 'DELIVERY']),
    }).strict()).min(1).max(50),
    deliveryCoordinates: coordinates.optional(),
  }).strict().superRefine((value, context) => {
    if (value.fulfilments.some((item) => item.fulfilmentMethod === 'DELIVERY') && !value.deliveryCoordinates) {
      context.addIssue({ code: 'custom', path: ['deliveryCoordinates'], message: 'Delivery coordinates are required for delivery' });
    }
  }),
});
