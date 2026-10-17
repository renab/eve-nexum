import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../db.js';
import { canEditTopology, isAdmin, isAllianceAdmin, type AuthUser, type Role } from '../middleware/authContext.js';
import { config } from '../config.js';
import { sdeSystemFacts } from './sdeFacts.js';
import { publishToMap } from './mapEvents.js';

type SnapshotEvidence = { complete: true; fetchedAt: string };
type SystemInput = { sourceSystemId: string; eveSystemId: number; positionX: number | null; positionY: number | null };
type SignatureType = 'data' | 'relic' | 'gas' | 'ore' | 'combat' | 'wormhole' | 'ghost' | 'unknown';
type SignatureInput = {
  sourceSignatureId: string;
  sourceSystemId: string;
  sourceConnectionId: string | null;
  sigId: string;
  sigType: SignatureType;
  whType: string;
  name: string | null;
};
type ConnectionInput = {
  sourceConnectionId: string;
  fromSourceSystemId: string;
  toSourceSystemId: string;
  connectionType: 'standard' | 'gate' | 'jumpgate' | 'cyno';
  size: 'small' | 'medium' | 'large' | 'xl' | null;
  sourceSignatureId: string | null;
  targetSignatureId: string | null;
};
type TopologyInput = { schemaVersion: 1 | 2 | 3; sourceIdentity: string; snapshot: SnapshotEvidence; systems: SystemInput[]; signatures: SignatureInput[]; connections: ConnectionInput[] };
type Owned = { row_id: string; source_item_id?: string; managed_json: Record<string, unknown> };

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
  if (Object.keys(value).some(key => !['schemaVersion', 'sourceIdentity', 'snapshot', 'systems', 'signatures', 'connections'].includes(key))) throw new Error('Unrecognized topology field');
  const schemaVersion = value.schemaVersion === undefined ? 1 : value.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) throw new Error('Unsupported topology schema version');
  if (schemaVersion === 1 && value.signatures !== undefined) throw new Error('Signatures require topology schema version 2');
  if (schemaVersion >= 2 && !Array.isArray(value.signatures)) throw new Error('Complete signatures are required for topology schema version 2 or 3');
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
    const positionAbsent = (system.positionX === undefined || system.positionX === null) &&
      (system.positionY === undefined || system.positionY === null);
    const positionPresent = finiteCoordinate(system.positionX) && finiteCoordinate(system.positionY);
    if (!safeId(system.sourceSystemId) || !Number.isSafeInteger(system.eveSystemId) || Number(system.eveSystemId) < 1 || Number(system.eveSystemId) > 2_147_483_647 ||
      (!positionAbsent && !positionPresent)) throw new Error('Invalid source system identity or coordinate pair');
    if (systemIds.has(system.sourceSystemId) || eveIds.has(Number(system.eveSystemId))) throw new Error('Duplicate source system identity');
    systemIds.add(system.sourceSystemId); eveIds.add(Number(system.eveSystemId));
    return { sourceSystemId: system.sourceSystemId, eveSystemId: Number(system.eveSystemId),
      positionX: positionPresent ? Math.fround(system.positionX as number) : null,
      positionY: positionPresent ? Math.fround(system.positionY as number) : null };
  });
  const signatures: SignatureInput[] = [];
  const signatureIds = new Set<string>(), assignedCodesBySystem = new Set<string>();
  if (schemaVersion >= 2) {
    if ((value.signatures as unknown[]).length > 10_000) throw new Error('Invalid signature collection bounds');
    for (const item of value.signatures as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid source signature');
      const signature = item as Record<string, unknown>;
      if (Object.keys(signature).some(key => !['sourceSignatureId', 'sourceSystemId', 'sourceConnectionId', 'sigId', 'sigType', 'whType', ...(schemaVersion === 3 ? ['name'] : [])].includes(key)))
        throw new Error('Unrecognized source signature field');
      const name = signature.name;
      if (schemaVersion === 3 && !(name === null || (typeof name === 'string' && [...name].length >= 1 && [...name].length <= 256 &&
        name.trim() === name && name.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(name))))
        throw new Error('Invalid source signature display name');
      if (!safeId(signature.sourceSignatureId) || !safeId(signature.sourceSystemId) || !systemIds.has(signature.sourceSystemId) ||
        !(signature.sourceConnectionId === undefined || signature.sourceConnectionId === null || safeId(signature.sourceConnectionId)) || typeof signature.sigId !== 'string' || signature.sigId.length > 32 ||
        /[\u0000-\u001f\u007f]/.test(signature.sigId) || !['data', 'relic', 'gas', 'ore', 'combat', 'wormhole', 'ghost', 'unknown'].includes(String(signature.sigType)) ||
        typeof signature.whType !== 'string' || signature.whType.length > 64 || /[\u0000-\u001f\u007f]/.test(signature.whType))
        throw new Error('Invalid source signature identity or managed fields');
      if (signatureIds.has(signature.sourceSignatureId)) throw new Error('Duplicate source signature identity');
      const scannerCode = `${signature.sourceSystemId}\u0000${signature.sigId}`;
      if (signature.sigId !== '' && assignedCodesBySystem.has(scannerCode)) throw new Error('Duplicate assigned source signature code');
      signatureIds.add(signature.sourceSignatureId);
      if (signature.sigId !== '') assignedCodesBySystem.add(scannerCode);
      signatures.push({ sourceSignatureId: signature.sourceSignatureId, sourceSystemId: signature.sourceSystemId,
        sourceConnectionId: (signature.sourceConnectionId ?? null) as string | null, sigId: signature.sigId,
        sigType: signature.sigType as SignatureType, whType: signature.whType,
        name: schemaVersion === 3 ? name as string | null : null });
    }
  }
  const connectionIds = new Set<string>();
  const connections = value.connections.map((item): ConnectionInput => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid source connection');
    const connection = item as Record<string, unknown>;
    if (Object.keys(connection).some(key => !['sourceConnectionId', 'fromSourceSystemId', 'toSourceSystemId', 'connection_type', 'ship_size', 'sourceSignatureId', 'targetSignatureId'].includes(key)))
      throw new Error('Unrecognized source connection field');
    if (!safeId(connection.sourceConnectionId) || !safeId(connection.fromSourceSystemId) || !safeId(connection.toSourceSystemId) ||
      connection.fromSourceSystemId === connection.toSourceSystemId || !systemIds.has(connection.fromSourceSystemId) || !systemIds.has(connection.toSourceSystemId) ||
      !['standard', 'gate', 'jumpgate', 'cyno'].includes(String(connection.connection_type)) ||
      !(connection.ship_size === undefined || connection.ship_size === null || ['small', 'medium', 'large', 'xl'].includes(String(connection.ship_size))))
      throw new Error('Invalid source connection identity');
    if (connectionIds.has(connection.sourceConnectionId)) throw new Error('Duplicate source connection identity');
    connectionIds.add(connection.sourceConnectionId);
    if (schemaVersion >= 2) {
      for (const [refKey, scannerSystemId] of [['sourceSignatureId', connection.fromSourceSystemId], ['targetSignatureId', connection.toSourceSystemId]] as const) {
        const ref = connection[refKey];
        if (!(ref === undefined || ref === null || safeId(ref))) throw new Error('Invalid source connection signature reference');
        if (ref !== undefined && ref !== null) {
          const signature = signatures.find(candidate => candidate.sourceSignatureId === ref);
          if (!signature || signature.sourceConnectionId !== connection.sourceConnectionId || signature.sourceSystemId !== scannerSystemId)
            throw new Error('Source connection signature reference does not match its edge and scanner system');
        }
      }
    } else if (connection.sourceSignatureId !== undefined || connection.targetSignatureId !== undefined) {
      throw new Error('Signature references require topology schema version 2');
    }
    return { sourceConnectionId: connection.sourceConnectionId, fromSourceSystemId: connection.fromSourceSystemId,
      toSourceSystemId: connection.toSourceSystemId, connectionType: connection.connection_type as ConnectionInput['connectionType'],
      size: (connection.ship_size ?? null) as ConnectionInput['size'], sourceSignatureId: (connection.sourceSignatureId ?? null) as string | null,
      targetSignatureId: (connection.targetSignatureId ?? null) as string | null };
  });
  if (schemaVersion >= 2) {
    for (const signature of signatures) {
      if (signature.sourceConnectionId !== null && !connectionIds.has(signature.sourceConnectionId))
        throw new Error('Source signature references a connection absent from the complete map');
      if (signature.sourceConnectionId !== null) {
        const edge = connections.find(connection => connection.sourceConnectionId === signature.sourceConnectionId)!;
        const isSourceScanner = signature.sourceSystemId === edge.fromSourceSystemId;
        const isTargetScanner = signature.sourceSystemId === edge.toSourceSystemId;
        if (!isSourceScanner && !isTargetScanner) throw new Error('Source signature scanner system is not an endpoint of its referenced connection');
        const explicitReference = isSourceScanner ? edge.sourceSignatureId : edge.targetSignatureId;
        if (explicitReference !== signature.sourceSignatureId)
          throw new Error('Source signature edge reference conflicts with the connection-side signature identity');
      }
    }
  }
  return { schemaVersion, sourceIdentity: value.sourceIdentity, snapshot: { complete: true, fetchedAt: new Date(Date.parse(evidence.fetchedAt)).toISOString() }, systems, signatures, connections };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function assertFreshSnapshot(input: TopologyInput): void {
  if (!freshFetchedAt(input.snapshot.fetchedAt))
    throw new Error('Source snapshot expired before topology changes were committed');
}

