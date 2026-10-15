import crypto from 'node:crypto';
import { db } from '../db.js';
import { isAdmin, isAllianceAdmin, type Role } from '../middleware/authContext.js';
import { sdeSystemFacts } from './sdeFacts.js';
import { publishToMap } from './mapEvents.js';

type SnapshotEvidence = { complete: true; fetchedAt: string };
type SystemInput = { sourceSystemId: string; eveSystemId: number; positionX: number; positionY: number };
type ConnectionInput = {
  sourceConnectionId: string;
  fromSourceSystemId: string;
  toSourceSystemId: string;
  connectionType: 'standard' | 'gate' | 'jumpgate' | 'cyno';
  size: 'small' | 'medium' | 'large' | 'xl';
};
type TopologyInput = { sourceIdentity: string; snapshot: SnapshotEvidence; systems: SystemInput[]; connections: ConnectionInput[] };
type Owned = { row_id: string; managed_json: Record<string, unknown> };

const safeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const finiteCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const MAX_SNAPSHOT_AGE_MS = 10 * 60 * 1000;
const validTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1] && Number.isFinite(Date.parse(value));
};

function validSourceIdentity(value: unknown): value is string {
  if (!safeId(value) || !value.startsWith('wormholesystems:')) return false;
  try {
    const tuple: unknown = JSON.parse(value.slice('wormholesystems:'.length));
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string' || !safeId(tuple[1])) return false;
    const origin = new URL(tuple[0]);
    return (origin.protocol === 'https:' || origin.protocol === 'http:') && origin.origin === tuple[0] &&
      value === `wormholesystems:${JSON.stringify([tuple[0], tuple[1]])}`;
  } catch {
    return false;
  }
}

function freshFetchedAt(fetchedAt: string, now = Date.now()): boolean {
  const time = Date.parse(fetchedAt);
  return Number.isFinite(time) && time <= now && now - time <= MAX_SNAPSHOT_AGE_MS;
}

export function validateWormholesystemsTopology(input: unknown): TopologyInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected topology reconciliation object');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['sourceIdentity', 'snapshot', 'systems', 'connections'].includes(key))) throw new Error('Unrecognized topology field');
  if (!validSourceIdentity(value.sourceIdentity)) throw new Error('Invalid canonical source identity');
  if (!value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot)) throw new Error('Validated complete source snapshot evidence is required');
  const evidence = value.snapshot as Record<string, unknown>;
  if (Object.keys(evidence).some(key => !['complete', 'fetchedAt'].includes(key)) ||
    evidence.complete !== true || !validTimestamp(evidence.fetchedAt)) throw new Error('Invalid source completeness or freshness evidence');
  if (!freshFetchedAt(evidence.fetchedAt)) throw new Error('Source snapshot is future-dated or stale');
  if (!Array.isArray(value.systems) || value.systems.length > 100 || !Array.isArray(value.connections) || value.connections.length > 2_000)
    throw new Error('Invalid topology collection bounds');
  const systemIds = new Set<string>(), eveIds = new Set<number>();
  const systems = value.systems.map((item): SystemInput => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid source system');
    const system = item as Record<string, unknown>;
    if (Object.keys(system).some(key => !['sourceSystemId', 'eveSystemId', 'positionX', 'positionY'].includes(key))) throw new Error('Unrecognized source system field');
    if (!safeId(system.sourceSystemId) || !Number.isSafeInteger(system.eveSystemId) || Number(system.eveSystemId) < 1 || Number(system.eveSystemId) > 2_147_483_647 ||
      !finiteCoordinate(system.positionX) || !finiteCoordinate(system.positionY)) throw new Error('Invalid source system identity');
    if (systemIds.has(system.sourceSystemId) || eveIds.has(Number(system.eveSystemId))) throw new Error('Duplicate source system identity');
    systemIds.add(system.sourceSystemId); eveIds.add(Number(system.eveSystemId));
    return { sourceSystemId: system.sourceSystemId, eveSystemId: Number(system.eveSystemId), positionX: Math.fround(system.positionX), positionY: Math.fround(system.positionY) };
  });
  const connectionIds = new Set<string>();
  const connections = value.connections.map((item): ConnectionInput => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid source connection');
    const connection = item as Record<string, unknown>;
    if (Object.keys(connection).some(key => !['sourceConnectionId', 'fromSourceSystemId', 'toSourceSystemId', 'connection_type', 'ship_size'].includes(key)))
      throw new Error('Unrecognized source connection field');
    if (!safeId(connection.sourceConnectionId) || !safeId(connection.fromSourceSystemId) || !safeId(connection.toSourceSystemId) ||
      connection.fromSourceSystemId === connection.toSourceSystemId || !systemIds.has(connection.fromSourceSystemId) || !systemIds.has(connection.toSourceSystemId) ||
      !['standard', 'gate', 'jumpgate', 'cyno'].includes(String(connection.connection_type)) || !['small', 'medium', 'large', 'xl'].includes(String(connection.ship_size)))
      throw new Error('Invalid source connection identity');
    if (connectionIds.has(connection.sourceConnectionId)) throw new Error('Duplicate source connection identity');
    connectionIds.add(connection.sourceConnectionId);
    return { sourceConnectionId: connection.sourceConnectionId, fromSourceSystemId: connection.fromSourceSystemId,
      toSourceSystemId: connection.toSourceSystemId, connectionType: connection.connection_type as ConnectionInput['connectionType'],
      size: connection.ship_size as ConnectionInput['size'] };
  });
  return { sourceIdentity: value.sourceIdentity, snapshot: { complete: true, fetchedAt: new Date(Date.parse(evidence.fetchedAt)).toISOString() }, systems, connections };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function assertFreshSnapshot(input: TopologyInput): void {
  if (!freshFetchedAt(input.snapshot.fetchedAt))
    throw new Error('Source snapshot expired before topology changes were committed');
}

