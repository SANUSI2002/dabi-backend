import pg from 'pg';
import { Connector } from '@google-cloud/cloud-sql-connector';

const invalid = () => { throw Object.assign(new Error('Database connection configuration is invalid.'), { code: 'DATABASE_CONFIGURATION_INVALID' }); };

/** ADC + short-lived IAM authentication; never reuse the migration/admin identity. */
export async function createDatabasePool({ env = process.env, Pool = pg.Pool, connectorFactory = () => new Connector() } = {}) {
  const mode = env.DATABASE_CONNECTION_MODE || 'url';
  const max = env.DATABASE_POOL_MAX ? Number(env.DATABASE_POOL_MAX) : 10;
  if (!Number.isInteger(max) || max < 1 || max > 20) invalid();
  if (mode === 'url') return { pool: new Pool({ connectionString: env.DATABASE_URL, max }), closeConnector() {} };
  if (mode !== 'cloud-sql-iam') invalid();

  const connection = env.CLOUD_SQL_INSTANCE_CONNECTION_NAME || '';
  const match = /^([a-z][a-z0-9-]{4,61}[a-z0-9]):([a-z]+-[a-z]+\d):([a-z][a-z0-9-]{0,96}[a-z0-9])$/.exec(connection);
  const user = env.CLOUD_SQL_IAM_USER || '';
  const database = env.CLOUD_SQL_DATABASE || '';
  if (!match || !/^[a-z][a-z0-9_]{0,62}$/.test(database)
    || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]+\.iam$/.test(user)
    || user.split('@')[1] !== `${match[1]}.iam`
    || env.DATABASE_URL?.trim()) invalid();

  const connector = connectorFactory();
  try {
    const options = await connector.getOptions({ instanceConnectionName: connection, authType: 'IAM', ipType: 'PUBLIC' });
    // Google's connector owns verified TLS and short-lived token renewal.
    const pool = new Pool({ ...options, user, database, max, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    return { pool, closeConnector: () => connector.close() };
  } catch {
    connector.close();
    throw Object.assign(new Error('Secure database connection is unavailable.'), { code: 'DATABASE_CONNECTOR_UNAVAILABLE' });
  }
}