function topologyDigest(input: TopologyInput): string {
  const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const normalized: Record<string, unknown> = {
    sourceIdentity: input.sourceIdentity,
    snapshot: input.snapshot,
    systems: [...input.systems].sort((a, b) => compareIds(a.sourceSystemId, b.sourceSystemId)),
    connections: [...input.connections].sort((a, b) => compareIds(a.sourceConnectionId, b.sourceConnectionId)).map(connection => input.schemaVersion >= 2
      ? connection
      : { sourceConnectionId: connection.sourceConnectionId, fromSourceSystemId: connection.fromSourceSystemId,
        toSourceSystemId: connection.toSourceSystemId, connectionType: connection.connectionType, size: connection.size }),
  };
  if (input.schemaVersion >= 2) {
    normalized.schemaVersion = input.schemaVersion;
    normalized.signatures = [...input.signatures].sort((a, b) => compareIds(a.sourceSignatureId, b.sourceSignatureId))
      .map(signature => input.schemaVersion === 3 ? signature : ({ sourceSignatureId: signature.sourceSignatureId,
        sourceSystemId: signature.sourceSystemId, sourceConnectionId: signature.sourceConnectionId, sigId: signature.sigId,
        sigType: signature.sigType, whType: signature.whType }));
  }
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
const managedConnection = (row: Record<string, unknown>, includeSignatureRefs = false) => ({ sourceId: row.source_id, targetId: row.target_id,
  connectionType: row.connection_type, size: row.size, ...(includeSignatureRefs
    ? { sourceSignatureRowId: row.source_signature_id ?? null, targetSignatureRowId: row.target_signature_id ?? null } : {}) });
const managedSignature = (row: Record<string, unknown>) => ({ systemId: row.system_id, sigId: row.sig_id,
  sigType: row.sig_type, whType: row.wh_type });
const signatureManagedFields = [
  ['systemId', 'system_id'], ['sigId', 'sig_id'], ['sigType', 'sig_type'], ['whType', 'wh_type'],
] as const;
const systemManagedFields = [
  ['eveSystemId', 'eve_system_id'], ['positionX', 'position_x'], ['positionY', 'position_y'], ['name', 'name'], ['systemClass', 'system_class'],
] as const;
const connectionManagedFields = [
  ['sourceId', 'source_id'], ['targetId', 'target_id'], ['connectionType', 'connection_type'], ['size', 'size'],
  ['sourceSignatureRowId', 'source_signature_id'], ['targetSignatureRowId', 'target_signature_id'],
] as const;
const differingManagedFields = (actual: Record<string, unknown>, expected: Record<string, unknown>, fields: readonly (readonly [string, string])[]) =>
  fields.filter(([key]) => !same(actual[key], expected[key])).map(([, field]) => field);
const signatureManagedFieldDifferences = (actual: Record<string, unknown>, expected: Record<string, unknown>) =>
  differingManagedFields(actual, expected, signatureManagedFields);
const systemManagedFieldDifferences = (actual: Record<string, unknown>, expected: Record<string, unknown>, includePosition = true) =>
  differingManagedFields(actual, expected, includePosition ? systemManagedFields : systemManagedFields.filter(([key]) => key !== 'positionX' && key !== 'positionY'));
const connectionManagedFieldDifferences = (row: Record<string, unknown>, expected: Record<string, unknown>, includeSignatureRefs: boolean) =>
  differingManagedFields(managedConnection(row, includeSignatureRefs), expected,
    includeSignatureRefs ? connectionManagedFields : connectionManagedFields.slice(0, 4));
const manualConnectionGuardFields = (row: Record<string, unknown>, includeSignatureRefs = true) => [
  ...(row.source_handle ? ['source_handle'] : []), ...(row.target_handle ? ['target_handle'] : []),
  ...(row.mass_status ? ['mass_status'] : []), ...(row.time_status ? ['time_status'] : []), ...(row.wh_type ? ['wh_type'] : []),
  ...(row.flag_icon ? ['flag_icon'] : []), ...(row.flag_note ? ['flag_note'] : []), ...(row.flag_blink ? ['flag_blink'] : []),
  ...(row.flag_color ? ['flag_color'] : []), ...(Number(row.mass_used) !== 0 ? ['mass_used'] : []),
  ...(row.eol_at ? ['eol_at'] : []), ...(row.lifetime_expires_at ? ['lifetime_expires_at'] : []), ...(row.broken ? ['broken'] : []),
  ...(includeSignatureRefs && row.source_signature_id ? ['source_signature_id'] : []),
  ...(includeSignatureRefs && row.target_signature_id ? ['target_signature_id'] : []),
];
const manualSystemGuardFields = (row: Record<string, unknown>) => [
  ...(row.notes ? ['notes'] : []), ...((row.labels as unknown[]).length ? ['labels'] : []),
  ...((row.custom_labels as unknown[]).length ? ['custom_labels'] : []), ...(row.intel ? ['intel'] : []),
  ...(row.tag ? ['tag'] : []), ...(row.alias ? ['alias'] : []), ...(row.status !== 'unknown' ? ['status'] : []),
  ...(row.is_home ? ['is_home'] : []), ...(row.locked ? ['locked'] : []), ...(row.npc_type ? ['npc_type'] : []),
  ...(row.region_name ? ['region_name'] : []),
];
const deletionDependencyLabel = (kind: string) => ({
  connection_jump: 'connection jump history', route: 'saved route', connection: 'map connection',
  signature: 'signature', anomaly: 'anomaly', structure: 'structure',
}[kind] ?? kind);
const hasManualConnectionData = (row: Record<string, unknown>, hasDependents: boolean, includeSignatureRefs = true) =>
  manualConnectionGuardFields(row, includeSignatureRefs).length > 0 || hasDependents;
/** Reconcile only rows recorded as created by this source on this exact map. */
export class MapLockedError extends Error {
  constructor() { super('Map is locked'); this.name = 'MapLockedError'; }
}

export class TopologyAccessError extends Error {
  constructor(message: string, readonly status: 403 | 404) { super(message); this.name = 'TopologyAccessError'; }
}

/** Attest only explicitly requested source-signature/row pairs; never enumerate ownership records. */
export async function attestWormholesystemsSignatureOwnership(mapId: string, sourceIdentity: unknown, rawItems: unknown) {
  if (!validSourceIdentity(sourceIdentity) || !Array.isArray(rawItems) || rawItems.length > 500)
    throw new Error('Invalid bounded WormholeSystems ownership attestation request');
  const ids: string[] = [], rowIds: string[] = [], pairs = new Set<string>();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item as Record<string, unknown>).some(key => !['sourceSignatureId', 'rowId'].includes(key)))
      throw new Error('Invalid ownership attestation item');
    const candidate = item as Record<string, unknown>;
    if (!safeId(candidate.sourceSignatureId) || typeof candidate.rowId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.rowId))
      throw new Error('Invalid ownership attestation identity');
    const pair = `${candidate.sourceSignatureId}\u0000${candidate.rowId}`;
    if (pairs.has(pair)) throw new Error('Duplicate ownership attestation identity');
    pairs.add(pair); ids.push(candidate.sourceSignatureId); rowIds.push(candidate.rowId);
  }
  if (!ids.length) return { items: [] };
  const rows = await db.query<{ sourceSignatureId: string; rowId: string; owned: boolean }>(
    `WITH requested AS (
       SELECT source_signature_id, row_id, ordinality
         FROM unnest($3::text[], $4::uuid[]) WITH ORDINALITY AS items(source_signature_id,row_id,ordinality)
     )
     SELECT requested.source_signature_id AS "sourceSignatureId", requested.row_id AS "rowId",
       EXISTS (
         SELECT 1 FROM wormholesystems_topology_ownership ownership
         JOIN map_signatures signature ON signature.id=ownership.row_id
         JOIN map_systems system ON system.id=signature.system_id AND system.map_id=ownership.map_id
        WHERE ownership.map_id=$1 AND ownership.source_identity=$2 AND ownership.item_kind='signature'
          AND ownership.source_item_id=requested.source_signature_id AND ownership.row_id=requested.row_id
       ) AS owned
       FROM requested ORDER BY requested.ordinality`, [mapId, sourceIdentity, ids, rowIds]);
  return { items: rows.rows.map(row => ({ sourceSignatureId: row.sourceSignatureId, rowId: row.rowId, owned: row.owned })) };
}

