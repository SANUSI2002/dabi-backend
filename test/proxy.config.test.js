import { describe, expect, it } from 'vitest';
import { trustedProxySetting } from '../src/config/proxy.js';
describe('trusted proxy configuration', () => {
  it('accepts numeric hops and ignores ambiguous booleans', () => { expect(trustedProxySetting({ TRUST_PROXY_HOPS: '1' })).toBe(1); expect(trustedProxySetting({ TRUST_PROXY: 'true' })).toBe(false); });
  it('accepts an explicit CIDR allowlist', () => { expect(trustedProxySetting({ TRUST_PROXY_CIDRS: '10.0.0.0/8, 192.168.0.0/16' })).toEqual(['10.0.0.0/8', '192.168.0.0/16']); });
});
