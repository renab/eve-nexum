import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db.js';
import { generateApiKey } from '../utils/apiKeys.js';
import { ensureIntegrationDb, seedUser, truncateAll } from '../test/integrationDb.js';
import { apiV1Router } from './apiV1.js';
import { keysRouter } from './keys.js';
import { mapsRouter } from './maps.js';

const dbReady = await ensureIntegrationDb();
const sourceIdentity = 'wormholesystems:["https://source.example","map-1"]';

function freshSnapshot(complete = true) {
  return { complete, fetchedAt: new Date().toISOString() };
}

async function newerSnapshot(previousFetchedAt: string) {
  while (Date.now() <= Date.parse(previousFetchedAt)) await new Promise(resolve => setTimeout(resolve, 1));
  return freshSnapshot();
}

describe.skipIf(!dbReady)('WormholeSystems API key topology reconciliation (integration)', () => {
  let mapId: string;
  let otherMapId: string;
  let rawKey: string;
  let userId: number;

  function app() {
    const server = express();
    server.use(express.json());
    server.use('/api/v1', apiV1Router);
    return server;
  }

  function mapsApp() {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { session: Record<string, unknown> }).session = {
        userId, characterId: 880_000_001, role: 'admin', userCorpId: null, userAllianceId: null,
      };
      next();
    });
    server.use('/api/maps', mapsRouter);
    return server;
  }

  async function waitForLockWait(queryFragment: string, blockingPid: number): Promise<boolean> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const waiting = await db.query<{ waiting: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity AS activity
         WHERE activity.wait_event_type='Lock' AND activity.query LIKE $1
           AND $2::integer = ANY(pg_blocking_pids(activity.pid))
      ) AS waiting`, [`%${queryFragment}%`, blockingPid]);
      if (waiting.rows[0].waiting) return true;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
  }

  function keysApp(sessionUserId: number, ownerId: number) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as express.Request & { session: Record<string, unknown> }).session = { userId: sessionUserId, ownerId };
      next();
    });
    server.use('/api/keys', keysRouter);
    return server;
  }

  async function sendTopology(payload: Record<string, unknown>, pathMapId = mapId) {
    return request(app()).put(`/api/v1/maps/${pathMapId}/wormholesystems/topology`)
      .set('Authorization', `Bearer ${rawKey}`).send(payload);
  }

  beforeEach(async () => {
    await truncateAll();
    userId = await seedUser({ characterId: 880_000_001, role: 'admin' });
    const ownerId = (await db.query<{ id: number }>('INSERT INTO owners DEFAULT VALUES RETURNING id')).rows[0].id;
    await db.query('UPDATE users SET owner_id=$1 WHERE id=$2', [ownerId, userId]);
    mapId = (await db.query<{ id: string }>('INSERT INTO maps (user_id,owner_id,name) VALUES ($1,$2,$3) RETURNING id', [userId, ownerId, 'Target'])).rows[0].id;
    otherMapId = (await db.query<{ id: string }>('INSERT INTO maps (user_id,owner_id,name) VALUES ($1,$2,$3) RETURNING id', [userId, ownerId, 'Other'])).rows[0].id;
    await db.query(`INSERT INTO solar_systems (id,name,class) VALUES (31000001,'J100001','C2'),(31000002,'J100002','C3')`);
    const key = generateApiKey(); rawKey = key.raw;
    await db.query(`INSERT INTO api_tokens (owner_id,context_user_id,token_hash,token_prefix,name,scope,scope_map_id)
      VALUES ($1,$2,$3,$4,'WormholeSystems','wormholesystems_sync',$5)`, [ownerId, userId, key.hash, key.prefix, mapId]);
  });

  it('binds the higher scope to one map and reconciles only proven-owned topology', async () => {
    const payload = {
      sourceIdentity,
      snapshot: freshSnapshot(),
      systems: [
        { sourceSystemId: 'member-1', eveSystemId: 31_000_001, positionX: 10, positionY: 20 },
        { sourceSystemId: 'member-2', eveSystemId: 31_000_002, positionX: 30, positionY: 40 },
      ],
      connections: [{ sourceConnectionId: 'edge-1', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: 'large' }],
    };
    expect((await request(app()).get('/api/v1/maps').set('Authorization', `Bearer ${rawKey}`)).body.maps.map((map: any) => map.id)).toEqual([mapId]);
    expect((await sendTopology(payload, otherMapId)).status).toBe(403);

    const created = await sendTopology(payload);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ createdSystems: 2, createdConnections: 1 });
    const replay = await sendTopology(payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ createdSystems: 0, createdConnections: 0, updatedSystems: 0, updatedConnections: 0 });

    const older = structuredClone(payload);
    older.snapshot = { complete: true, fetchedAt: new Date(Date.parse(payload.snapshot.fetchedAt) - 1_000).toISOString() };
    expect((await sendTopology(older)).status).toBe(409);

    const moved = structuredClone(payload);
    (moved.systems[0] as any).positionX = 15;
    expect((await sendTopology(moved)).status).toBe(409);
    moved.snapshot = freshSnapshot();
    expect((await sendTopology(moved)).body.updatedSystems).toBe(1);
    const edgeRemoved = await sendTopology({ ...moved, snapshot: freshSnapshot(), connections: [] });
    expect(edgeRemoved.body.deletedConnections).toBe(1);
    const allRemoved = await sendTopology({ ...moved, snapshot: freshSnapshot(), systems: [], connections: [] });
    expect(allRemoved.body.deletedSystems).toBe(2);
    expect((await db.query('SELECT 1 FROM map_systems WHERE map_id=$1', [mapId])).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM wormholesystems_topology_ownership WHERE map_id=$1', [mapId])).rows).toHaveLength(0);
  });

  it('keeps one source identity from updating or deleting another identity’s owned topology', async () => {
    const firstSource = sourceIdentity;
    const secondSource = 'wormholesystems:["https://other.example","map-1"]';
    const payload = {
      sourceIdentity: firstSource,
      snapshot: freshSnapshot(),
      systems: [
        { sourceSystemId: 'member-1', eveSystemId: 31_000_001, positionX: 10, positionY: 20 },
        { sourceSystemId: 'member-2', eveSystemId: 31_000_002, positionX: 30, positionY: 40 },
      ],
      connections: [{ sourceConnectionId: 'edge-1', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: 'large' }],
    };
    expect((await sendTopology(payload)).status).toBe(200);

    const otherSource = { ...payload, sourceIdentity: secondSource, snapshot: freshSnapshot(), systems: [], connections: [] };
    expect((await sendTopology(otherSource)).status).toBe(200);
    expect((await db.query('SELECT 1 FROM map_systems WHERE map_id=$1', [mapId])).rows).toHaveLength(2);
    expect((await db.query('SELECT 1 FROM map_connections WHERE map_id=$1', [mapId])).rows).toHaveLength(1);
    expect((await db.query('SELECT DISTINCT source_identity FROM wormholesystems_topology_ownership WHERE map_id=$1', [mapId])).rows)
      .toEqual([{ source_identity: firstSource }]);
  });

  it('preserves matching manual systems and connections without claiming them', async () => {
    const systemIds = (await Promise.all([31_000_001, 31_000_002].map(async (eveSystemId, index) =>
      (await db.query<{ id: string }>(`INSERT INTO map_systems (id,map_id,eve_system_id,name,system_class,notes,custom_labels)
        VALUES ($1,$2,$3,$4,'C2','manual note',ARRAY['t:manual']) RETURNING id`,
      [crypto.randomUUID(), mapId, eveSystemId, `Manual ${index}`])).rows[0].id))).map(row => row);
    await db.query(`INSERT INTO map_connections (id,map_id,source_id,target_id,connection_type) VALUES ($1,$2,$3,$4,'standard')`,
      [crypto.randomUUID(), mapId, systemIds[0], systemIds[1]]);
    const payload = {
      sourceIdentity,
      snapshot: freshSnapshot(),
      systems: [
        { sourceSystemId: 'member-1', eveSystemId: 31_000_001, positionX: 10, positionY: 20 },
        { sourceSystemId: 'member-2', eveSystemId: 31_000_002, positionX: 30, positionY: 40 },
      ],
      connections: [{ sourceConnectionId: 'edge-1', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: 'large' }],
    };
    const result = await sendTopology(payload);
    expect(result.body).toMatchObject({ createdSystems: 0, preservedSystems: 2, createdConnections: 0, preservedConnections: 1 });
    const empty = await sendTopology({ ...payload, snapshot: freshSnapshot(), systems: [], connections: [] });
    expect(empty.body).toMatchObject({ deletedSystems: 0, deletedConnections: 0 });
    expect((await db.query('SELECT notes,custom_labels FROM map_systems WHERE map_id=$1 ORDER BY eve_system_id', [mapId])).rows)
      .toEqual([{ notes: 'manual note', custom_labels: ['t:manual'] }, { notes: 'manual note', custom_labels: ['t:manual'] }]);
  });

  it('replays fractional REAL coordinates and then updates and deletes owned topology', async () => {
    const payload = {
      sourceIdentity,
      snapshot: freshSnapshot(),
      systems: [
        { sourceSystemId: 'fraction-1', eveSystemId: 31_000_001, positionX: 10.1, positionY: 20.2 },
        { sourceSystemId: 'fraction-2', eveSystemId: 31_000_002, positionX: 30.3, positionY: 40.4 },
      ],
      connections: [{ sourceConnectionId: 'fraction-edge', fromSourceSystemId: 'fraction-1', toSourceSystemId: 'fraction-2',
        connection_type: 'standard', ship_size: 'large' }],
    };
    expect((await sendTopology(payload)).body.createdSystems).toBe(2);
    expect((await sendTopology(payload)).body).toMatchObject({ updatedSystems: 0, updatedConnections: 0, createdSystems: 0 });

    const moved = structuredClone(payload);
    (moved.systems[0] as any).positionX = 11.1;
    moved.snapshot = freshSnapshot();
    expect((await sendTopology(moved)).body.updatedSystems).toBe(1);
    expect((await sendTopology({ ...moved, snapshot: freshSnapshot(), connections: [] })).body.deletedConnections).toBe(1);
    expect((await sendTopology({ ...moved, snapshot: freshSnapshot(), systems: [], connections: [] })).body.deletedSystems).toBe(2);
  });

  it('remaps an unchanged source-owned system to a new EVE ID and updates its ownership baseline', async () => {
    await db.query(`INSERT INTO solar_systems (id,name,class) VALUES (31000003,'J100003','C4')`);
    const payload = {
      sourceIdentity, snapshot: freshSnapshot(),
      systems: [{ sourceSystemId: 'remap-member', eveSystemId: 31_000_001, positionX: 10, positionY: 20 }],
      connections: [],
    };
    expect((await sendTopology(payload)).body.createdSystems).toBe(1);
    const before = (await db.query<{ id: string }>('SELECT id FROM map_systems WHERE map_id=$1', [mapId])).rows[0].id;
    const remapped = { ...payload, snapshot: await newerSnapshot(payload.snapshot.fetchedAt),
      systems: [{ ...payload.systems[0], eveSystemId: 31_000_003 }] };

    const result = await sendTopology(remapped);
    expect(result.body).toMatchObject({ updatedSystems: 1, conflicts: [] });
    expect((await db.query('SELECT id,eve_system_id FROM map_systems WHERE map_id=$1', [mapId])).rows)
      .toEqual([{ id: before, eve_system_id: 31_000_003 }]);
    expect((await db.query<{ managed_json: Record<string, unknown> }>(
      `SELECT managed_json FROM wormholesystems_topology_ownership WHERE map_id=$1 AND source_item_id='remap-member'`, [mapId])).rows[0].managed_json)
      .toMatchObject({ eveSystemId: 31_000_003 });
  });

  it('preserves a manually edited owned system instead of treating its EVE-ID change as a managed remap', async () => {
    await db.query(`INSERT INTO solar_systems (id,name,class) VALUES (31000003,'J100003','C4')`);
    const payload = {
      sourceIdentity, snapshot: freshSnapshot(),
      systems: [{ sourceSystemId: 'edited-remap-member', eveSystemId: 31_000_001, positionX: 10, positionY: 20 }],
      connections: [],
    };
    expect((await sendTopology(payload)).body.createdSystems).toBe(1);
    await db.query('UPDATE map_systems SET position_x=99 WHERE map_id=$1', [mapId]);
    const remapped = { ...payload, snapshot: await newerSnapshot(payload.snapshot.fetchedAt),
      systems: [{ ...payload.systems[0], eveSystemId: 31_000_003 }] };

    const result = await sendTopology(remapped);
    expect(result.body).toMatchObject({ updatedSystems: 0, conflicts: [
      { itemId: 'edited-remap-member', reason: 'managed system was manually changed; preserved' },
    ] });
    expect((await db.query('SELECT eve_system_id,position_x FROM map_systems WHERE map_id=$1', [mapId])).rows)
      .toEqual([{ eve_system_id: 31_000_001, position_x: 99 }]);
    expect((await db.query<{ managed_json: Record<string, unknown> }>(
      `SELECT managed_json FROM wormholesystems_topology_ownership WHERE map_id=$1`, [mapId])).rows[0].managed_json)
      .toMatchObject({ eveSystemId: 31_000_001 });
  });

  it('preserves a managed system when its remap target is already represented by another map system', async () => {
    await db.query(`INSERT INTO solar_systems (id,name,class) VALUES (31000003,'J100003','C4')`);
    const payload = {
      sourceIdentity, snapshot: freshSnapshot(),
      systems: [{ sourceSystemId: 'duplicate-remap-member', eveSystemId: 31_000_001, positionX: 10, positionY: 20 }],
      connections: [],
    };
    expect((await sendTopology(payload)).body.createdSystems).toBe(1);
    await db.query(`INSERT INTO map_systems (id,map_id,eve_system_id,name,system_class)
      VALUES ($1,$2,31000003,'Manual system','C4')`, [crypto.randomUUID(), mapId]);
    const remapped = { ...payload, snapshot: await newerSnapshot(payload.snapshot.fetchedAt),
      systems: [{ ...payload.systems[0], eveSystemId: 31_000_003 }] };

    const result = await sendTopology(remapped);
    expect(result.body).toMatchObject({ updatedSystems: 0, conflicts: [
      { itemId: 'duplicate-remap-member', reason: 'new EVE system identity is already represented by another map system; preserved' },
    ] });
    expect((await db.query('SELECT eve_system_id FROM map_systems WHERE map_id=$1 ORDER BY eve_system_id', [mapId])).rows)
      .toEqual([{ eve_system_id: 31_000_001 }, { eve_system_id: 31_000_003 }]);
    expect((await db.query<{ managed_json: Record<string, unknown> }>(
      `SELECT managed_json FROM wormholesystems_topology_ownership WHERE map_id=$1`, [mapId])).rows[0].managed_json)
      .toMatchObject({ eveSystemId: 31_000_001 });
  });

  it('denies topology reconciliation and key issuance through a view-only share to a topology-capable role', async () => {
    const recipientId = await seedUser({ characterId: 880_000_002, role: 'edit' });
    const recipientOwnerId = (await db.query<{ id: number }>('INSERT INTO owners DEFAULT VALUES RETURNING id')).rows[0].id;
    await db.query('UPDATE users SET owner_id=$1 WHERE id=$2', [recipientOwnerId, recipientId]);
    const recipientCharacterId = (await db.query<{ character_id: number }>('SELECT character_id FROM users WHERE id=$1', [recipientId])).rows[0].character_id;
    await db.query(`INSERT INTO map_shares (map_id,target_character_id,granted_by_user_id,can_write) VALUES ($1,$2,$3,FALSE)`,
      [mapId, recipientCharacterId, userId]);

    const recipientKey = generateApiKey();
    await db.query(`INSERT INTO api_tokens (owner_id,context_user_id,token_hash,token_prefix,name,scope,scope_map_id)
      VALUES ($1,$2,$3,$4,'View-only integration','wormholesystems_sync',$5)`,
    [recipientOwnerId, recipientId, recipientKey.hash, recipientKey.prefix, mapId]);
    const previousKey = rawKey;
    rawKey = recipientKey.raw;
    const payload = { sourceIdentity, snapshot: freshSnapshot(), systems: [], connections: [] };
    const reconcile = await sendTopology(payload);
    expect(reconcile.status).toBe(403);
    expect(reconcile.body.error).toBe('This map was shared with you view-only');
    rawKey = previousKey;

    const issue = await request(keysApp(recipientId, recipientOwnerId)).post('/api/keys').send({
      name: 'View-only integration', contextCharacterId: recipientCharacterId, scope: 'wormholesystems_sync', scopeMapId: mapId,
    });
    expect(issue.status).toBe(403);
    expect(issue.body.error).toBe('This map was shared with you view-only');
  });

  it('preserves an owned system with a manually populated region name when the source removes it', async () => {
    const payload = {
      sourceIdentity, snapshot: freshSnapshot(),
      systems: [{ sourceSystemId: 'region-member', eveSystemId: 31_000_001, positionX: 10, positionY: 20 }],
      connections: [],
    };
    expect((await sendTopology(payload)).body.createdSystems).toBe(1);
    await db.query(`UPDATE map_systems SET region_name='Manual region' WHERE map_id=$1`, [mapId]);

    const removed = await sendTopology({ ...payload, snapshot: freshSnapshot(), systems: [] });
    expect(removed.body.deletedSystems).toBe(0);
    expect(removed.body.conflicts).toContainEqual({
      itemId: 'region-member', reason: 'removed source system has manual changes or related map data; preserved',
    });
    expect((await db.query('SELECT region_name FROM map_systems WHERE map_id=$1', [mapId])).rows)
      .toEqual([{ region_name: 'Manual region' }]);
  });

  it('creates source-owned systems with SDE effect and statics', async () => {
    await db.query(`UPDATE solar_systems SET effect='magnetar', statics=ARRAY['C247','X877'] WHERE id=31000001`);
    const result = await sendTopology({
      sourceIdentity, snapshot: freshSnapshot(),
      systems: [{ sourceSystemId: 'sde-facts-member', eveSystemId: 31_000_001, positionX: 10, positionY: 20 }],
      connections: [],
    });
    expect(result.body.createdSystems).toBe(1);
    const saved = await db.query<{ effect: string; statics: string[] }>(
      'SELECT effect,statics FROM map_systems WHERE map_id=$1', [mapId]);
    expect(saved.rows).toEqual([{ effect: 'magnetar', statics: ['C247', 'X877'] }]);
  });

  it('preserves manual connection data when source topology changes its endpoints', async () => {
    await db.query(`INSERT INTO solar_systems (id,name,class) VALUES (31000003,'J100003','C4')`);
    const payload = {
      sourceIdentity,
      snapshot: freshSnapshot(),
      systems: [
        { sourceSystemId: 'endpoint-1', eveSystemId: 31_000_001, positionX: 10, positionY: 20 },
        { sourceSystemId: 'endpoint-2', eveSystemId: 31_000_002, positionX: 30, positionY: 40 },
        { sourceSystemId: 'endpoint-3', eveSystemId: 31_000_003, positionX: 50, positionY: 60 },
      ],
      connections: [{ sourceConnectionId: 'endpoint-edge', fromSourceSystemId: 'endpoint-1', toSourceSystemId: 'endpoint-2',
        connection_type: 'standard', ship_size: 'large' }],
    };
    expect((await sendTopology(payload)).body.createdConnections).toBe(1);
    await db.query(`UPDATE map_connections SET mass_status='critical',time_status='fresh',wh_type='C247',flag_icon='WarningIcon',
      flag_note='manual intel',flag_blink=TRUE,flag_color='#ff0000',mass_used=123,eol_at=NOW(),
      lifetime_expires_at=NOW()+INTERVAL '1 day',broken=TRUE WHERE map_id=$1`, [mapId]);

    const retargeted = structuredClone(payload);
    retargeted.connections[0].toSourceSystemId = 'endpoint-3';
    const result = await sendTopology({ ...retargeted, snapshot: freshSnapshot() });
    expect(result.body.updatedConnections).toBe(0);
    expect(result.body.conflicts).toContainEqual({ itemId: 'endpoint-edge', reason: 'connection endpoints have manual references; preserved' });

    const systems = await db.query<{ id: string; eve_system_id: number }>(`SELECT id,eve_system_id FROM map_systems WHERE map_id=$1`, [mapId]);
    const originalSource = systems.rows.find(system => Number(system.eve_system_id) === 31_000_001)!.id;
    const originalTarget = systems.rows.find(system => Number(system.eve_system_id) === 31_000_002)!.id;
    const saved = await db.query<Record<string, unknown>>(`SELECT source_id,target_id,mass_status,time_status,wh_type,flag_note,flag_blink,
      flag_color,mass_used,eol_at,lifetime_expires_at,broken FROM map_connections WHERE map_id=$1`, [mapId]);
    expect(saved.rows[0]).toMatchObject({ source_id: originalSource, target_id: originalTarget, mass_status: 'critical', time_status: 'fresh',
      wh_type: 'C247', flag_note: 'manual intel', flag_blink: true, flag_color: '#ff0000', mass_used: '123', broken: true });
    expect(saved.rows[0].eol_at).toBeTruthy();
    expect(saved.rows[0].lifetime_expires_at).toBeTruthy();
  });

  it('rechecks the current map lock inside the topology transaction', async () => {
    await db.query('UPDATE users SET role=\'edit\' WHERE id=$1', [userId]);
    const emptyTopology = { sourceIdentity, snapshot: freshSnapshot(), systems: [], connections: [] };
    const blocker = await db.connect();
    await blocker.query('BEGIN');
    try {
      await blocker.query('SELECT id FROM maps WHERE id=$1 FOR UPDATE', [mapId]);
      const pendingRequest = sendTopology(emptyTopology);
      let serviceIsWaitingForMapLock = false;
      for (let attempt = 0; attempt < 100 && !serviceIsWaitingForMapLock; attempt++) {
        const waiting = await db.query<{ waiting: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
            AND query LIKE '%SELECT locked, alliance_id AS "allianceId" FROM maps WHERE id=$1 FOR UPDATE%'
        ) AS waiting`);
        serviceIsWaitingForMapLock = waiting.rows[0].waiting;
        if (!serviceIsWaitingForMapLock) await new Promise(resolve => setTimeout(resolve, 20));
      }
      await blocker.query('UPDATE maps SET locked=TRUE WHERE id=$1', [mapId]);
      await blocker.query('COMMIT');
      const response = await pendingRequest;
      expect(serviceIsWaitingForMapLock).toBe(true);
      expect(response.status).toBe(403);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect((await db.query('SELECT 1 FROM map_systems WHERE map_id=$1', [mapId])).rows).toHaveLength(0);
  });

  it('serializes saved-route references against topology deletion in either lock order', async () => {
    const topology = {
      sourceIdentity, snapshot: freshSnapshot(),
      systems: [
        { sourceSystemId: 'route-member-1', eveSystemId: 31_000_001, positionX: 10, positionY: 20 },
        { sourceSystemId: 'route-member-2', eveSystemId: 31_000_002, positionX: 30, positionY: 40 },
      ],
      connections: [{ sourceConnectionId: 'route-edge', fromSourceSystemId: 'route-member-1', toSourceSystemId: 'route-member-2',
        connection_type: 'standard', ship_size: 'large' }],
    };
    expect((await sendTopology(topology)).body).toMatchObject({ createdSystems: 2, createdConnections: 1 });
    let ids = await db.query<{ id: string }>('SELECT id FROM map_systems WHERE map_id=$1 ORDER BY eve_system_id', [mapId]);
    let connectionId = (await db.query<{ id: string }>('SELECT id FROM map_connections WHERE map_id=$1', [mapId])).rows[0].id;
    const routeId = crypto.randomUUID();
    const createdRoute = await request(mapsApp()).post(`/api/maps/${mapId}/routes`).send({
      id: routeId, name: 'Reference lifecycle', systemIds: ids.rows.map(row => row.id), connectionIds: [connectionId],
    });
    expect(createdRoute.status).toBe(201);
    const clearRouteRefs = await request(mapsApp()).patch(`/api/maps/${mapId}/routes/${routeId}`).send({ systemIds: [], connectionIds: [] });
    expect(clearRouteRefs.status).toBe(200);

    // If reconciliation owns the map lock first, a later route write must see
    // that its endpoints have gone and refuse to persist stale array references.
    const blocker = await db.connect();
    let removalSnapshot: ReturnType<typeof freshSnapshot>;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM maps WHERE id=$1 FOR UPDATE', [mapId]);
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      removalSnapshot = await newerSnapshot(topology.snapshot.fetchedAt);
      const pendingRemoval = sendTopology({ ...topology, snapshot: removalSnapshot, systems: [], connections: [] });
      expect(await waitForLockWait('SELECT locked, alliance_id AS "allianceId" FROM maps WHERE id=$1 FOR UPDATE', blockerPid)).toBe(true);
      await blocker.query('COMMIT');
      const removed = await pendingRemoval;
      expect(removed.body).toMatchObject({ deletedSystems: 2, deletedConnections: 1 });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const staleRoute = await request(mapsApp()).post(`/api/maps/${mapId}/routes`).send({
      id: crypto.randomUUID(), name: 'Stale after apply', systemIds: ids.rows.map(row => row.id), connectionIds: [connectionId],
    });
    expect(staleRoute.status).toBe(400);
    const staleUpdate = await request(mapsApp()).patch(`/api/maps/${mapId}/routes/${routeId}`).send({
      systemIds: ids.rows.map(row => row.id), connectionIds: [connectionId],
    });
    expect(staleUpdate.status).toBe(400);
    expect((await db.query<{ system_ids: string[]; connection_ids: string[] }>(
      'SELECT system_ids,connection_ids FROM map_routes WHERE id=$1', [routeId])).rows[0])
      .toEqual({ system_ids: [], connection_ids: [] });

    // If a route update queues first, it commits under the same map lock and
    // reconciliation observes the saved dependency instead of deleting it.
    const restoredSnapshot = await newerSnapshot(removalSnapshot!.fetchedAt);
    expect((await sendTopology({ ...topology, snapshot: restoredSnapshot })).body).toMatchObject({ createdSystems: 2, createdConnections: 1 });
    ids = await db.query<{ id: string }>('SELECT id FROM map_systems WHERE map_id=$1 ORDER BY eve_system_id', [mapId]);
    connectionId = (await db.query<{ id: string }>('SELECT id FROM map_connections WHERE map_id=$1', [mapId])).rows[0].id;
    const lockBlocker = await db.connect();
    try {
      await lockBlocker.query('BEGIN');
      await lockBlocker.query('SELECT id FROM maps WHERE id=$1 FOR UPDATE', [mapId]);
      const blockerPid = (await lockBlocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      // Supertest's Test is lazy; attach a handler now so the route query starts before probing pg_stat_activity.
      const pendingRoute = request(mapsApp()).patch(`/api/maps/${mapId}/routes/${routeId}`).send({
        systemIds: ids.rows.map(row => row.id), connectionIds: [connectionId],
      }).then(response => response);
      expect(await waitForLockWait('SELECT id FROM maps WHERE id=$1 FOR UPDATE', blockerPid)).toBe(true);
      const nextRemovalSnapshot = await newerSnapshot(restoredSnapshot.fetchedAt);
      const pendingRemoval = sendTopology({ ...topology, snapshot: nextRemovalSnapshot, systems: [], connections: [] });
      expect(await waitForLockWait('SELECT locked, alliance_id AS "allianceId" FROM maps WHERE id=$1 FOR UPDATE', blockerPid)).toBe(true);
      await lockBlocker.query('COMMIT');
      const [routeResponse, removalResponse] = await Promise.all([pendingRoute, pendingRemoval]);
      expect(routeResponse.status).toBe(200);
      expect(removalResponse.body).toMatchObject({ deletedSystems: 0, deletedConnections: 0 });
      expect(removalResponse.body.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ itemId: 'route-edge' }),
        expect.objectContaining({ itemId: 'route-member-1' }),
        expect.objectContaining({ itemId: 'route-member-2' }),
      ]));
    } finally {
      await lockBlocker.query('ROLLBACK');
      lockBlocker.release();
    }
    expect((await db.query<{ system_ids: string[]; connection_ids: string[] }>(
      'SELECT system_ids,connection_ids FROM map_routes WHERE id=$1', [routeId])).rows[0])
      .toEqual({ system_ids: ids.rows.map(row => row.id), connection_ids: [connectionId] });
    expect((await db.query('SELECT 1 FROM map_systems WHERE id=ANY($1::uuid[])', [ids.rows.map(row => row.id)])).rows)
      .toHaveLength(2);
    expect((await db.query('SELECT 1 FROM map_connections WHERE id=$1', [connectionId])).rows).toHaveLength(1);
  }, 15_000);

  it('rejects unknown or stale evidence before mutating topology', async () => {
    const invalid = { sourceIdentity, snapshot: freshSnapshot(false), systems: [], connections: [] };
    expect((await sendTopology(invalid)).status).toBe(400);
    expect((await db.query('SELECT 1 FROM map_systems WHERE map_id=$1', [mapId])).rows).toHaveLength(0);
  });
});
