import { describe, expect, it, vi } from 'vitest';
import { createDatabasePool } from '../src/config/databasePool.js';

const env = {
  DATABASE_CONNECTION_MODE: 'cloud-sql-iam', DATABASE_POOL_MAX: '4',
  CLOUD_SQL_INSTANCE_CONNECTION_NAME: 'project-2dfff4eb-ff04-40b1-aff:us-east1:sabi-production-db',
  CLOUD_SQL_IAM_USER: 'sabi-api-production@project-2dfff4eb-ff04-40b1-aff.iam', CLOUD_SQL_DATABASE: 'sabi_production',
};
function fixture() {
  const connector = { getOptions: vi.fn(async () => ({ stream: 'synthetic-secure-stream' })), close: vi.fn() };
  const connectorFactory = vi.fn(() => connector);
  const Pool = vi.fn(function (options) { this.options = options; });
  return { connector, connectorFactory, Pool };
}
describe('database connection modes', () => {
  it('preserves URL mode for development and embedded PostgreSQL tests', async () => {
    const f = fixture();
    const result = await createDatabasePool({ ...f, env: { DATABASE_URL: 'postgresql://synthetic@localhost/test' } });
    expect(result.pool.options).toEqual({ connectionString: 'postgresql://synthetic@localhost/test', max: 10 });
    expect(f.connectorFactory).not.toHaveBeenCalled();
  });
  it('uses keyless IAM, the exact instance and a bounded pool', async () => {
    const f = fixture();
    const result = await createDatabasePool({ ...f, env });
    expect(f.connector.getOptions).toHaveBeenCalledWith({ instanceConnectionName: env.CLOUD_SQL_INSTANCE_CONNECTION_NAME, authType: 'IAM', ipType: 'PUBLIC' });
    expect(result.pool.options).toEqual({ stream: 'synthetic-secure-stream', user: env.CLOUD_SQL_IAM_USER, database: 'sabi_production', max: 4, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    result.closeConnector();
    expect(f.connector.close).toHaveBeenCalledOnce();
  });
  it.each([
    { DATABASE_CONNECTION_MODE: 'unknown' }, { DATABASE_POOL_MAX: '0' }, { DATABASE_POOL_MAX: '1000' },
    { CLOUD_SQL_INSTANCE_CONNECTION_NAME: 'wrong/instance' }, { CLOUD_SQL_DATABASE: 'db;DROP TABLE users' },
    { CLOUD_SQL_IAM_USER: 'postgres' }, { CLOUD_SQL_IAM_USER: 'sabi-api-production@wrong-project.iam' },
    { DATABASE_URL: 'postgresql://admin:secret@elsewhere/db' },
  ])('fails closed before creating a connector for invalid settings %j', async changes => {
    const f = fixture();
    await expect(createDatabasePool({ ...f, env: { ...env, ...changes } })).rejects.toMatchObject({ code: 'DATABASE_CONFIGURATION_INVALID' });
    expect(f.connectorFactory).not.toHaveBeenCalled();
  });
  it('sanitises provider errors and closes failed connectors', async () => {
    const f = fixture();
    f.connector.getOptions.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_PROVIDER_DETAIL'));
    await expect(createDatabasePool({ ...f, env })).rejects.toThrow('Secure database connection is unavailable.');
    expect(f.connector.close).toHaveBeenCalledOnce();
    expect(f.Pool).not.toHaveBeenCalled();
  });
});
