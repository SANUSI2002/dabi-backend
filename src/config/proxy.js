export const trustedProxySetting = (env = process.env) => {
  const hops = env.TRUST_PROXY_HOPS;
  if (/^\d+$/.test(hops || '')) return Number(hops);
  const cidrs = (env.TRUST_PROXY_CIDRS || '').split(',').map((value) => value.trim()).filter(Boolean);
  return cidrs.length ? cidrs : false;
};