async function revalidateTopologyAccess(client: PoolClient, mapId: string, actor: AuthUser): Promise<Role> {
  const map = await client.query<{ userId: number; ownerId: number | null; corpId: number | null; allianceId: number | null; locked: boolean }>(
    `SELECT user_id AS "userId",owner_id AS "ownerId",corp_id AS "corpId",alliance_id AS "allianceId",locked
       FROM maps WHERE id=$1 FOR UPDATE`, [mapId]);
  if (!map.rows.length) throw new TopologyAccessError('Map not found', 404);

  const caller = await client.query<{ ownerId: number | null; role: Role; corpId: number | null; allianceId: number | null; characterId: number | null; blocked: boolean }>(
    `SELECT owner_id AS "ownerId",role,corp_id AS "corpId",alliance_id AS "allianceId",character_id AS "characterId",blocked
       FROM users WHERE id=$1 FOR SHARE`, [actor.userId]);
  if (!caller.rows.length || caller.rows[0].blocked || caller.rows[0].characterId == null)
    throw new TopologyAccessError('Current account or character access is unavailable', 403);
  const currentUser = caller.rows[0];

  if (actor.apiTokenId) {
    const token = await client.query<{ ownerId: number; contextUserId: number | null; scope: string; scopeMapId: string | null; expiresAt: Date | null }>(
      `SELECT owner_id AS "ownerId",context_user_id AS "contextUserId",scope,scope_map_id AS "scopeMapId",expires_at AS "expiresAt"
         FROM api_tokens WHERE id=$1 FOR SHARE`, [actor.apiTokenId]);
    const row = token.rows[0];
    if (!row || row.contextUserId !== actor.userId || row.ownerId !== currentUser.ownerId ||
      row.scope !== 'wormholesystems_sync' || row.scopeMapId !== mapId ||
      (row.expiresAt && row.expiresAt.getTime() <= Date.now()))
      throw new TopologyAccessError('The map-bound WormholeSystems key is no longer authorized', 403);
  } else if (actor.apiScope) {
    throw new TopologyAccessError('The map-bound WormholeSystems key is no longer authorized', 403);
  }

  const target = map.rows[0];
  let accessKind: 'owner' | 'corp_member' | 'alliance_member' | 'shared' | null = null;
  let shareCanWrite: boolean | undefined;
  if (target.userId === actor.userId || (target.ownerId != null && currentUser.ownerId != null && target.ownerId === currentUser.ownerId)) {
    accessKind = 'owner';
  } else if (target.corpId !== null && (
    (config.corpMode && config.corpIds.includes(target.corpId) && (config.corpMapShared || target.corpId === currentUser.corpId)) ||
    (config.allianceMode && target.corpId === currentUser.corpId)
  )) {
    accessKind = 'corp_member';
  } else if (config.allianceMode && target.allianceId !== null && config.allianceIds.includes(target.allianceId) &&
    (config.allianceMapShared || target.allianceId === currentUser.allianceId)) {
    accessKind = 'alliance_member';
  } else {
    const share = await client.query<{ canWrite: boolean }>(
      `SELECT can_write AS "canWrite" FROM map_shares
        WHERE map_id=$1 AND (target_character_id=$2 OR ($3::int IS NOT NULL AND target_corp_id=$3)
          OR ($4::int IS NOT NULL AND target_alliance_id=$4))
        ORDER BY can_write DESC LIMIT 1 FOR SHARE`,
      [mapId, currentUser.characterId, currentUser.corpId, currentUser.allianceId]);
    if (share.rows.length) {
      accessKind = 'shared';
      shareCanWrite = share.rows[0].canWrite;
    }
  }
  if (!accessKind) throw new TopologyAccessError('Map not found', 404);
  if (accessKind === 'shared' && shareCanWrite === false)
    throw new TopologyAccessError('This map was shared with you view-only', 403);
  if (accessKind !== 'owner' && !canEditTopology(currentUser.role))
    throw new TopologyAccessError('Topology-edit permission required', 403);
  const canBypassLock = target.allianceId !== null ? isAllianceAdmin(currentUser.role) : isAdmin(currentUser.role);
  if (target.locked && !canBypassLock) throw new MapLockedError();
  return currentUser.role;
}

