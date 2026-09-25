import * as r from "./wellness.repository.js";
const fail = () => Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
export const list = r.offerings;
export const detail = async (id) => {
  const x = await r.offering(id);
  if (!x) throw fail();
  return x;
};
export const book = (u, d) =>
  r.tx(async (t) => {
    if (!(await r.patient(t, u))) throw fail();
    const o = await r.offering(d.offeringId, t);
    if (!o) throw fail();
    const b = await r.create(t, {
      patientId: u,
      offeringId: d.offeringId,
      requestedAt: new Date(d.requestedAt),
      context: d.context,
    });
    await r.audit(t, u, "WELLNESS_BOOKING_REQUESTED", b.id);
    return b;
  });
export const mine = (u, q) =>
  r.tx(async (t) => {
    if (!(await r.patient(t, u))) throw fail();
    return r.mine(t, u, q);
  });
export const booking = (u, id) =>
  r.tx(async (t) => {
    if (!(await r.patient(t, u))) throw fail();
    const b = await r.detailBooking(t, id, u);
    if (!b) throw fail();
    return b;
  });
export const queue = (u, q) =>
  r.tx(async (t) => {
    const x = await r.queue(t, u, q);
    if (!x) throw fail();
    return x;
  });
const decide = (u, id, s, reason) =>
  r.tx(async (t) => {
    const x = await r.change(t, u, id, s, reason);
    if (x.count !== 1) throw fail();
    await r.audit(t, u, `WELLNESS_BOOKING_${s}`, id);
    return { id, status: s };
  });
export const confirm = (u, id) => decide(u, id, "CONFIRMED");
export const reject = (u, id, rn) => decide(u, id, "REJECTED", rn);
