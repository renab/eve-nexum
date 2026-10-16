import { db } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { publishToMap } from './mapEvents.js';
import { effectiveExpiryMs, lifeBucket, type TimeBucket } from '../data/whLifetimes.js';
import { withMapRowLock } from './mapRowLock.js';

const log = createLogger('connLifetimeSweep');

interface Row {
  id:                string;
  mapId:             string;
  timeStatus:        string | null;
  whType:            string | null;
  eolAt:             Date | null;
  lifetimeExpiresAt: Date | null;
  createdAt:         Date;
  sourceId:          string;
  targetId:          string;
  sourceSignatureId: string | null;
  targetSignatureId: string | null;
  lazyRemove:        boolean;
  graceHours:        number;
}

export type LifetimeAction =
  | { kind: 'none' }
  | { kind: 'rebucket'; bucket: TimeBucket }
  | { kind: 'collapse' };

/**
 * Decide what the sweep should do with one connection (pure, so it's unit
 * tested without a DB):
 *   - unknown lifetime → nothing;
 *   - expired for longer than the grace period on a lazy-removal map → collapse
 *     (sever + drop its backing sigs — a dead hole has no sig on the scanner);
 *   - otherwise re-bucket if the stored status has drifted from the live one.
 * Collapse takes priority over re-bucketing so an over-grace hole doesn't first
 * get stamped 'expired' only to be severed the same tick.
 */
export function connLifetimeAction(
  row: Pick<Row, 'timeStatus' | 'whType' | 'eolAt' | 'lifetimeExpiresAt' | 'createdAt' | 'lazyRemove'>,
  now: number,
  graceMs: number,
): LifetimeAction {
  const expiry = effectiveExpiryMs(row);
  if (expiry === null) return { kind: 'none' };
  if (row.lazyRemove && now - expiry > graceMs) return { kind: 'collapse' };
  const bucket = lifeBucket(expiry - now);
  return bucket === row.timeStatus ? { kind: 'none' } : { kind: 'rebucket', bucket };
}

/**
 * Collapse one map's over-grace connections in a transaction: delete the
 * wormhole sigs backing them, sever the connections (broken = true), then
 * broadcast so open clients drop the sigs and render the severed edge live.
 */
