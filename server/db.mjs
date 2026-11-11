import pg from 'pg';
export function postgresOptions(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw Error('Invalid PostgreSQL URL');
  // Never let pg-connection-string override verified TLS through query parameters.
  return {
    host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)),
    ssl: { rejectUnauthorized: true }, max: 2, idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000, statement_timeout: 12000, query_timeout: 15000, allowExitOnIdle: true,
  };
}
export function createDatabase(config) {
  const pool = new pg.Pool(postgresOptions(config.databaseUrl));
  pool.on('error', () => {});
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await fn(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    close: () => pool.end(),
  };
}
