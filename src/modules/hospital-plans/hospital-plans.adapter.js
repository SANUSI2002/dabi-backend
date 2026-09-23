// Maps safe API catalogue data to the existing Nw Enrollment Plans cards.
// This is display conversion only: API storage and writes use integer kobo.
export const toPlanCard = (plan) => ({ id: plan.id, name: plan.name, description: plan.description ?? '', fee: plan.feeMinor / 100 });
export const loadHospitalPlans = async (hospitalId, fetchImpl = globalThis.fetch) => {
  const plans = [];
  let offset = 0;
  while (true) {
    const response = await fetchImpl(`/api/v1/hospitals/${encodeURIComponent(hospitalId)}/plans?limit=100&offset=${offset}`);
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message || 'Hospital plans unavailable'), { status: response.status });
    plans.push(...result.data.items.map(toPlanCard));
    offset += result.data.items.length;
    if (result.data.items.length === 0 || offset >= result.data.total) return plans;
  }
};
