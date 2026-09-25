import { describe, expect, it, vi } from 'vitest';

// The global client and the transaction client are distinct objects here, so any read that
// escapes the transaction (and would need a second pooled connection) is caught.
const model = () => ({ findFirst: vi.fn(), create: vi.fn() });
const tx = { userRole: model(), wellnessOffering: model(), wellnessBooking: model(), activityLog: model() };
const prisma = { wellnessOffering: model(), $transaction: vi.fn((work) => work(tx)) };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { book } = await import('../src/modules/wellness/wellness.service.js');

describe('wellness booking transaction', () => {
  it('reads the offering through the transaction client, not the global one', async () => {
    tx.userRole.findFirst.mockResolvedValue({ id: 'role' });
    tx.wellnessOffering.findFirst.mockResolvedValue({ id: 'offering' });
    tx.wellnessBooking.create.mockResolvedValue({ id: 'booking', status: 'PENDING' });

    await expect(book('patient', { offeringId: 'offering', requestedAt: '2027-01-01T09:00:00.000Z' })).resolves.toMatchObject({ id: 'booking' });
    expect(tx.wellnessOffering.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.wellnessOffering.findFirst).not.toHaveBeenCalled();
  });
});