function topologyDigest(input: TopologyInput): string {
  const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const normalized = {
    sourceIdentity: input.sourceIdentity,
    snapshot: input.snapshot,
    systems: [...input.systems].sort((a, b) => compareIds(a.sourceSystemId, b.sourceSystemId)),
    connections: [...input.connections].sort((a, b) => compareIds(a.sourceConnectionId, b.sourceConnectionId)),
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export class TopologyCheckpointConflict extends Error {
  constructor(message: string) { super(message); this.name = 'TopologyCheckpointConflict'; }
}
const managedSystem = (row: Record<string, unknown>) => ({ eveSystemId: row.eve_system_id, positionX: Math.fround(Number(row.position_x)),
  positionY: Math.fround(Number(row.position_y)), name: row.name, systemClass: row.system_class });
const ownedManagedSystem = (managed: Record<string, any>) => ({ eveSystemId: managed.eveSystemId,
  positionX: Math.fround(Number(managed.positionX)), positionY: Math.fround(Number(managed.positionY)),
  name: managed.name, systemClass: managed.systemClass });
const managedConnection = (row: Record<string, unknown>) => ({ sourceId: row.source_id, targetId: row.target_id,
  connectionType: row.connection_type, size: row.size });
const hasManualConnectionData = (row: Record<string, unknown>, hasDependents: boolean) => Boolean(
  row.source_handle || row.target_handle || row.mass_status || row.time_status || row.wh_type || row.flag_icon || row.flag_note ||
  row.flag_blink || row.flag_color || Number(row.mass_used) !== 0 || row.eol_at || row.lifetime_expires_at || row.broken ||
  row.source_signature_id || row.target_signature_id || hasDependents);

/** Reconcile only rows recorded as created by this source on this exact map. */
export class MapLockedError extends Error {
  constructor() { super('Map is locked'); this.name = 'MapLockedError'; }
}

export async function reconcileWormholesystemsTopology(mapId: string, raw: unknown, role: Role) {
  const input = validateWormholesystemsTopology(raw);
  const client = await db.connect();
  const result = { createdSystems: 0, preservedSystems: 0, updatedSystems: 0, deletedSystems: 0,
    createdConnections: 0, preservedConnections: 0, updatedConnections: 0, deletedConnections: 0,
    conflicts: [] as Array<{ itemId: string; reason: string }> };
  try {
    await client.query('BEGIN');
    const map = await client.query<{ locked: boolean; allianceId: number | null }>(
      'SELECT locked, alliance_id AS "allianceId" FROM maps WHERE id=$1 FOR UPDATE', [mapId]);
    if (!map.rows.length) throw new Error('Map not found');
    const mapIsAllianceScoped = map.rows[0].allianceId !== null;
    const canBypassLock = mapIsAllianceScoped ? isAllianceAdmin(role) : isAdmin(role);
    if (map.rows[0].locked && !canBypassLock) throw new MapLockedError();
    assertFreshSnapshot(input);

    const digest = topologyDigest(input);
    const checkpoint = await client.query<{ fetchedAt: Date; payloadDigest: string }>(
      `SELECT fetched_at AS "fetchedAt", payload_digest AS "payloadDigest"
         FROM wormholesystems_topology_checkpoints WHERE map_id=$1 AND source_identity=$2 FOR UPDATE`,
      [mapId, input.sourceIdentity]);
    if (checkpoint.rows.length) {
      const acceptedAt = new Date(checkpoint.rows[0].fetchedAt).getTime();
      const fetchedAt = Date.parse(input.snapshot.fetchedAt);
      if (fetchedAt < acceptedAt) throw new TopologyCheckpointConflict('An older source snapshot has already been accepted');
      if (fetchedAt === acceptedAt) {
        if (digest !== checkpoint.rows[0].payloadDigest)
          throw new TopologyCheckpointConflict('A different topology payload was already accepted at this snapshot timestamp');
        await client.query('COMMIT');
        return result;
      }
    }

    const sde = await client.query<{ id: number; name: string; systemClass: string }>(
      `SELECT id, name, class AS "systemClass" FROM solar_systems WHERE id = ANY($1::int[])`,
      [input.systems.map(system => system.eveSystemId)],
    );
    const sdeById = new Map(sde.rows.map(row => [Number(row.id), row]));
    if (sdeById.size !== input.systems.length) throw new Error('One or more source EVE system IDs are not in the Nexum SDE');

    const desiredSystemIds = new Set(input.systems.map(system => system.sourceSystemId));
    const desiredEveSystemIds = new Set(input.systems.map(system => system.eveSystemId));
    const ownedSystems = await client.query<Owned>(
      `SELECT row_id, managed_json FROM wormholesystems_topology_ownership WHERE map_id=$1 AND source_identity=$2 AND item_kind='system' FOR UPDATE`,
      [mapId, input.sourceIdentity],
    );
    const ownedSystemBySource = new Map(ownedSystems.rows.map(row => [String((row.managed_json as any).sourceSystemId), row]));
    const sourceToRow = new Map<string, string>();
    for (const system of input.systems) {
      const sdeRow = sdeById.get(system.eveSystemId)!;
      const owned = ownedSystemBySource.get(system.sourceSystemId);
      if (owned) {
        const current = await client.query<Record<string, unknown>>(
          `SELECT id, eve_system_id, position_x, position_y, name, system_class, notes, labels, custom_labels, intel, tag, alias
             FROM map_systems WHERE id=$1 AND map_id=$2 FOR UPDATE`, [owned.row_id, mapId]);
        const row = current.rows[0];
        if (!row) {
          result.conflicts.push({ itemId: system.sourceSystemId, reason: 'owned system identity no longer matches source' }); continue;
        }
        const previous = owned.managed_json as any;
        const currentManaged = managedSystem(row);
        if (!same(currentManaged, ownedManagedSystem(previous))) {
          result.conflicts.push({ itemId: system.sourceSystemId, reason: 'managed system was manually changed; preserved' });
          sourceToRow.set(system.sourceSystemId, owned.row_id); continue;
        }
        if (Number(row.eve_system_id) !== system.eveSystemId) {
          const target = await client.query<{ id: string }>(
            `SELECT id FROM map_systems WHERE map_id=$1 AND eve_system_id=$2 AND id<>$3`,
            [mapId, system.eveSystemId, owned.row_id]);
          if (target.rows.length) {
            result.conflicts.push({ itemId: system.sourceSystemId, reason: 'new EVE system identity is already represented by another map system; preserved' });
            sourceToRow.set(system.sourceSystemId, owned.row_id); continue;
          }
        }
        const nextManaged = { sourceSystemId: system.sourceSystemId, eveSystemId: system.eveSystemId, positionX: system.positionX,
          positionY: system.positionY, name: sdeRow.name, systemClass: sdeRow.systemClass };
        if (Number(row.eve_system_id) !== system.eveSystemId || system.positionX !== Number(row.position_x) || system.positionY !== Number(row.position_y) || sdeRow.name !== row.name || sdeRow.systemClass !== row.system_class) {
          await client.query(`UPDATE map_systems SET eve_system_id=$1, position_x=$2, position_y=$3, name=$4, system_class=$5 WHERE id=$6 AND map_id=$7`,
            [system.eveSystemId, system.positionX, system.positionY, sdeRow.name, sdeRow.systemClass, owned.row_id, mapId]);
          result.updatedSystems++;
        }
        await client.query(`UPDATE wormholesystems_topology_ownership SET managed_json=$1 WHERE map_id=$2 AND source_identity=$3 AND item_kind='system' AND source_item_id=$4`,
          [nextManaged, mapId, input.sourceIdentity, system.sourceSystemId]);
        sourceToRow.set(system.sourceSystemId, owned.row_id);
        continue;
      }

      const existing = await client.query<{ id: string }>(`SELECT id FROM map_systems WHERE map_id=$1 AND eve_system_id=$2`, [mapId, system.eveSystemId]);
      if (existing.rows.length > 1) { result.conflicts.push({ itemId: system.sourceSystemId, reason: 'multiple target systems have this EVE identity' }); continue; }
      if (existing.rows.length === 1) {
        if (ownedSystems.rows.some(owner => owner.row_id === existing.rows[0].id)) {
          result.conflicts.push({ itemId: system.sourceSystemId, reason: 'source identity changed for an already-owned system; preserved' }); continue;
        }
        result.preservedSystems++;
        sourceToRow.set(system.sourceSystemId, existing.rows[0].id);
        continue;
      }
      const rowId = crypto.randomUUID();
      const facts = await sdeSystemFacts(system.eveSystemId);
      const managed = { sourceSystemId: system.sourceSystemId, eveSystemId: system.eveSystemId, positionX: system.positionX,
        positionY: system.positionY, name: sdeRow.name, systemClass: sdeRow.systemClass };
      await client.query(
        `INSERT INTO map_systems (id,map_id,eve_system_id,name,system_class,effect,statics,position_x,position_y,status,is_home,locked,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unknown',FALSE,FALSE,'')`,
        [rowId, mapId, system.eveSystemId, sdeRow.name, facts?.systemClass ?? sdeRow.systemClass,
          facts?.effect ?? 'none', facts?.statics ?? [], system.positionX, system.positionY]);
      await client.query(`INSERT INTO wormholesystems_topology_ownership (map_id,source_identity,item_kind,source_item_id,row_id,managed_json)
        VALUES ($1,$2,'system',$3,$4,$5)`, [mapId, input.sourceIdentity, system.sourceSystemId, rowId, managed]);
      sourceToRow.set(system.sourceSystemId, rowId); result.createdSystems++;
    }

    const desiredConnectionIds = new Set(input.connections.map(connection => connection.sourceConnectionId));
    const ownedConnections = await client.query<Owned>(
      `SELECT row_id, managed_json FROM wormholesystems_topology_ownership WHERE map_id=$1 AND source_identity=$2 AND item_kind='connection' FOR UPDATE`,
      [mapId, input.sourceIdentity],
    );
    const ownedConnectionBySource = new Map(ownedConnections.rows.map(row => [String((row.managed_json as any).sourceConnectionId), row]));
    for (const connection of input.connections) {
      const sourceId = sourceToRow.get(connection.fromSourceSystemId), targetId = sourceToRow.get(connection.toSourceSystemId);
      if (!sourceId || !targetId) { result.conflicts.push({ itemId: connection.sourceConnectionId, reason: 'source endpoint is unresolved or ambiguous' }); continue; }
      const owned = ownedConnectionBySource.get(connection.sourceConnectionId);
      if (owned) {
        const current = await client.query<Record<string, unknown>>(
          `SELECT id,source_id,target_id,connection_type,size,source_handle,target_handle,mass_status,time_status,wh_type,flag_icon,flag_note,flag_blink,flag_color,mass_used,eol_at,lifetime_expires_at,broken,source_signature_id,target_signature_id
             FROM map_connections WHERE id=$1 AND map_id=$2 FOR UPDATE`, [owned.row_id, mapId]);
        const row = current.rows[0], previous = owned.managed_json as any;
        if (!row || !same(managedConnection(row), { sourceId: previous.sourceId, targetId: previous.targetId,
          connectionType: previous.connectionType, size: previous.size })) {
          result.conflicts.push({ itemId: connection.sourceConnectionId, reason: 'managed connection was manually changed; preserved' }); continue;
        }
        const endpointChanged = sourceId !== row.source_id || targetId !== row.target_id;
        const manualParallel = endpointChanged ? await client.query(`SELECT 1 FROM map_connections c WHERE c.map_id=$1
          AND ((c.source_id=$2 AND c.target_id=$3) OR (c.source_id=$3 AND c.target_id=$2))
          AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o WHERE o.map_id=c.map_id AND o.source_identity=$4 AND o.item_kind='connection' AND o.row_id=c.id) LIMIT 1`,
          [mapId, sourceId, targetId, input.sourceIdentity]) : { rows: [] };
        const endpointDependents = endpointChanged ? await client.query(`SELECT 1 FROM map_connection_jumps WHERE connection_id=$1
          UNION ALL SELECT 1 FROM map_routes WHERE map_id=$2 AND $1::uuid=ANY(connection_ids) LIMIT 1`, [owned.row_id, mapId]) : { rows: [] };
        if (endpointChanged && (manualParallel.rows.length || hasManualConnectionData(row, endpointDependents.rows.length > 0))) {
          result.conflicts.push({ itemId: connection.sourceConnectionId, reason: 'connection endpoints have manual references; preserved' }); continue;
        }
        const nextManaged = { sourceConnectionId: connection.sourceConnectionId, sourceId, targetId,
          connectionType: connection.connectionType, size: connection.size };
        if (sourceId !== row.source_id || targetId !== row.target_id || connection.connectionType !== row.connection_type || connection.size !== row.size) {
          await client.query(`UPDATE map_connections SET source_id=$1,target_id=$2,connection_type=$3,size=$4 WHERE id=$5 AND map_id=$6`,
            [sourceId, targetId, connection.connectionType, connection.size, owned.row_id, mapId]);
          result.updatedConnections++;
        }
        await client.query(`UPDATE wormholesystems_topology_ownership SET managed_json=$1 WHERE map_id=$2 AND source_identity=$3 AND item_kind='connection' AND source_item_id=$4`,
          [nextManaged, mapId, input.sourceIdentity, connection.sourceConnectionId]);
        continue;
      }
      const parallel = await client.query(`SELECT 1 FROM map_connections c WHERE c.map_id=$1
        AND ((c.source_id=$2 AND c.target_id=$3) OR (c.source_id=$3 AND c.target_id=$2))
        AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o WHERE o.map_id=c.map_id AND o.source_identity=$4 AND o.item_kind='connection' AND o.row_id=c.id) LIMIT 1`,
        [mapId, sourceId, targetId, input.sourceIdentity]);
      if (parallel.rows.length) { result.preservedConnections++; continue; }
      const rowId = crypto.randomUUID();
      const managed = { sourceConnectionId: connection.sourceConnectionId, sourceId, targetId,
        connectionType: connection.connectionType, size: connection.size };
      await client.query(`INSERT INTO map_connections (id,map_id,source_id,target_id,connection_type,size) VALUES ($1,$2,$3,$4,$5,$6)`,
        [rowId, mapId, sourceId, targetId, connection.connectionType, connection.size]);
      await client.query(`INSERT INTO wormholesystems_topology_ownership (map_id,source_identity,item_kind,source_item_id,row_id,managed_json)
        VALUES ($1,$2,'connection',$3,$4,$5)`, [mapId, input.sourceIdentity, connection.sourceConnectionId, rowId, managed]);
      result.createdConnections++;
    }

    // Delete only exact, unchanged rows recorded as created by this source.
    for (const owned of ownedConnections.rows) {
      const sourceConnectionId = String((owned.managed_json as any).sourceConnectionId);
      if (desiredConnectionIds.has(sourceConnectionId)) continue;
      const rowRes = await client.query<Record<string, unknown>>(
        `SELECT id,source_id,target_id,connection_type,size,source_handle,target_handle,mass_status,time_status,wh_type,flag_icon,flag_note,flag_blink,flag_color,mass_used,eol_at,lifetime_expires_at,broken,source_signature_id,target_signature_id
           FROM map_connections WHERE id=$1 AND map_id=$2 FOR UPDATE`, [owned.row_id, mapId]);
      const row = rowRes.rows[0], managed = owned.managed_json as any;
      const dependent = await client.query(`SELECT 1 FROM map_connection_jumps WHERE connection_id=$1
        UNION ALL SELECT 1 FROM map_routes WHERE map_id=$2 AND $1::uuid=ANY(connection_ids) LIMIT 1`, [owned.row_id, mapId]);
      if (!row || !same(managedConnection(row), { sourceId: managed.sourceId, targetId: managed.targetId,
        connectionType: managed.connectionType, size: managed.size }) || hasManualConnectionData(row, dependent.rows.length > 0)) {
        result.conflicts.push({ itemId: sourceConnectionId, reason: 'removed source connection has manual data or changed topology; preserved' }); continue;
      }
      await client.query(`DELETE FROM map_connections WHERE id=$1 AND map_id=$2`, [owned.row_id, mapId]);
      await client.query(`DELETE FROM wormholesystems_topology_ownership WHERE map_id=$1 AND source_identity=$2 AND item_kind='connection' AND source_item_id=$3`,
        [mapId, input.sourceIdentity, sourceConnectionId]);
      result.deletedConnections++;
    }

    for (const owned of ownedSystems.rows) {
      const sourceSystemId = String((owned.managed_json as any).sourceSystemId);
      if (desiredSystemIds.has(sourceSystemId)) continue;
      const rowRes = await client.query<Record<string, unknown>>(
        `SELECT id,eve_system_id,position_x,position_y,name,system_class,status,is_home,locked,notes,labels,custom_labels,intel,tag,alias,npc_type,region_name
           FROM map_systems WHERE id=$1 AND map_id=$2 FOR UPDATE`, [owned.row_id, mapId]);
      const row = rowRes.rows[0], managed = owned.managed_json as any;
      if (row && desiredEveSystemIds.has(Number(row.eve_system_id))) {
        result.conflicts.push({ itemId: sourceSystemId, reason: 'source member identity changed for a still-present EVE system; preserved' }); continue;
      }
      const safeToDelete = row && same(managedSystem(row), ownedManagedSystem(managed)) && !row.notes &&
        !(row.labels as unknown[]).length && !(row.custom_labels as unknown[]).length && !row.intel && !row.tag && !row.alias &&
        row.status === 'unknown' && !row.is_home && !row.locked && !row.npc_type && !row.region_name;
      const related = await client.query(`SELECT 1 FROM map_connections WHERE map_id=$1 AND (source_id=$2 OR target_id=$2)
        UNION ALL SELECT 1 FROM map_signatures WHERE system_id=$2
        UNION ALL SELECT 1 FROM map_anomalies WHERE system_id=$2
        UNION ALL SELECT 1 FROM map_structures WHERE system_id=$2
        UNION ALL SELECT 1 FROM map_routes WHERE map_id=$1 AND $2::uuid=ANY(system_ids) LIMIT 1`, [mapId, owned.row_id]);
      if (!safeToDelete || related.rows.length) {
        result.conflicts.push({ itemId: sourceSystemId, reason: 'removed source system has manual changes or related map data; preserved' }); continue;
      }
      await client.query(`DELETE FROM map_systems WHERE id=$1 AND map_id=$2`, [owned.row_id, mapId]);
      await client.query(`DELETE FROM wormholesystems_topology_ownership WHERE map_id=$1 AND source_identity=$2 AND item_kind='system' AND source_item_id=$3`,
        [mapId, input.sourceIdentity, sourceSystemId]);
      result.deletedSystems++;
    }
    assertFreshSnapshot(input);
    await client.query(
      `INSERT INTO wormholesystems_topology_checkpoints (map_id,source_identity,fetched_at,payload_digest)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (map_id,source_identity) DO UPDATE
         SET fetched_at=EXCLUDED.fetched_at, payload_digest=EXCLUDED.payload_digest, updated_at=NOW()`,
      [mapId, input.sourceIdentity, input.snapshot.fetchedAt, digest]);
    await client.query('COMMIT');
    if (result.createdSystems + result.updatedSystems + result.deletedSystems + result.createdConnections + result.updatedConnections + result.deletedConnections > 0)
      publishToMap(mapId, { type: 'map.resync', actor: null });
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