export async function reconcileWormholesystemsTopology(mapId: string, raw: unknown, actor: AuthUser) {
  const input = validateWormholesystemsTopology(raw);
  const client = await db.connect();
  const result: Record<string, any> = { createdSystems: 0, preservedSystems: 0, updatedSystems: 0, deletedSystems: 0,
    createdSignatures: 0, preservedSignatures: 0, updatedSignatures: 0, deletedSignatures: 0,
    createdConnections: 0, preservedConnections: 0, updatedConnections: 0, deletedConnections: 0,
    conflicts: [] as Array<Record<string, unknown>>,
    diagnostics: [] as Array<{ itemId: string; reason: string }>,
    mappings: { systems: [] as Array<{ sourceId: string; rowId: string; ownership: 'owned' | 'preserved' }>,
      signatures: [] as Array<{ sourceId: string; rowId: string; ownership: 'owned' | 'preserved' }>,
      connections: [] as Array<{ sourceId: string; rowId: string; ownership: 'owned' | 'preserved' }> },
    snapshotFetchedAt: input.snapshot.fetchedAt, payloadDigest: '',
    checkpoint: { accepted: false, replayed: false, partial: false as boolean | null } };
  const outcomeKinds = ['system', 'signature', 'connection'] as const;
  const outcomeClasses = ['blocked', 'preserved', 'skipped_deletion', 'deleted'] as const;
  const MAX_OUTCOME_REASON_CODES = 8;
  const outcomeTotals: Record<string, Record<string, number>> = Object.fromEntries(outcomeKinds.map(kind =>
    [kind, Object.fromEntries(outcomeClasses.map(outcome => [outcome, 0]))]));
  const outcomeDetails: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(outcomeClasses.map(outcome => [outcome, []]));
  const outcomeOmitted: Record<string, number> = Object.fromEntries(outcomeClasses.map(outcome => [outcome, 0]));
  const recordedOutcomes = new Set<string>();
  let conflictCount = 0, conflictsOmitted = 0, diagnosticsOmitted = 0;
  const compareText = (a: unknown, b: unknown) => String(a ?? '').localeCompare(String(b ?? ''));
  const compareOutcome = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    compareText(a.itemKind, b.itemKind) || compareText(a.sourceItemId, b.sourceItemId) ||
    compareText(a.reasonCode, b.reasonCode) || compareText((a.dependency as any)?.kind, (b.dependency as any)?.kind) ||
    compareText((a.dependency as any)?.id, (b.dependency as any)?.id);
  const compareConflict = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    compareOutcome(a, b) || compareText(JSON.stringify(a.fields ?? []), JSON.stringify(b.fields ?? []));
  const insertBoundedCanonical = (items: Array<Record<string, unknown>>, item: Record<string, unknown>, compare: typeof compareOutcome) => {
    items.push(item);
    items.sort(compare);
    if (items.length > 256) items.pop();
  };
  const addDiagnostic = (item: { itemId: string; reason: string }) => {
    if (result.diagnostics.length < 256) result.diagnostics.push(item);
    else diagnosticsOmitted++;
  };
  const recordOutcome = (itemKind: typeof outcomeKinds[number], sourceItemId: string, outcome: typeof outcomeClasses[number],
    reasonCode: string, fields: string[] = [], nexumRowId?: string, dependency?: { kind: string; id: string }) => {
    const key = `${itemKind}\u0000${sourceItemId}\u0000${outcome}`;
    if (recordedOutcomes.has(key)) {
      const existing = outcomeDetails[outcome].find(item => item.itemKind === itemKind && item.sourceItemId === sourceItemId);
      if (existing) {
        const existingReasons = (existing.reasonCodes as Array<{ reasonCode: string; fields?: string[] }> | undefined) ??
          [{ reasonCode: String(existing.reasonCode), ...(Array.isArray(existing.fields) ? { fields: existing.fields as string[] } : {}) }];
        const reason = existingReasons.find(item => item.reasonCode === reasonCode);
        if (reason) {
          if (fields.length) reason.fields = [...new Set([...(reason.fields ?? []), ...fields])].sort();
        } else if (existingReasons.length < MAX_OUTCOME_REASON_CODES) {
          existingReasons.push({ reasonCode, ...(fields.length ? { fields: [...new Set(fields)].sort() } : {}) });
        } else {
          existing.reasonCodesOmitted = Number(existing.reasonCodesOmitted ?? 0) + 1;
        }
        existingReasons.sort((a, b) => compareText(a.reasonCode, b.reasonCode));
        if (existingReasons.length > 1) {
          existing.reasonCodes = existingReasons;
          existing.reasonCode = existingReasons[0].reasonCode;
        }
        const mergedFields = [...new Set([...(existing.fields as string[] ?? []), ...fields])].sort();
        if (mergedFields.length) existing.fields = mergedFields;
        if (!existing.nexumRowId && nexumRowId) existing.nexumRowId = nexumRowId;
      }
      return;
    }
    recordedOutcomes.add(key);
    outcomeTotals[itemKind][outcome]++;
    const details = outcomeDetails[outcome];
    const item = { itemKind, sourceItemId, reasonCode, ...(fields.length ? { fields } : {}),
      ...(nexumRowId ? { nexumRowId } : {}), ...(dependency ? { dependency } : {}) };
    insertBoundedCanonical(details, item, compareOutcome);
    outcomeOmitted[outcome] = Math.max(0, outcomeTotals.system[outcome] + outcomeTotals.signature[outcome] +
      outcomeTotals.connection[outcome] - details.length);
  };
  const reasonCodeFor = (reason: string): string => {
    if (input.schemaVersion === 3) {
      if (reason.includes('name identity')) return 'name_identity_conflict';
      if (reason.includes('matching signature belongs to a different source')) return 'name_ownership_unknown';
      if (reason.includes('manual signature name')) return 'manual_name_not_managed';
    }
    if (reason.includes('managed signature') || reason.includes('signature ownership identity')) return 'managed_field_conflict';
    if (reason.includes('matching signature belongs to a different source')) return 'source_ownership_conflict';
    if (reason.includes('matching manual signature')) return 'managed_field_conflict';
    if (reason.includes('scanner system')) return 'scanner_system_unresolved';
    if (reason.includes('multiple target')) return 'target_identity_ambiguous';
    if (reason.includes('scan code')) return 'signature_code_collision';
    if (reason.includes('connection') || reason.includes('endpoint')) return 'dependency_or_identity_conflict';
    if (reason.includes('system')) return 'managed_identity_or_dependency_conflict';
    return 'managed_field_conflict';
  };
  const fieldsForReason = (reason: string): string[] => {
    if (reason.includes('scanner system')) return ['system_id'];
    if (reason.includes('signature scan code') || reason.includes('target signatures')) return ['sig_id'];
    return [];
  };
  const recordConflict = (itemKind: typeof outcomeKinds[number], sourceItemId: string, reason: string,
    explicitReasonCode?: string, fields: string[] = fieldsForReason(reason), nexumRowId?: string,
    dependency?: { kind: string; id: string }, outcomeClass?: typeof outcomeClasses[number] | null) => {
    const nameSpecificReasonCodes = ['name_identity_conflict', 'name_ownership_unknown', 'manual_name_not_managed'];
    const reasonCode = explicitReasonCode && (input.schemaVersion === 3 || !nameSpecificReasonCodes.includes(explicitReasonCode))
      ? explicitReasonCode : reasonCodeFor(reason);
    const preserved = /preserved|manual signature|manual connection|already represented/i.test(reason);
    conflictCount++;
    insertBoundedCanonical(result.conflicts, { itemId: sourceItemId, reason, itemKind, sourceItemId, reasonCode,
      ...(fields.length ? { fields } : {}), ...(nexumRowId ? { nexumRowId } : {}), ...(dependency ? { dependency } : {}) }, compareConflict);
    conflictsOmitted = Math.max(0, conflictCount - result.conflicts.length);
    const classification = outcomeClass === undefined ? (preserved ? 'preserved' : 'blocked') : outcomeClass;
    if (classification) recordOutcome(itemKind, sourceItemId, classification, reasonCode, fields, nexumRowId, dependency);
  };
  const recordSkippedDeletion = (kind: typeof outcomeKinds[number], sourceItemId: string, reasonCode: string, fields: string[] = [],
    dependency?: { kind: string; id: string }) =>
    recordOutcome(kind, sourceItemId, 'skipped_deletion', reasonCode, fields, undefined, dependency);
  try {
    await client.query('BEGIN');
    await revalidateTopologyAccess(client, mapId, actor);
    assertFreshSnapshot(input);

    const digest = topologyDigest(input);
    const checkpoint = await client.query<{ fetchedAt: Date; payloadDigest: string; schemaVersion: number; result: Record<string, unknown> | null }>(
      `SELECT fetched_at AS "fetchedAt", payload_digest AS "payloadDigest", schema_version AS "schemaVersion", result_json AS result
         FROM wormholesystems_topology_checkpoints WHERE map_id=$1 AND source_identity=$2 FOR UPDATE`,
      [mapId, input.sourceIdentity]);
    result.payloadDigest = digest;
    if (checkpoint.rows.length) {
      const acceptedSchemaVersion = Number(checkpoint.rows[0].schemaVersion);
      if (input.schemaVersion < acceptedSchemaVersion)
        throw new TopologyCheckpointConflict(`Topology schema version ${acceptedSchemaVersion} has already been accepted for this map and source`);
      const acceptedAt = new Date(checkpoint.rows[0].fetchedAt).getTime();
      const fetchedAt = Date.parse(input.snapshot.fetchedAt);
      if (fetchedAt < acceptedAt) throw new TopologyCheckpointConflict('An older source snapshot has already been accepted');
      if (fetchedAt === acceptedAt) {
        if (digest !== checkpoint.rows[0].payloadDigest)
          throw new TopologyCheckpointConflict('A different topology payload was already accepted at this snapshot timestamp');
        await client.query('COMMIT');
        const saved = checkpoint.rows[0].result;
        const countFields = ['createdSystems', 'preservedSystems', 'updatedSystems', 'deletedSystems',
          'createdSignatures', 'preservedSignatures', 'updatedSignatures', 'deletedSignatures',
          'createdConnections', 'preservedConnections', 'updatedConnections', 'deletedConnections'];
        const hasSavedOutcome = saved && typeof saved === 'object' && !Array.isArray(saved) &&
          countFields.every(field => typeof saved[field] === 'number');
        if (hasSavedOutcome) {
          const savedPartial = (saved as any).checkpoint?.partial;
          return { ...saved, checkpoint: { accepted: true, replayed: true,
            partial: typeof savedPartial === 'boolean' ? savedPartial : null } };
        }
        return { snapshotFetchedAt: input.snapshot.fetchedAt, payloadDigest: digest,
          checkpoint: { accepted: true, replayed: true, partial: null }, replayedFromLegacyCheckpoint: true };
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
      `SELECT source_item_id, row_id, managed_json FROM wormholesystems_topology_ownership WHERE map_id=$1 AND source_identity=$2 AND item_kind='system' FOR UPDATE`,
      [mapId, input.sourceIdentity],
    );
    const ownedSystemBySource = new Map(ownedSystems.rows.map(row => [String(row.source_item_id), row]));
    const sourceToRow = new Map<string, string>();
    const conflictedOwnedSystemRowIds = new Set<string>();
    for (const system of input.systems) {
      const sdeRow = sdeById.get(system.eveSystemId)!;
      const hasPosition = system.positionX !== null && system.positionY !== null;
       if (!hasPosition) addDiagnostic({ itemId: system.sourceSystemId, reason: 'position_unavailable' });
      const owned = ownedSystemBySource.get(system.sourceSystemId);
      if (owned) {
        const current = await client.query<Record<string, unknown>>(
          `SELECT id, eve_system_id, position_x, position_y, name, system_class, notes, labels, custom_labels, intel, tag, alias
             FROM map_systems WHERE id=$1 AND map_id=$2 FOR UPDATE`, [owned.row_id, mapId]);
        const row = current.rows[0];
        if (!row) {
          recordConflict('system', system.sourceSystemId, 'owned system identity no longer matches source'); continue;
        }
        const previous = owned.managed_json as any;
        const currentManaged = managedSystem(row);
        const expectedManaged = ownedManagedSystem(previous);
        const changedManagedFields = systemManagedFieldDifferences(currentManaged, expectedManaged, false);
        if (owned.source_item_id !== system.sourceSystemId || previous.sourceSystemId !== system.sourceSystemId || changedManagedFields.length) {
          recordConflict('system', system.sourceSystemId, 'managed system was manually changed; preserved', undefined, changedManagedFields);
          continue;
        }
        if (Number(row.eve_system_id) !== system.eveSystemId) {
          const target = await client.query<{ id: string }>(
            `SELECT id FROM map_systems WHERE map_id=$1 AND eve_system_id=$2 AND id<>$3`,
            [mapId, system.eveSystemId, owned.row_id]);
          if (target.rows.length) {
            recordConflict('system', system.sourceSystemId, 'new EVE system identity is already represented by another map system; preserved');
            continue;
          }
        }
        const nextPositionX = hasPosition ? system.positionX! : expectedManaged.positionX;
        const nextPositionY = hasPosition ? system.positionY! : expectedManaged.positionY;
        const positionX = hasPosition ? system.positionX! : Math.fround(Number(row.position_x));
        const positionY = hasPosition ? system.positionY! : Math.fround(Number(row.position_y));
        const nextManaged = { sourceSystemId: system.sourceSystemId, eveSystemId: system.eveSystemId, positionX: nextPositionX,
          positionY: nextPositionY, name: sdeRow.name, systemClass: sdeRow.systemClass };
        if (Number(row.eve_system_id) !== system.eveSystemId || (hasPosition && (system.positionX !== Math.fround(Number(row.position_x)) ||
          system.positionY !== Math.fround(Number(row.position_y)))) || sdeRow.name !== row.name || sdeRow.systemClass !== row.system_class) {
          await client.query(`UPDATE map_systems SET eve_system_id=$1, position_x=$2, position_y=$3, name=$4, system_class=$5 WHERE id=$6 AND map_id=$7`,
            [system.eveSystemId, positionX, positionY, sdeRow.name, sdeRow.systemClass, owned.row_id, mapId]);
          result.updatedSystems++;
        }
        await client.query(`UPDATE wormholesystems_topology_ownership SET managed_json=$1 WHERE map_id=$2 AND source_identity=$3 AND item_kind='system' AND source_item_id=$4`,
          [nextManaged, mapId, input.sourceIdentity, system.sourceSystemId]);
        sourceToRow.set(system.sourceSystemId, owned.row_id);
        result.mappings.systems.push({ sourceId: system.sourceSystemId, rowId: owned.row_id, ownership: 'owned' });
        continue;
      }

      const existing = await client.query<{ id: string }>(`SELECT id FROM map_systems WHERE map_id=$1 AND eve_system_id=$2`, [mapId, system.eveSystemId]);
      if (existing.rows.length > 1) { recordConflict('system', system.sourceSystemId, 'multiple target systems have this EVE identity'); continue; }
      if (existing.rows.length === 1) {
        if (ownedSystems.rows.some(owner => owner.row_id === existing.rows[0].id)) {
          conflictedOwnedSystemRowIds.add(String(existing.rows[0].id));
          recordConflict('system', system.sourceSystemId, 'source identity changed for an already-owned system; preserved'); continue;
        }
        result.preservedSystems++;
        sourceToRow.set(system.sourceSystemId, existing.rows[0].id);
        result.mappings.systems.push({ sourceId: system.sourceSystemId, rowId: existing.rows[0].id, ownership: 'preserved' });
        continue;
      }
      const rowId = crypto.randomUUID();
      const facts = await sdeSystemFacts(system.eveSystemId);
      const insertedClass = sdeRow.systemClass;
      const positionX = hasPosition ? system.positionX! : 0;
      const positionY = hasPosition ? system.positionY! : 0;
      const managed = { sourceSystemId: system.sourceSystemId, eveSystemId: system.eveSystemId, positionX,
        positionY, name: sdeRow.name, systemClass: insertedClass };
      if (hasPosition) {
        await client.query(
          `INSERT INTO map_systems (id,map_id,eve_system_id,name,system_class,effect,statics,position_x,position_y,status,is_home,locked,notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unknown',FALSE,FALSE,'')`,
          [rowId, mapId, system.eveSystemId, sdeRow.name, insertedClass,
            facts?.effect ?? 'none', facts?.statics ?? [], positionX, positionY]);
      } else {
        await client.query(
          `INSERT INTO map_systems (id,map_id,eve_system_id,name,system_class,effect,statics,status,is_home,locked,notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'unknown',FALSE,FALSE,'')`,
          [rowId, mapId, system.eveSystemId, sdeRow.name, insertedClass, facts?.effect ?? 'none', facts?.statics ?? []]);
      }
      await client.query(`INSERT INTO wormholesystems_topology_ownership (map_id,source_identity,item_kind,source_item_id,row_id,managed_json)
        VALUES ($1,$2,'system',$3,$4,$5)`, [mapId, input.sourceIdentity, system.sourceSystemId, rowId, managed]);
      sourceToRow.set(system.sourceSystemId, rowId); result.createdSystems++;
      result.mappings.systems.push({ sourceId: system.sourceSystemId, rowId, ownership: 'owned' });
    }

    const conflictedSourceSystemIds = new Set(input.systems
      .filter(system => !sourceToRow.has(system.sourceSystemId))
      .map(system => system.sourceSystemId));
    for (const owned of ownedSystems.rows) {
      if (conflictedSourceSystemIds.has(String(owned.source_item_id))) {
        conflictedOwnedSystemRowIds.add(String(owned.row_id));
      }
    }

    const signatureToRow = new Map<string, { rowId: string; systemId: string; ownership: 'owned' | 'preserved'; compatible: boolean }>();
    const changedSignatureSystems = new Set<string>();
    const desiredSignatureIds = new Set(input.signatures.map(signature => signature.sourceSignatureId));
    const ownedSignatures = input.schemaVersion >= 2 ? await client.query<Owned>(
      `SELECT source_item_id, row_id, managed_json FROM wormholesystems_topology_ownership WHERE map_id=$1 AND source_identity=$2 AND item_kind='signature' FOR UPDATE`,
      [mapId, input.sourceIdentity]) : { rows: [] as Owned[] };
    const ownedSignatureBySource = new Map(ownedSignatures.rows.map(row => [String((row.managed_json as any).sourceSignatureId), row]));

    for (const signature of input.signatures) {
      const scannerSystemId = sourceToRow.get(signature.sourceSystemId);
      if (!scannerSystemId) {
        recordConflict('signature', signature.sourceSignatureId, 'scanner system is unresolved or ambiguous');
        continue;
      }
      const owned = ownedSignatureBySource.get(signature.sourceSignatureId);
      if (owned) {
        const previous = owned.managed_json as any;
        if (owned.source_item_id !== signature.sourceSignatureId || previous.sourceSignatureId !== signature.sourceSignatureId) {
          recordConflict('signature', signature.sourceSignatureId, 'signature source ownership identity mismatch; preserved',
            'source_ownership_identity_mismatch', ['source_item_id'], String(owned.row_id), undefined, 'blocked');
          continue;
        }
        const current = await client.query<Record<string, unknown>>(
          `SELECT id,system_id,sig_id,sig_type,wh_type,name,notes,wh_leads_to,ghost_type,mass_status,time_status,
                   created_by_user_id,from_merge,scout_connection_id,scout_last_seen
             FROM map_signatures WHERE id=$1 AND system_id IN (SELECT id FROM map_systems WHERE map_id=$2) FOR UPDATE`, [owned.row_id, mapId]);
        const row = current.rows[0];
        const changedManagedFields = row ? signatureManagedFieldDifferences(managedSignature(row), { systemId: previous.systemId,
          sigId: previous.sigId, sigType: previous.sigType, whType: previous.whType }) : [];
        if (!row || changedManagedFields.length) {
          const nameIdentityConflict = input.schemaVersion === 3 && (!row || changedManagedFields.includes('system_id') || changedManagedFields.includes('sig_id'));
          recordConflict('signature', signature.sourceSignatureId, 'managed signature was manually changed or moved; preserved',
            nameIdentityConflict ? 'name_identity_conflict' : undefined, changedManagedFields);
          continue;
        }
        const collision = signature.sigId === '' ? { rows: [] } : await client.query<{ id: string }>(
          `SELECT id FROM map_signatures WHERE system_id=$1 AND sig_id=$2 AND id<>$3 FOR UPDATE`, [scannerSystemId, signature.sigId, owned.row_id]);
        if (collision.rows.length) {
          recordConflict('signature', signature.sourceSignatureId, 'signature scan code is already represented by another target row');
          continue;
        }
        const nextName = input.schemaVersion === 3 && signature.name !== null ? signature.name : String(row.name ?? '');
        if (row.system_id !== scannerSystemId || row.sig_id !== signature.sigId || row.sig_type !== signature.sigType ||
          row.wh_type !== signature.whType || row.name !== nextName) {
          await client.query(`UPDATE map_signatures SET system_id=$1,sig_id=$2,sig_type=$3,wh_type=$4,name=$5,updated_at=NOW() WHERE id=$6`,
            [scannerSystemId, signature.sigId, signature.sigType, signature.whType, nextName, owned.row_id]);
          result.updatedSignatures++;
          changedSignatureSystems.add(scannerSystemId);
          if (row.system_id !== scannerSystemId) changedSignatureSystems.add(String(row.system_id));
        }
        const managed = { sourceSignatureId: signature.sourceSignatureId, sourceSystemId: signature.sourceSystemId,
          systemId: scannerSystemId, sigId: signature.sigId, sigType: signature.sigType, whType: signature.whType,
          ...(input.schemaVersion === 3 ? { name: nextName } : {}) };
        await client.query(`UPDATE wormholesystems_topology_ownership SET managed_json=$1 WHERE map_id=$2 AND source_identity=$3 AND item_kind='signature' AND source_item_id=$4`,
          [managed, mapId, input.sourceIdentity, signature.sourceSignatureId]);
        signatureToRow.set(signature.sourceSignatureId, { rowId: owned.row_id, systemId: scannerSystemId, ownership: 'owned', compatible: true });
        result.mappings.signatures.push({ sourceId: signature.sourceSignatureId, rowId: owned.row_id, ownership: 'owned' });
        continue;
      }

      // Only an exact assigned code can identify a compatible manual row. Empty
      // codes remain independent source-ID-owned rows and are never adopted.
      const matches = signature.sigId === '' ? { rows: [] as Record<string, unknown>[] } : await client.query<Record<string, unknown>>(
        `SELECT id,system_id,sig_id,sig_type,wh_type,name FROM map_signatures WHERE system_id=$1 AND sig_id=$2 ORDER BY id FOR UPDATE`,
        [scannerSystemId, signature.sigId]);
      if (matches.rows.length > 1) {
        recordConflict('signature', signature.sourceSignatureId, 'multiple target signatures have the exact scanner code');
        continue;
      }
      if (matches.rows.length === 1) {
        const manual = matches.rows[0];
        const claimed = await client.query(`SELECT 1 FROM wormholesystems_topology_ownership WHERE map_id=$1 AND item_kind='signature' AND row_id=$2 LIMIT 1`,
          [mapId, manual.id]);
        if (claimed.rows.length) {
          recordConflict('signature', signature.sourceSignatureId, 'matching signature belongs to a different source identity; preserved',
            input.schemaVersion === 3 ? 'name_ownership_unknown' : 'source_ownership_conflict',
            input.schemaVersion === 3 ? ['name'] : [], String(manual.id));
          continue;
        }
        const mismatchedFields = [
          ...(manual.sig_type !== signature.sigType ? ['sig_type'] : []),
          ...(manual.wh_type !== signature.whType ? ['wh_type'] : []),
        ];
        const compatible = mismatchedFields.length === 0;
        if (!compatible) recordConflict('signature', signature.sourceSignatureId, 'matching manual signature has different managed type fields; preserved',
          'managed_field_conflict', mismatchedFields, String(manual.id));
        if (input.schemaVersion === 3 && signature.name !== null && manual.name !== signature.name)
          recordConflict('signature', signature.sourceSignatureId, 'matching manual signature name is not source-managed; preserved',
            'manual_name_not_managed', ['name'], String(manual.id));
        result.preservedSignatures++;
        signatureToRow.set(signature.sourceSignatureId, { rowId: String(manual.id), systemId: scannerSystemId, ownership: 'preserved', compatible });
        result.mappings.signatures.push({ sourceId: signature.sourceSignatureId, rowId: String(manual.id), ownership: 'preserved' });
        continue;
      }

      const rowId = crypto.randomUUID();
      const createdName = input.schemaVersion === 3 ? signature.name ?? '' : '';
      await client.query(`INSERT INTO map_signatures (id,system_id,sig_id,sig_type,wh_type,name) VALUES ($1,$2,$3,$4,$5,$6)`,
        [rowId, scannerSystemId, signature.sigId, signature.sigType, signature.whType, createdName]);
      const managed = { sourceSignatureId: signature.sourceSignatureId, sourceSystemId: signature.sourceSystemId,
        systemId: scannerSystemId, sigId: signature.sigId, sigType: signature.sigType, whType: signature.whType,
        ...(input.schemaVersion === 3 ? { name: createdName } : {}) };
      await client.query(`INSERT INTO wormholesystems_topology_ownership (map_id,source_identity,item_kind,source_item_id,row_id,managed_json)
        VALUES ($1,$2,'signature',$3,$4,$5)`, [mapId, input.sourceIdentity, signature.sourceSignatureId, rowId, managed]);
      signatureToRow.set(signature.sourceSignatureId, { rowId, systemId: scannerSystemId, ownership: 'owned', compatible: true });
      result.createdSignatures++;
      result.mappings.signatures.push({ sourceId: signature.sourceSignatureId, rowId, ownership: 'owned' });
      changedSignatureSystems.add(scannerSystemId);
    }

    const desiredConnectionIds = new Set(input.connections.map(connection => connection.sourceConnectionId));
    const ownedConnections = await client.query<Owned>(
      `SELECT source_item_id, row_id, managed_json FROM wormholesystems_topology_ownership WHERE map_id=$1 AND source_identity=$2 AND item_kind='connection' FOR UPDATE`,
      [mapId, input.sourceIdentity],
    );
    const ownedConnectionBySource = new Map(ownedConnections.rows.map(row => [String((row.managed_json as any).sourceConnectionId), row]));
    const sourceEndpointCounts = new Map<string, number>();
    for (const connection of input.connections) {
      const key = [connection.fromSourceSystemId, connection.toSourceSystemId].sort().join('\u0000');
      sourceEndpointCounts.set(key, (sourceEndpointCounts.get(key) ?? 0) + 1);
    }
    for (const connection of input.connections) {
      const sourceId = sourceToRow.get(connection.fromSourceSystemId), targetId = sourceToRow.get(connection.toSourceSystemId);
      if (!sourceId || !targetId) {
        const unresolvedFields = [...(!sourceId ? ['source_id'] : []), ...(!targetId ? ['target_id'] : [])];
        recordConflict('connection', connection.sourceConnectionId, 'source endpoint is unresolved or ambiguous', undefined, unresolvedFields);
        continue;
      }
      let signatureReferenceUnresolved = false;
      const signatureRef = (sourceSignatureId: string | null, expectedSystemId: string, side: 'source' | 'target'): string | null => {
        if (sourceSignatureId === null) return null;
        const mapping = signatureToRow.get(sourceSignatureId);
        if (!mapping || mapping.systemId !== expectedSystemId || !mapping.compatible) {
          signatureReferenceUnresolved = true;
          recordConflict('connection', connection.sourceConnectionId, `${side} signature is unresolved, incompatible, or not on the exact scanner system`,
            undefined, [`${side}_signature_id`]);
          return null;
        }
        return mapping.rowId;
      };
      const sourceSignatureRowId = input.schemaVersion >= 2 ? signatureRef(connection.sourceSignatureId, sourceId, 'source') : null;
      const targetSignatureRowId = input.schemaVersion >= 2 ? signatureRef(connection.targetSignatureId, targetId, 'target') : null;
      const owned = ownedConnectionBySource.get(connection.sourceConnectionId);
      if (owned) {
        const previous = owned.managed_json as any;
        if (owned.source_item_id !== connection.sourceConnectionId || previous.sourceConnectionId !== connection.sourceConnectionId) {
          recordConflict('connection', connection.sourceConnectionId, 'connection source ownership identity mismatch; preserved',
            'source_ownership_identity_mismatch', ['source_item_id'], String(owned.row_id), undefined, 'blocked');
          continue;
        }
        const current = await client.query<Record<string, unknown>>(
          `SELECT id,source_id,target_id,connection_type,size,source_handle,target_handle,mass_status,time_status,wh_type,flag_icon,flag_note,flag_blink,flag_color,mass_used,eol_at,lifetime_expires_at,broken,source_signature_id,target_signature_id
             FROM map_connections WHERE id=$1 AND map_id=$2 FOR UPDATE`, [owned.row_id, mapId]);
        const row = current.rows[0];
        const expectedManaged = { sourceId: previous.sourceId, targetId: previous.targetId,
          connectionType: previous.connectionType, size: previous.size,
          ...(input.schemaVersion >= 2 ? { sourceSignatureRowId: previous.sourceSignatureRowId ?? null,
            targetSignatureRowId: previous.targetSignatureRowId ?? null } : {}) };
        const changedManagedFields = row ? connectionManagedFieldDifferences(row, expectedManaged, input.schemaVersion >= 2) : [];
        if (!row || changedManagedFields.length) {
          recordConflict('connection', connection.sourceConnectionId, 'managed connection was manually changed; preserved', undefined, changedManagedFields); continue;
        }
        const endpointChanged = sourceId !== row.source_id || targetId !== row.target_id;
        const refsChanged = input.schemaVersion >= 2 && (sourceSignatureRowId !== (row.source_signature_id ?? null) ||
          targetSignatureRowId !== (row.target_signature_id ?? null));
        const manualParallel = endpointChanged ? await client.query(`SELECT 1 FROM map_connections c WHERE c.map_id=$1
          AND ((c.source_id=$2 AND c.target_id=$3) OR (c.source_id=$3 AND c.target_id=$2))
          AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o WHERE o.map_id=c.map_id AND o.source_identity=$4 AND o.item_kind='connection' AND o.row_id=c.id) LIMIT 1`,
          [mapId, sourceId, targetId, input.sourceIdentity]) : { rows: [] };
        const endpointDependents = endpointChanged ? await client.query(`SELECT 1 FROM map_connection_jumps WHERE connection_id=$1
          UNION ALL SELECT 1 FROM map_routes WHERE map_id=$2 AND $1::uuid=ANY(connection_ids) LIMIT 1`, [owned.row_id, mapId]) : { rows: [] };
        if ((endpointChanged && (manualParallel.rows.length || hasManualConnectionData(row, endpointDependents.rows.length > 0, input.schemaVersion < 2))) ||
          (refsChanged && hasManualConnectionData(row, false, false))) {
          recordConflict('connection', connection.sourceConnectionId, 'connection has manual data or references; preserved'); continue;
        }
        const nextSize = connection.size ?? String(row.size);
        const nextManaged = { sourceConnectionId: connection.sourceConnectionId, sourceId, targetId,
          connectionType: connection.connectionType, size: connection.size ?? previous.size,
          ...(input.schemaVersion >= 2 ? { sourceSignatureId: connection.sourceSignatureId, targetSignatureId: connection.targetSignatureId,
            sourceSignatureRowId, targetSignatureRowId } : {}) };
        if (sourceId !== row.source_id || targetId !== row.target_id || connection.connectionType !== row.connection_type ||
          (connection.size !== null && connection.size !== row.size) || refsChanged) {
          if (input.schemaVersion >= 2) {
            await client.query(`UPDATE map_connections SET source_id=$1,target_id=$2,connection_type=$3,size=$4,source_signature_id=$5,target_signature_id=$6 WHERE id=$7 AND map_id=$8`,
              [sourceId, targetId, connection.connectionType, nextSize, sourceSignatureRowId, targetSignatureRowId, owned.row_id, mapId]);
          } else {
            await client.query(`UPDATE map_connections SET source_id=$1,target_id=$2,connection_type=$3,size=$4 WHERE id=$5 AND map_id=$6`,
              [sourceId, targetId, connection.connectionType, nextSize, owned.row_id, mapId]);
          }
          result.updatedConnections++;
        }
        await client.query(`UPDATE wormholesystems_topology_ownership SET managed_json=$1 WHERE map_id=$2 AND source_identity=$3 AND item_kind='connection' AND source_item_id=$4`,
          [nextManaged, mapId, input.sourceIdentity, connection.sourceConnectionId]);
        result.mappings.connections.push({ sourceId: connection.sourceConnectionId, rowId: owned.row_id, ownership: 'owned' });
        continue;
      }
      const parallel = await client.query<{ id: string; source_id: string; target_id: string; connection_type: string; size: string; source_signature_id: string | null; target_signature_id: string | null }>(`SELECT c.id,c.source_id,c.target_id,c.connection_type,c.size,c.source_signature_id,c.target_signature_id FROM map_connections c WHERE c.map_id=$1
        AND ((c.source_id=$2 AND c.target_id=$3) OR (c.source_id=$3 AND c.target_id=$2))
        AND NOT EXISTS (SELECT 1 FROM wormholesystems_topology_ownership o WHERE o.map_id=c.map_id AND o.item_kind='connection' AND o.row_id=c.id)
        ORDER BY c.id FOR UPDATE`,
        [mapId, sourceId, targetId]);
      const endpointKey = [connection.fromSourceSystemId, connection.toSourceSystemId].sort().join('\u0000');
      const onlySourceForEndpoints = sourceEndpointCounts.get(endpointKey) === 1;
      const onlyManualCandidate = parallel.rows.length === 1 ? parallel.rows[0] : null;
      const refsCompatible = input.schemaVersion < 2 || (onlyManualCandidate && (
        onlyManualCandidate.source_id === sourceId && onlyManualCandidate.target_id === targetId
          ? (onlyManualCandidate.source_signature_id ?? null) === sourceSignatureRowId &&
            (onlyManualCandidate.target_signature_id ?? null) === targetSignatureRowId
          : (onlyManualCandidate.source_signature_id ?? null) === targetSignatureRowId &&
            (onlyManualCandidate.target_signature_id ?? null) === sourceSignatureRowId));
       const manualCompatible = onlySourceForEndpoints && onlyManualCandidate && !signatureReferenceUnresolved && refsCompatible &&
         onlyManualCandidate.connection_type === connection.connectionType &&
         (connection.size === null || onlyManualCandidate.size === connection.size);
      if (manualCompatible && onlyManualCandidate) {
        result.preservedConnections++;
        result.mappings.connections.push({ sourceId: connection.sourceConnectionId, rowId: onlyManualCandidate.id, ownership: 'preserved' });
        continue;
      }
      const rowId = crypto.randomUUID();
      const storedSize = connection.size ?? 'large';
      const managed = { sourceConnectionId: connection.sourceConnectionId, sourceId, targetId,
        connectionType: connection.connectionType, size: storedSize,
        ...(input.schemaVersion >= 2 ? { sourceSignatureId: connection.sourceSignatureId, targetSignatureId: connection.targetSignatureId,
          sourceSignatureRowId, targetSignatureRowId } : {}) };
      if (input.schemaVersion >= 2) {
        if (connection.size === null) {
          await client.query(`INSERT INTO map_connections (id,map_id,source_id,target_id,connection_type,source_signature_id,target_signature_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [rowId, mapId, sourceId, targetId, connection.connectionType, sourceSignatureRowId, targetSignatureRowId]);
        } else {
          await client.query(`INSERT INTO map_connections (id,map_id,source_id,target_id,connection_type,size,source_signature_id,target_signature_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [rowId, mapId, sourceId, targetId, connection.connectionType, connection.size, sourceSignatureRowId, targetSignatureRowId]);
        }
      } else {
        if (connection.size === null) {
          await client.query(`INSERT INTO map_connections (id,map_id,source_id,target_id,connection_type) VALUES ($1,$2,$3,$4,$5)`,
            [rowId, mapId, sourceId, targetId, connection.connectionType]);
        } else {
          await client.query(`INSERT INTO map_connections (id,map_id,source_id,target_id,connection_type,size) VALUES ($1,$2,$3,$4,$5,$6)`,
            [rowId, mapId, sourceId, targetId, connection.connectionType, connection.size]);
        }
      }
      if (connection.size === null) addDiagnostic({ itemId: connection.sourceConnectionId, reason: 'defaulted' });
      await client.query(`INSERT INTO wormholesystems_topology_ownership (map_id,source_identity,item_kind,source_item_id,row_id,managed_json)
        VALUES ($1,$2,'connection',$3,$4,$5)`, [mapId, input.sourceIdentity, connection.sourceConnectionId, rowId, managed]);
      result.createdConnections++;
      result.mappings.connections.push({ sourceId: connection.sourceConnectionId, rowId, ownership: 'owned' });
    }

    // Delete only exact, unchanged rows recorded as created by this source.
    for (const owned of ownedConnections.rows) {
      const managed = owned.managed_json as any;
      const sourceConnectionId = String(managed.sourceConnectionId);
      if (desiredConnectionIds.has(sourceConnectionId)) continue;
      if (owned.source_item_id !== sourceConnectionId || managed.sourceConnectionId !== sourceConnectionId) {
        recordConflict('connection', sourceConnectionId, 'connection source ownership identity mismatch; preserved',
          'source_ownership_identity_mismatch', ['source_item_id'], String(owned.row_id), undefined, null);
        recordSkippedDeletion('connection', sourceConnectionId, 'source_ownership_identity_mismatch', ['source_item_id']);
        continue;
      }
      const conflictedSystemId = [String(managed.sourceId), String(managed.targetId)]
        .find(systemId => conflictedOwnedSystemRowIds.has(systemId));
      if (conflictedSystemId) {
        recordSkippedDeletion('connection', sourceConnectionId, 'source_system_identity_conflict', [], { kind: 'system', id: conflictedSystemId }); continue;
      }
      const rowRes = await client.query<Record<string, unknown>>(
        `SELECT id,source_id,target_id,connection_type,size,source_handle,target_handle,mass_status,time_status,wh_type,flag_icon,flag_note,flag_blink,flag_color,mass_used,eol_at,lifetime_expires_at,broken,source_signature_id,target_signature_id
           FROM map_connections WHERE id=$1 AND map_id=$2 FOR UPDATE`, [owned.row_id, mapId]);
      const row = rowRes.rows[0];
      const dependent = await client.query<{ kind: string; id: string }>(`SELECT kind,id FROM (
        SELECT 'connection_jump'::text AS kind,id::text AS id FROM map_connection_jumps WHERE connection_id=$1
        UNION ALL SELECT 'route'::text AS kind,id::text AS id FROM map_routes WHERE map_id=$2 AND $1::uuid=ANY(connection_ids)
       ) AS dependencies ORDER BY kind,id LIMIT 1`, [owned.row_id, mapId]);
      const expectedManaged = { sourceId: managed.sourceId, targetId: managed.targetId,
        connectionType: managed.connectionType, size: managed.size,
        ...(input.schemaVersion >= 2 ? { sourceSignatureRowId: managed.sourceSignatureRowId ?? null,
          targetSignatureRowId: managed.targetSignatureRowId ?? null } : {}) };
      const changedManagedFields = row ? connectionManagedFieldDifferences(row, expectedManaged, input.schemaVersion >= 2) : [];
      const manualGuardFields = row ? manualConnectionGuardFields(row, input.schemaVersion < 2) : [];
      const deletionGuardFields = [...new Set([...changedManagedFields, ...manualGuardFields])];
      const dependency = dependent.rows[0];
      if (!row || deletionGuardFields.length || dependency) {
        const dependencyInfo = dependency ? { kind: dependency.kind, id: dependency.id } : undefined;
        const dependencyOnly = Boolean(dependency && deletionGuardFields.length === 0);
        const reason = dependencyOnly
          ? `removed source connection is referenced by ${deletionDependencyLabel(dependency.kind)}; preserved`
          : 'removed source connection has manual data or changed topology; preserved';
        const reasonCode = dependency ? `dependent_${dependency.kind}` : 'unsafe_absent_owned_connection';
        recordConflict('connection', sourceConnectionId, reason, reasonCode, deletionGuardFields, undefined, dependencyInfo, null);
        recordSkippedDeletion('connection', sourceConnectionId, dependency ? `dependent_${dependency.kind}` : 'manual_or_managed_change',
          deletionGuardFields, dependencyInfo); continue;
      }
      await client.query(`DELETE FROM map_connections WHERE id=$1 AND map_id=$2`, [owned.row_id, mapId]);
      await client.query(`DELETE FROM wormholesystems_topology_ownership WHERE map_id=$1 AND source_identity=$2 AND item_kind='connection' AND source_item_id=$3`,
        [mapId, input.sourceIdentity, sourceConnectionId]);
      result.deletedConnections++;
      recordOutcome('connection', sourceConnectionId, 'deleted', 'source_owned_connection_deleted', [], String(owned.row_id));
    }

    // Connections release their managed references before absent source-owned
    // signatures are considered for deletion. Any surviving reference blocks
    // signature deletion and therefore cannot cascade through manual content.
    if (input.schemaVersion >= 2) {
      for (const owned of ownedSignatures.rows) {
        const managed = owned.managed_json as any;
        const sourceSignatureId = String(managed.sourceSignatureId);
        if (desiredSignatureIds.has(sourceSignatureId)) continue;
        if (owned.source_item_id !== sourceSignatureId || managed.sourceSignatureId !== sourceSignatureId) {
          recordConflict('signature', sourceSignatureId, 'signature source ownership identity mismatch; preserved',
            'source_ownership_identity_mismatch', ['source_item_id'], String(owned.row_id), undefined, null);
          recordSkippedDeletion('signature', sourceSignatureId, 'source_ownership_identity_mismatch', ['source_item_id']);
          continue;
        }
        if (conflictedSourceSystemIds.has(String(managed.sourceSystemId)) ||
          conflictedOwnedSystemRowIds.has(String(managed.systemId))) {
          recordSkippedDeletion('signature', sourceSignatureId, 'source_system_identity_conflict'); continue;
        }
        const rowRes = await client.query<Record<string, unknown>>(
          `SELECT id,system_id,sig_id,sig_type,wh_type,name,notes,wh_leads_to,ghost_type,mass_status,time_status,
                  created_by_user_id,from_merge,scout_connection_id,scout_last_seen
             FROM map_signatures WHERE id=$1 AND system_id IN (SELECT id FROM map_systems WHERE map_id=$2) FOR UPDATE`, [owned.row_id, mapId]);
        const row = rowRes.rows[0];
        const dependent = await client.query<{ source_signature_reference: boolean; target_signature_reference: boolean }>(
          `SELECT source_signature_id=$2 AS source_signature_reference, target_signature_id=$2 AS target_signature_reference
             FROM map_connections WHERE map_id=$1 AND (source_signature_id=$2 OR target_signature_id=$2) LIMIT 1`,
          [mapId, owned.row_id]);
        const expectedManaged = { systemId: managed.systemId, sigId: managed.sigId,
          sigType: managed.sigType, whType: managed.whType };
        const changedManagedFields = row ? [
          ...(!same(row.system_id, expectedManaged.systemId) ? ['system_id'] : []),
          ...(!same(row.sig_id, expectedManaged.sigId) ? ['sig_id'] : []),
          ...(!same(row.sig_type, expectedManaged.sigType) ? ['sig_type'] : []),
          ...(!same(row.wh_type, expectedManaged.whType) ? ['wh_type'] : []),
        ] : [];
        const manualGuardFields = row ? [
          ...(row.wh_leads_to ? ['wh_leads_to'] : []),
          ...(row.ghost_type ? ['ghost_type'] : []),
          ...(row.mass_status ? ['mass_status'] : []),
          ...(row.time_status ? ['time_status'] : []),
          ...(row.created_by_user_id ? ['created_by_user_id'] : []),
          ...(row.from_merge ? ['from_merge'] : []),
          ...(row.scout_connection_id ? ['scout_connection_id'] : []),
          ...(row.scout_last_seen ? ['scout_last_seen'] : []),
        ] : [];
        const dependencyFields = dependent.rows.flatMap(reference => [
          ...(reference.source_signature_reference ? ['source_signature_id'] : []),
          ...(reference.target_signature_reference ? ['target_signature_id'] : []),
        ]);
        const deletionGuardFields = [...new Set([...changedManagedFields, ...manualGuardFields, ...dependencyFields])];
        if (!row || deletionGuardFields.length) {
          recordConflict('signature', sourceSignatureId, 'removed source signature has manual data, changed fields, or connection references; preserved',
            'unsafe_absent_owned_signature', deletionGuardFields, undefined, undefined, null);
          recordSkippedDeletion('signature', sourceSignatureId, dependent.rows.length ? 'dependent_connection' : 'manual_or_managed_change',
            deletionGuardFields);
          continue;
        }
        await client.query('DELETE FROM map_signatures WHERE id=$1', [owned.row_id]);
        await client.query(`DELETE FROM wormholesystems_topology_ownership WHERE map_id=$1 AND source_identity=$2 AND item_kind='signature' AND source_item_id=$3`,
          [mapId, input.sourceIdentity, sourceSignatureId]);
        result.deletedSignatures++;
        recordOutcome('signature', sourceSignatureId, 'deleted', 'source_owned_signature_deleted', [], String(owned.row_id));
        changedSignatureSystems.add(String(row.system_id));
      }
    }

    for (const owned of ownedSystems.rows) {
      const sourceSystemId = String(owned.source_item_id ?? (owned.managed_json as any).sourceSystemId);
      if (desiredSystemIds.has(sourceSystemId)) continue;
      const managed = owned.managed_json as any;
      if (managed.sourceSystemId !== sourceSystemId) {
        recordConflict('system', sourceSystemId, 'source system ownership identity mismatch; preserved',
          'source_ownership_identity_mismatch', ['source_system_id'], undefined, undefined, null);
        recordSkippedDeletion('system', sourceSystemId, 'source_ownership_identity_mismatch', ['source_system_id']);
        continue;
      }
      const rowRes = await client.query<Record<string, unknown>>(
        `SELECT id,eve_system_id,position_x,position_y,name,system_class,status,is_home,locked,notes,labels,custom_labels,intel,tag,alias,npc_type,region_name
           FROM map_systems WHERE id=$1 AND map_id=$2 FOR UPDATE`, [owned.row_id, mapId]);
      const row = rowRes.rows[0];
      if (row && desiredEveSystemIds.has(Number(row.eve_system_id))) {
        recordConflict('system', sourceSystemId, 'source member identity changed for a still-present EVE system; preserved',
          'source_system_identity_conflict', ['eve_system_id'], undefined, undefined, null);
        recordSkippedDeletion('system', sourceSystemId, 'source_system_identity_conflict', ['eve_system_id']);
        continue;
      }
      const changedManagedFields = row ? systemManagedFieldDifferences(managedSystem(row), ownedManagedSystem(managed)) : [];
      const manualGuardFields = row ? manualSystemGuardFields(row) : [];
      const deletionGuardFields = [...new Set([...changedManagedFields, ...manualGuardFields])];
      const related = await client.query<{ kind: string; id: string }>(`SELECT kind,id FROM (
        SELECT 'connection'::text AS kind,id::text AS id FROM map_connections WHERE map_id=$1 AND (source_id=$2 OR target_id=$2)
        UNION ALL SELECT 'signature'::text AS kind,id::text AS id FROM map_signatures WHERE system_id=$2
        UNION ALL SELECT 'anomaly'::text AS kind,id::text AS id FROM map_anomalies WHERE system_id=$2
        UNION ALL SELECT 'structure'::text AS kind,id::text AS id FROM map_structures WHERE system_id=$2
        UNION ALL SELECT 'route'::text AS kind,id::text AS id FROM map_routes WHERE map_id=$1 AND $2::uuid=ANY(system_ids)
       ) AS dependencies ORDER BY kind,id LIMIT 1`, [mapId, owned.row_id]);
      const dependency = related.rows[0];
      if (!row || deletionGuardFields.length || dependency) {
        const dependencyInfo = dependency ? { kind: dependency.kind, id: dependency.id } : undefined;
        const dependencyOnly = Boolean(dependency && deletionGuardFields.length === 0);
        const reason = dependencyOnly
          ? `removed source system is referenced by ${deletionDependencyLabel(dependency.kind)}; preserved`
          : 'removed source system has manual changes or related map data; preserved';
        const reasonCode = dependency ? `dependent_${dependency.kind}` : 'unsafe_absent_owned_system';
        recordConflict('system', sourceSystemId, reason, reasonCode, deletionGuardFields, undefined, dependencyInfo, null);
        recordSkippedDeletion('system', sourceSystemId, dependency ? `dependent_${dependency.kind}` : 'manual_or_managed_change',
          deletionGuardFields, dependencyInfo); continue;
      }
      await client.query(`DELETE FROM map_systems WHERE id=$1 AND map_id=$2`, [owned.row_id, mapId]);
      await client.query(`DELETE FROM wormholesystems_topology_ownership WHERE map_id=$1 AND source_identity=$2 AND item_kind='system' AND source_item_id=$3`,
        [mapId, input.sourceIdentity, sourceSystemId]);
      result.deletedSystems++;
      recordOutcome('system', sourceSystemId, 'deleted', 'source_owned_system_deleted', [], String(owned.row_id));
    }
    assertFreshSnapshot(input);
    for (const outcome of outcomeClasses) outcomeDetails[outcome].sort(compareOutcome);
    result.conflicts.sort(compareConflict);
    result.conflictCount = conflictCount;
    result.conflictsOmitted = conflictsOmitted;
    result.diagnosticsOmitted = diagnosticsOmitted;
    result.outcomes = { totalsByKind: outcomeTotals, items: outcomeDetails, omittedByOutcome: outcomeOmitted };
    result.checkpoint = { accepted: true, replayed: false, partial: result.conflicts.length > 0 };
    await client.query(
      `INSERT INTO wormholesystems_topology_checkpoints (map_id,source_identity,fetched_at,payload_digest,schema_version,result_json)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (map_id,source_identity) DO UPDATE
         SET fetched_at=EXCLUDED.fetched_at, payload_digest=EXCLUDED.payload_digest, schema_version=EXCLUDED.schema_version,
             result_json=EXCLUDED.result_json, updated_at=NOW()`,
      [mapId, input.sourceIdentity, input.snapshot.fetchedAt, digest, input.schemaVersion, result]);
    await client.query('COMMIT');
    if (result.createdSystems + result.updatedSystems + result.deletedSystems + result.createdSignatures + result.updatedSignatures +
      result.deletedSignatures + result.createdConnections + result.updatedConnections + result.deletedConnections > 0)
      publishToMap(mapId, { type: 'map.resync', actor: null });
    for (const systemId of changedSignatureSystems) publishToMap(mapId, { type: 'sig.changed', actor: null, systemId });
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