async function collapseMap(mapId: string, conns: Row[]): Promise<void> {
  let collapsed: Row[] = [];
  let removedSignatureCount = 0;
  try {
    collapsed = await withMapRowLock(mapId, async (client) => {
      const current = await client.query<Row>(
        `SELECT c.id,c.map_id AS "mapId",c.time_status AS "timeStatus",c.wh_type AS "whType",c.eol_at AS "eolAt",
                c.lifetime_expires_at AS "lifetimeExpiresAt",c.created_at AS "createdAt",c.source_id AS "sourceId",
                c.target_id AS "targetId",c.source_signature_id AS "sourceSignatureId",c.target_signature_id AS "targetSignatureId",
                m.lazy_remove_wormholes AS "lazyRemove",m.collapse_grace_hours AS "graceHours"
           FROM map_connections c JOIN maps m ON m.id=c.map_id
          WHERE c.map_id=$1 AND c.id=ANY($2::uuid[]) AND c.connection_type='standard' AND c.broken=FALSE
            AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
              WHERE o.map_id=c.map_id AND o.item_kind='connection' AND o.row_id=c.id)
            AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
              WHERE o.map_id=c.map_id AND o.item_kind='signature'
                AND (o.row_id=c.source_signature_id OR o.row_id=c.target_signature_id))
            AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
              JOIN map_connections owned_c ON owned_c.map_id=o.map_id AND owned_c.id=o.row_id
              WHERE o.map_id=c.map_id AND o.item_kind='connection'
                AND (owned_c.source_signature_id=c.source_signature_id OR owned_c.source_signature_id=c.target_signature_id
                  OR owned_c.target_signature_id=c.source_signature_id OR owned_c.target_signature_id=c.target_signature_id))
          FOR UPDATE OF c`, [mapId, conns.map((c) => c.id)]);
      if (!current.rows.length) return [];
      const stillExpired = current.rows.filter((connection) => connLifetimeAction(
        connection, Date.now(), connection.graceHours * 3_600_000).kind === 'collapse');
      if (!stillExpired.length) return [];
      const sigIds = stillExpired.flatMap((c) => [c.sourceSignatureId, c.targetSignatureId]).filter((x): x is string => !!x);
      if (sigIds.length) {
        const removed = await client.query(`DELETE FROM map_signatures s WHERE s.id=ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
            WHERE o.map_id=$2 AND o.item_kind='signature' AND o.row_id=s.id)`, [sigIds, mapId]);
        removedSignatureCount = removed.rowCount ?? 0;
      }
      const connIds = stillExpired.map((row) => row.id);
      await client.query(`UPDATE map_connections SET broken=TRUE,broken_at=NOW() WHERE map_id=$1 AND id=ANY($2::uuid[])`, [mapId, connIds]);
      await client.query(`UPDATE maps SET updated_at = NOW() WHERE id = $1`, [mapId]);
      return stillExpired;
    });
  } catch (err) {
    log.warn(`collapse failed for map ${mapId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (collapsed.length === 0) return;

  const connIds = collapsed.map((c) => c.id);
  const affectedSystems = new Set(collapsed.flatMap((c) => [c.sourceId, c.targetId]));
  for (const systemId of affectedSystems) publishToMap(mapId, { type: 'sig.changed', actor: null, systemId });
  for (const id of connIds) publishToMap(mapId, { type: 'connection.update', actor: null, id, updates: { broken: true } });
  log.info(`map ${mapId}: collapsed ${connIds.length} expired connection(s), removed ${removedSignatureCount} sig(s)`);
}

/**
 * One sweep pass: for every standard wormhole connection with a determinable
 * lifetime, either re-bucket its stored time_status (all maps) or — once it has
 * been expired past the grace period on a lazy-removal map — collapse it. Purely
 * display/state work: re-bucketing never deletes; collapse mirrors a real hole
 * dying (sig gone, connection severed) and only fires where the map opted in.
 *
 * The prefilter keeps the candidate set to holes with a determinable lifetime
 * (a manual/legacy timestamp, or any typed hole — K162 decays against the 48h
 * ceiling). Untyped connections have no computable expiry and are skipped in JS.
 */
export async function sweepConnLifetimes(): Promise<void> {
  let rows: Row[];
  try {
    const res = await db.query<Row>(
      `SELECT c.id, c.map_id AS "mapId", c.time_status AS "timeStatus", c.wh_type AS "whType",
              c.eol_at AS "eolAt", c.lifetime_expires_at AS "lifetimeExpiresAt", c.created_at AS "createdAt",
              c.source_id AS "sourceId", c.target_id AS "targetId",
              c.source_signature_id AS "sourceSignatureId", c.target_signature_id AS "targetSignatureId",
              m.lazy_remove_wormholes AS "lazyRemove", m.collapse_grace_hours AS "graceHours"
         FROM map_connections c
         JOIN maps m ON m.id = c.map_id
         WHERE c.connection_type = 'standard'
           AND c.broken = FALSE
           AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
             WHERE o.map_id=c.map_id AND o.item_kind='connection' AND o.row_id=c.id)
            AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
              WHERE o.map_id=c.map_id AND o.item_kind='signature'
                AND (o.row_id=c.source_signature_id OR o.row_id=c.target_signature_id))
            AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
              JOIN map_connections owned_c ON owned_c.map_id=o.map_id AND owned_c.id=o.row_id
              WHERE o.map_id=c.map_id AND o.item_kind='connection'
                AND (owned_c.source_signature_id=c.source_signature_id OR owned_c.source_signature_id=c.target_signature_id
                  OR owned_c.target_signature_id=c.source_signature_id OR owned_c.target_signature_id=c.target_signature_id))
           AND (c.lifetime_expires_at IS NOT NULL
            OR c.eol_at IS NOT NULL
            OR (c.wh_type IS NOT NULL AND c.wh_type <> ''))`,
    );
    rows = res.rows;
  } catch (err) {
    log.warn(`candidate query failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const now = Date.now();
  // Re-bucket updates grouped by their new bucket (one UPDATE per bucket value);
  // collapses grouped by map (one transaction per map).
  const rebucketed: { id: string; mapId: string; bucket: TimeBucket }[] = [];
  const rebucketedByMap = new Map<string, typeof rebucketed>();
  const collapseByMap = new Map<string, Row[]>();

  for (const r of rows) {
    // Grace is per-map (map settings). Each connection carries its map's value.
    const action = connLifetimeAction(r, now, r.graceHours * 3_600_000);
    if (action.kind === 'collapse') {
      const list = collapseByMap.get(r.mapId);
      if (list) list.push(r); else collapseByMap.set(r.mapId, [r]);
    } else if (action.kind === 'rebucket') {
      rebucketed.push({ id: r.id, mapId: r.mapId, bucket: action.bucket });
      const list = rebucketedByMap.get(r.mapId);
      if (list) list.push({ id: r.id, mapId: r.mapId, bucket: action.bucket });
      else rebucketedByMap.set(r.mapId, [{ id: r.id, mapId: r.mapId, bucket: action.bucket }]);
    }
  }

  if (rebucketed.length > 0) {
    for (const [mapId, mapConnections] of rebucketedByMap) {
      let changed: Array<{ id: string; mapId: string; bucket: TimeBucket }>;
      try {
        changed = await withMapRowLock(mapId, async (client) => {
          const current = await client.query<Pick<Row, 'id' | 'mapId' | 'timeStatus' | 'whType' | 'eolAt' |
            'lifetimeExpiresAt' | 'createdAt' | 'lazyRemove' | 'graceHours'>>(
            `SELECT c.id,c.map_id AS "mapId",c.time_status AS "timeStatus",c.wh_type AS "whType",c.eol_at AS "eolAt",
                    c.lifetime_expires_at AS "lifetimeExpiresAt",c.created_at AS "createdAt",
                    m.lazy_remove_wormholes AS "lazyRemove",m.collapse_grace_hours AS "graceHours"
               FROM map_connections c JOIN maps m ON m.id=c.map_id
              WHERE c.map_id=$1 AND c.id=ANY($2::uuid[]) AND c.connection_type='standard' AND c.broken=FALSE
                AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
                  WHERE o.map_id=c.map_id AND o.item_kind='connection' AND o.row_id=c.id)
                AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
                  WHERE o.map_id=c.map_id AND o.item_kind='signature'
                    AND (o.row_id=c.source_signature_id OR o.row_id=c.target_signature_id))
              FOR UPDATE OF c`, [mapId, mapConnections.map((connection) => connection.id)]);
          const byBucket = new Map<TimeBucket, string[]>();
          for (const connection of current.rows) {
            const action = connLifetimeAction(connection, Date.now(), connection.graceHours * 3_600_000);
            if (action.kind !== 'rebucket') continue;
            const ids = byBucket.get(action.bucket);
            if (ids) ids.push(connection.id); else byBucket.set(action.bucket, [connection.id]);
          }
          const updated: typeof rebucketed = [];
          for (const [bucket, ids] of byBucket) {
            const result = await client.query<{ id: string }>(`UPDATE map_connections c SET time_status=$1
              WHERE c.map_id=$2 AND c.id=ANY($3::uuid[])
                AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
                  WHERE o.map_id=c.map_id AND o.item_kind='connection' AND o.row_id=c.id)
           AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
             WHERE o.map_id=c.map_id AND o.item_kind='signature'
               AND (o.row_id=c.source_signature_id OR o.row_id=c.target_signature_id))
           AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o
             JOIN map_connections owned_c ON owned_c.map_id=o.map_id AND owned_c.id=o.row_id
             WHERE o.map_id=c.map_id AND o.item_kind='connection'
               AND (owned_c.source_signature_id=c.source_signature_id OR owned_c.source_signature_id=c.target_signature_id
                 OR owned_c.target_signature_id=c.source_signature_id OR owned_c.target_signature_id=c.target_signature_id))
              RETURNING c.id`, [bucket, mapId, ids]);
            updated.push(...result.rows.map((row) => ({ id: row.id, mapId, bucket })));
          }
          if (updated.length) await client.query(`UPDATE maps SET updated_at=NOW() WHERE id=$1`, [mapId]);
          return updated;
        });
      } catch (err) {
        log.warn(`bucket update failed for map ${mapId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const c of changed) {
        publishToMap(c.mapId, { type: 'connection.update', actor: null, id: c.id, updates: { timeStatus: c.bucket } });
      }
    }
    log.info(`re-bucketed ${rebucketed.length} connection(s) across ${rebucketedByMap.size} map(s)`);
  }

  for (const [mapId, conns] of collapseByMap) {
    await collapseMap(mapId, conns);
  }
}

/**
 * Start the periodic connection-lifetime sweep. Cadence is
 * config.connLifetimeSweepMinutes (env CONN_LIFETIME_SWEEP_MINUTES, default 60);
 * 0 disables it. First pass runs shortly after boot.
 */
export function startConnLifetimeSweeper(): void {
  const mins = config.connLifetimeSweepMinutes;
  if (mins <= 0) { log.info('connection-lifetime sweep disabled (CONN_LIFETIME_SWEEP_MINUTES=0)'); return; }
  log.info(`connection-lifetime sweep enabled (every ${mins} min)`);
  setTimeout(() => { void sweepConnLifetimes(); }, 90_000);
  setInterval(() => { void sweepConnLifetimes(); }, mins * 60_000);
}
