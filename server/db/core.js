import pg from 'pg';
import { applySchema } from './schema.js';

const { Pool } = pg;

// Type parsing: node-pg's defaults return DATE as a UTC-midnight Date
// (shows a day early in US timezones), BIGINT as a string (our ms
// timestamps and COUNT(*) values), and NUMERIC as a string (money).
// All BIGINTs here are epoch-ms or counts, well under 2^53.
pg.types.setTypeParser(1082, v => v);                                  // DATE -> 'YYYY-MM-DD'
pg.types.setTypeParser(20, v => (v === null ? null : Number(v)));      // BIGINT -> number
pg.types.setTypeParser(1700, v => (v === null ? null : parseFloat(v))); // NUMERIC -> number

export let pool = null;

export async function initDb() {
    const connectionString = process.env.DATABASE_URL;

    const poolConfig = {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    };

    if (connectionString) {
        pool = new Pool({
            ...poolConfig,
            connectionString,
            ssl: process.env.NODE_ENV === 'production'
                ? { rejectUnauthorized: false }
                : false,
        });
    } else {
        // Local development fallback
        pool = new Pool({
            ...poolConfig,
            host: process.env.PGHOST || 'localhost',
            port: parseInt(process.env.PGPORT || '5432'),
            database: process.env.PGDATABASE || 'vrm_dashboard',
            user: process.env.PGUSER || 'postgres',
            password: process.env.PGPASSWORD || 'postgres',
        });
    }


    // Test connection
    const client = await pool.connect();
    try {
        await applySchema(client);
    } finally {
        client.release();
    }

    return pool;
}

export function getPool() {
    return pool;
}
