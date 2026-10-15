import type { PoolClient } from 'pg';
import { db } from '../db.js';

/** Serialize topology-sensitive writes with source reconciliation on the map row. */
export async function withMapRowLock<T>(mapId: string, write: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    await client.query('SELECT id FROM maps WHERE id=$1 FOR UPDATE', [mapId]);
    const value = await write(client);
    await client.query('COMMIT');
    inTransaction = false;
    return value;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
