import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db.js';
import { generateApiKey } from '../utils/apiKeys.js';
import { ensureIntegrationDb, seedUser, truncateAll } from '../test/integrationDb.js';
import { sweepConnLifetimes } from '../services/connLifetimeSweep.js';
import { sweepAll } from '../services/whSweep.js';
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

  async function waitForLockWait(queryFragment: string, blockingPid: number): Promise<number | null> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const waiting = await db.query<{ pid: number }>(`SELECT activity.pid
        FROM pg_stat_activity AS activity
       WHERE activity.wait_event_type='Lock' AND activity.query LIKE $1
         AND $2::integer = ANY(pg_blocking_pids(activity.pid))
       ORDER BY activity.query_start DESC LIMIT 1`, [`%${queryFragment}%`, blockingPid]);
      if (waiting.rows.length) return waiting.rows[0].pid;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return null;
  }

  async function waitForLockWaitCount(queryFragment: string, minimum: number): Promise<boolean> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const waiting = await db.query<{ count: number }>(`SELECT count(*)::int AS count
        FROM pg_stat_activity AS activity
        WHERE activity.wait_event_type='Lock' AND activity.query LIKE $1`, [`%${queryFragment}%`]);
      if (waiting.rows[0].count >= minimum) return true;
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

  // V2 integration records below are synthetic API values, not upstream source
  // evidence or type-ID/wormhole-code mapping assertions.
  function v2Topology(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 2,
      sourceIdentity,
      snapshot: freshSnapshot(),
      systems: [
        { sourceSystemId: 'member-1', eveSystemId: 31_000_001, positionX: 10, positionY: 20 },
        { sourceSystemId: 'member-2', eveSystemId: 31_000_002, positionX: 30, positionY: 40 },
      ],
      signatures: [],
      connections: [],
      ...overrides,
    };
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
    const beforeReplay = await db.query(`SELECT id,created_at FROM map_systems WHERE map_id=$1 ORDER BY id`, [mapId]);
    const beforeReplayConnections = await db.query(`SELECT id,created_at FROM map_connections WHERE map_id=$1 ORDER BY id`, [mapId]);
    const beforeReplayOwnership = await db.query(`SELECT item_kind,source_item_id,row_id,managed_json
      FROM wormholesystems_topology_ownership WHERE map_id=$1 ORDER BY item_kind,source_item_id`, [mapId]);
    const replay = await sendTopology(payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ createdSystems: 2, createdConnections: 1, updatedSystems: 0, updatedConnections: 0,
      checkpoint: { accepted: true, replayed: true, partial: false } });
    expect((await db.query(`SELECT id,created_at FROM map_systems WHERE map_id=$1 ORDER BY id`, [mapId])).rows)
      .toEqual(beforeReplay.rows);
    expect((await db.query(`SELECT id,created_at FROM map_connections WHERE map_id=$1 ORDER BY id`, [mapId])).rows)
      .toEqual(beforeReplayConnections.rows);
    expect((await db.query(`SELECT item_kind,source_item_id,row_id,managed_json
      FROM wormholesystems_topology_ownership WHERE map_id=$1 ORDER BY item_kind,source_item_id`, [mapId])).rows)
      .toEqual(beforeReplayOwnership.rows);

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

  it('does not fabricate zero counters when an exact legacy checkpoint has no saved outcome', async () => {
    const payload = {
      sourceIdentity, snapshot: freshSnapshot(),
      systems: [{ sourceSystemId: 'legacy-member', eveSystemId: 31_000_001, positionX: 10, positionY: 20 }],
      connections: [],
    };
    const created = await sendTopology(payload);
    expect(created.body.createdSystems).toBe(1);
    await db.query(`UPDATE wormholesystems_topology_checkpoints SET result_json=NULL WHERE map_id=$1 AND source_identity=$2`, [mapId, sourceIdentity]);

    const replay = await sendTopology(payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ snapshotFetchedAt: payload.snapshot.fetchedAt,
      checkpoint: { accepted: true, replayed: true, partial: null }, replayedFromLegacyCheckpoint: true });
    expect(replay.body).not.toHaveProperty('createdSystems');
    await db.query(`UPDATE wormholesystems_topology_checkpoints SET result_json='{}'::jsonb WHERE map_id=$1 AND source_identity=$2`, [mapId, sourceIdentity]);
    const emptyOutcomeReplay = await sendTopology(payload);
    expect(emptyOutcomeReplay.body).toMatchObject({ checkpoint: { accepted: true, replayed: true, partial: null },
      replayedFromLegacyCheckpoint: true });
    expect(emptyOutcomeReplay.body).not.toHaveProperty('createdSystems');
    expect((await db.query('SELECT 1 FROM map_systems WHERE map_id=$1', [mapId])).rows).toHaveLength(1);
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

  it('creates an owned edge rather than treating a mismatched manual classification as a match', async () => {
    const base = v2Topology();
    expect((await sendTopology(base)).body.createdSystems).toBe(2);
    const systems = await db.query<{ id: string }>('SELECT id FROM map_systems WHERE map_id=$1 ORDER BY eve_system_id', [mapId]);
    const manualId = crypto.randomUUID();
    await db.query(`INSERT INTO map_connections (id,map_id,source_id,target_id,connection_type,size)
      VALUES ($1,$2,$3,$4,'gate','small')`, [manualId, mapId, systems.rows[0].id, systems.rows[1].id]);

    const desired = { ...base, snapshot: await newerSnapshot(base.snapshot.fetchedAt), connections: [
      { sourceConnectionId: 'desired-standard-edge', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: 'large' },
    ] };
    const result = await sendTopology(desired);
    expect(result.body).toMatchObject({ createdConnections: 1, preservedConnections: 0, mappings: { connections: [
      { sourceId: 'desired-standard-edge', ownership: 'owned' },
    ] } });
    const rows = await db.query<{ id: string; connection_type: string; size: string; source_item_id: string | null }>(
      `SELECT c.id,c.connection_type,c.size,o.source_item_id FROM map_connections c
        LEFT JOIN wormholesystems_topology_ownership o ON o.map_id=c.map_id AND o.item_kind='connection' AND o.row_id=c.id
       WHERE c.map_id=$1 ORDER BY c.id`, [mapId]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find(row => row.id === manualId)).toMatchObject({ connection_type: 'gate', size: 'small', source_item_id: null });
    expect(rows.rows.find(row => row.source_item_id === 'desired-standard-edge')).toMatchObject({ connection_type: 'standard', size: 'large' });
  });

  it('creates distinct owned edges when parallel source links make a manual match ambiguous', async () => {
    const base = v2Topology();
    expect((await sendTopology(base)).body.createdSystems).toBe(2);
    const systems = await db.query<{ id: string }>('SELECT id FROM map_systems WHERE map_id=$1 ORDER BY eve_system_id', [mapId]);
    const manualId = crypto.randomUUID();
    await db.query(`INSERT INTO map_connections (id,map_id,source_id,target_id,connection_type,size)
      VALUES ($1,$2,$3,$4,'standard','large')`, [manualId, mapId, systems.rows[0].id, systems.rows[1].id]);
    const desired = { ...base, snapshot: await newerSnapshot(base.snapshot.fetchedAt), connections: [
      { sourceConnectionId: 'parallel-source-a', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: 'large' },
      { sourceConnectionId: 'parallel-source-b', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: 'large' },
    ] };
    const result = await sendTopology(desired);
    expect(result.body).toMatchObject({ createdConnections: 2, preservedConnections: 0, mappings: { connections: [
      { sourceId: 'parallel-source-a', ownership: 'owned' }, { sourceId: 'parallel-source-b', ownership: 'owned' },
    ] } });
    expect((await db.query('SELECT 1 FROM map_connections WHERE map_id=$1', [mapId])).rows).toHaveLength(3);
    expect((await db.query(`SELECT 1 FROM wormholesystems_topology_ownership WHERE map_id=$1 AND item_kind='connection'`, [mapId])).rows)
      .toHaveLength(2);
    expect((await db.query(`SELECT 1 FROM wormholesystems_topology_ownership WHERE map_id=$1 AND item_kind='connection' AND row_id=$2`,
      [mapId, manualId])).rows).toHaveLength(0);
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
    expect(result.body.conflicts).toContainEqual({ itemId: 'endpoint-edge', reason: 'connection has manual data or references; preserved' });

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

  it('serializes manual signature and connection creates with a waiting reconciliation', async () => {
    const initial = v2Topology({
      signatures: [{ sourceSignatureId: 'owned-side', sourceSystemId: 'member-1', sourceConnectionId: 'owned-edge',
        sigId: 'OWN-001', sigType: 'wormhole', whType: 'WH-SYNTH-9' }],
      connections: [{ sourceConnectionId: 'owned-edge', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: 'large', sourceSignatureId: 'owned-side' }],
    });
    expect((await sendTopology(initial)).body).toMatchObject({ createdSignatures: 1, createdConnections: 1 });
    const systems = await db.query<{ eve_system_id: number; id: string }>(
      'SELECT eve_system_id,id FROM map_systems WHERE map_id=$1 ORDER BY eve_system_id', [mapId]);
    const sourceSystemId = systems.rows[0].id, targetSystemId = systems.rows[1].id;
    const blocker = await db.connect();
    let removedRequest: Promise<request.Response> | undefined;
    let signatureRequest: Promise<request.Response> | undefined;
    let connectionRequest: Promise<request.Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM maps WHERE id=$1 FOR UPDATE', [mapId]);
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const removal = { ...initial, snapshot: await newerSnapshot(initial.snapshot.fetchedAt), signatures: [], connections: [] };
      removedRequest = sendTopology(removal);
      expect(await waitForLockWait('FROM maps WHERE id=$1 FOR UPDATE', blockerPid)).not.toBeNull();
      signatureRequest = request(mapsApp()).post(`/api/maps/${mapId}/systems/${sourceSystemId}/signatures`)
        .send({ sigId: 'MAN-001', sigType: 'data' }).then(response => response);
      connectionRequest = request(mapsApp()).post(`/api/maps/${mapId}/connections`).send({ id: crypto.randomUUID(),
        sourceId: sourceSystemId, targetId: targetSystemId, connectionType: 'standard', size: 'large' }).then(response => response);
      expect(await waitForLockWaitCount('SELECT id FROM maps WHERE id=$1 FOR UPDATE', 2)).toBe(true);
      await blocker.query('COMMIT');
      const [removed, manualSignature, manualConnection] = await Promise.all([removedRequest, signatureRequest, connectionRequest]);
      expect(removed.body).toMatchObject({ deletedSignatures: 1, deletedConnections: 1 });
      expect(manualSignature.status).toBe(201);
      expect(manualConnection.status).toBe(201);
    } finally {
      await blocker.query('ROLLBACK');
      await Promise.allSettled([removedRequest, signatureRequest, connectionRequest].filter(Boolean) as Promise<unknown>[]);
      blocker.release();
    }
    expect((await db.query<{ sig_id: string }>(`SELECT s.sig_id FROM map_signatures s JOIN map_systems m ON m.id=s.system_id
      WHERE m.map_id=$1 ORDER BY s.sig_id`, [mapId])).rows).toEqual([{ sig_id: 'MAN-001' }]);
    expect((await db.query('SELECT 1 FROM map_connections WHERE map_id=$1', [mapId])).rows).toHaveLength(1);
  });

  it('serializes manual signature and connection edits after source-owned updates', async () => {
    const initial = v2Topology({
      signatures: [{ sourceSignatureId: 'edit-side', sourceSystemId: 'member-1', sourceConnectionId: 'edit-edge',
        sigId: 'EDIT-001', sigType: 'wormhole', whType: 'WH-SYNTH-10' }],
      connections: [{ sourceConnectionId: 'edit-edge', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: 'large', sourceSignatureId: 'edit-side' }],
    });
    expect((await sendTopology(initial)).body).toMatchObject({ createdSignatures: 1, createdConnections: 1 });
    const rows = await db.query<{ id: string; system_id: string }>(`SELECT s.id,s.system_id FROM map_signatures s
      JOIN map_systems m ON m.id=s.system_id WHERE m.map_id=$1`, [mapId]);
    const connectionId = (await db.query<{ id: string }>('SELECT id FROM map_connections WHERE map_id=$1', [mapId])).rows[0].id;
    const next = structuredClone(initial);
    next.snapshot = await newerSnapshot(initial.snapshot.fetchedAt);
    next.signatures[0].sigType = 'relic';
    next.signatures[0].whType = '';
    next.connections[0].ship_size = 'medium';

    const blocker = await db.connect();
    let reconcileRequest: Promise<request.Response> | undefined;
    let signatureEdit: Promise<request.Response> | undefined;
    let connectionEdit: Promise<request.Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM maps WHERE id=$1 FOR UPDATE', [mapId]);
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      reconcileRequest = sendTopology(next);
      expect(await waitForLockWait('FROM maps WHERE id=$1 FOR UPDATE', blockerPid)).not.toBeNull();
      signatureEdit = request(mapsApp()).patch(`/api/maps/${mapId}/systems/${rows.rows[0].system_id}/signatures/${rows.rows[0].id}`)
        .send({ sigType: 'data' }).then(response => response);
      connectionEdit = request(mapsApp()).patch(`/api/maps/${mapId}/connections/${connectionId}`).send({ size: 'small' })
        .then(response => response);
      expect(await waitForLockWaitCount('SELECT id FROM maps WHERE id=$1 FOR UPDATE', 2)).toBe(true);
      await blocker.query('COMMIT');
      const [reconciled, signatureResponse, connectionResponse] = await Promise.all([reconcileRequest, signatureEdit, connectionEdit]);
      expect(reconciled.status).toBe(200);
      expect(signatureResponse.status).toBe(200);
      expect(connectionResponse.status).toBe(200);
    } finally {
      await blocker.query('ROLLBACK');
      await Promise.allSettled([reconcileRequest, signatureEdit, connectionEdit].filter(Boolean) as Promise<unknown>[]);
      blocker.release();
    }
    expect((await db.query<{ sig_type: string }>('SELECT sig_type FROM map_signatures WHERE id=$1', [rows.rows[0].id])).rows)
      .toEqual([{ sig_type: 'data' }]);
    expect((await db.query<{ size: string }>('SELECT size FROM map_connections WHERE id=$1', [connectionId])).rows)
      .toEqual([{ size: 'small' }]);
  });

  it('revalidates the current integration scope after the request waits for the map lock', async () => {
    const blocker = await db.connect();
    let pendingRequest: Promise<request.Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM maps WHERE id=$1 FOR UPDATE', [mapId]);
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pendingRequest = sendTopology({ sourceIdentity, snapshot: freshSnapshot(), systems: [], connections: [] });
      expect(await waitForLockWait('FROM maps WHERE id=$1 FOR UPDATE', blockerPid)).not.toBeNull();
      await db.query(`UPDATE api_tokens SET scope='read' WHERE context_user_id=$1 AND scope_map_id=$2`, [userId, mapId]);
      await blocker.query('COMMIT');
      const response = await pendingRequest;
      expect(response.status).toBe(403);
      expect(response.body.error).toMatch(/no longer authorized/);
    } finally {
      await blocker.query('ROLLBACK');
      await Promise.allSettled([pendingRequest].filter(Boolean) as Promise<unknown>[]);
      blocker.release();
    }
    expect((await db.query('SELECT 1 FROM wormholesystems_topology_checkpoints WHERE map_id=$1', [mapId])).rows).toHaveLength(0);
  });

  it('revalidates revoked share access and topology role after the request waits', async () => {
    const recipientId = await seedUser({ characterId: 880_000_003, role: 'edit' });
    const recipientOwnerId = (await db.query<{ id: number }>('INSERT INTO owners DEFAULT VALUES RETURNING id')).rows[0].id;
    await db.query('UPDATE users SET owner_id=$1 WHERE id=$2', [recipientOwnerId, recipientId]);
    const recipientCharacterId = (await db.query<{ character_id: number }>('SELECT character_id FROM users WHERE id=$1', [recipientId])).rows[0].character_id;
    await db.query(`INSERT INTO map_shares (map_id,target_character_id,granted_by_user_id,can_write) VALUES ($1,$2,$3,TRUE)`,
      [mapId, recipientCharacterId, userId]);
    const recipientKey = generateApiKey();
    await db.query(`INSERT INTO api_tokens (owner_id,context_user_id,token_hash,token_prefix,name,scope,scope_map_id)
      VALUES ($1,$2,$3,$4,'Shared integration','wormholesystems_sync',$5)`,
    [recipientOwnerId, recipientId, recipientKey.hash, recipientKey.prefix, mapId]);
    const originalKey = rawKey;
    rawKey = recipientKey.raw;

    const waitAndChange = async (change: () => Promise<unknown>, expectedMessage: RegExp) => {
      const blocker = await db.connect();
      let pendingRequest: Promise<request.Response> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM maps WHERE id=$1 FOR UPDATE', [mapId]);
        const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pendingRequest = sendTopology({ sourceIdentity, snapshot: freshSnapshot(), systems: [], connections: [] });
        expect(await waitForLockWait('FROM maps WHERE id=$1 FOR UPDATE', blockerPid)).not.toBeNull();
        await change();
        await blocker.query('COMMIT');
        const response = await pendingRequest;
        expect(response.status).toBe(403);
        expect(response.body.error).toMatch(expectedMessage);
      } finally {
        await blocker.query('ROLLBACK');
        await Promise.allSettled([pendingRequest].filter(Boolean) as Promise<unknown>[]);
        blocker.release();
      }
    };

    try {
      await waitAndChange(() => db.query('UPDATE map_shares SET can_write=FALSE WHERE map_id=$1 AND target_character_id=$2',
        [mapId, recipientCharacterId]), /view-only/);
      await db.query('UPDATE map_shares SET can_write=TRUE WHERE map_id=$1 AND target_character_id=$2', [mapId, recipientCharacterId]);
      await waitAndChange(() => db.query("UPDATE users SET role='contributor' WHERE id=$1", [recipientId]), /Topology-edit permission/);
    } finally {
      rawKey = originalKey;
    }
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
            AND query LIKE '%FROM maps WHERE id=$1 FOR UPDATE%'
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
      expect(await waitForLockWait('FROM maps WHERE id=$1 FOR UPDATE', blockerPid)).not.toBeNull();
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
    const barrierId = crypto.randomUUID().replaceAll('-', '');
    const barrierKey = Number.parseInt(barrierId.slice(0, 13), 16);
    const barrierFunction = `route_write_barrier_${barrierId}`;
    const barrierTrigger = `${barrierFunction}_trigger`;
    let barrierFunctionInstalled = false;
    let barrierTriggerInstalled = false;
    const pendingRequests: Promise<unknown>[] = [];
    try {
      await lockBlocker.query('BEGIN');
      await lockBlocker.query('SELECT pg_advisory_xact_lock($1)', [barrierKey]);
      await db.query(`CREATE FUNCTION ${barrierFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${barrierKey});
          RETURN NEW;
        END
      $$`);
      barrierFunctionInstalled = true;
      await db.query(`CREATE TRIGGER ${barrierTrigger} BEFORE UPDATE ON map_routes
        FOR EACH ROW WHEN (NEW.map_id = '${mapId}'::uuid)
        EXECUTE FUNCTION ${barrierFunction}()`);
      barrierTriggerInstalled = true;

      const barrierPid = (await lockBlocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      // The trigger pauses the endpoint after withMapRowLock has acquired the map row lock.
      const pendingRoute = request(mapsApp()).patch(`/api/maps/${mapId}/routes/${routeId}`).send({
        systemIds: ids.rows.map(row => row.id), connectionIds: [connectionId],
      }).then(response => response);
      pendingRequests.push(pendingRoute);
      const routeBackendPid = await waitForLockWait('UPDATE map_routes SET', barrierPid);
      expect(routeBackendPid).not.toBeNull();

      const nextRemovalSnapshot = await newerSnapshot(restoredSnapshot.fetchedAt);
      const pendingRemoval = sendTopology({ ...topology, snapshot: nextRemovalSnapshot, systems: [], connections: [] });
      pendingRequests.push(pendingRemoval);
      // Identify the route handler's backend as the blocker: this proves it really
      // owns the map row lock before reconciliation queues behind it.
      expect(await waitForLockWait('FROM maps WHERE id=$1 FOR UPDATE', routeBackendPid!)).not.toBeNull();
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
      await Promise.allSettled(pendingRequests);
      if (barrierTriggerInstalled) {
        await db.query(`DROP TRIGGER IF EXISTS ${barrierTrigger} ON map_routes`);
      }
      if (barrierFunctionInstalled) {
        await db.query(`DROP FUNCTION IF EXISTS ${barrierFunction}()`);
      }
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

  // Synthetic API enum/data values only; these assertions are not evidence for
  // any upstream WormholeSystems type-ID or wormhole-code mapping.
  it('accepts standalone synthetic v2 signatures, replays their full result, and prevents version regression', async () => {
    const payload = v2Topology({ signatures: [
      { sourceSignatureId: 'sig-resource-1', sourceSystemId: 'member-1', sourceConnectionId: null, sigId: 'SYN-001', sigType: 'wormhole', whType: 'WH-SYNTH-1' },
      { sourceSignatureId: 'sig-resource-2', sourceSystemId: 'member-2', sourceConnectionId: null, sigId: 'SYN-002', sigType: 'relic', whType: '' },
    ] });
    const created = await sendTopology(payload);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ createdSystems: 2, createdSignatures: 2, createdConnections: 0,
      checkpoint: { accepted: true, replayed: false, partial: false }, mappings: { signatures: [
        { sourceId: 'sig-resource-1', ownership: 'owned' }, { sourceId: 'sig-resource-2', ownership: 'owned' },
      ] } });
    expect((await db.query<{ sig_id: string; sig_type: string; wh_type: string }>(`SELECT s.sig_id,s.sig_type,s.wh_type
      FROM map_signatures s JOIN map_systems m ON m.id=s.system_id WHERE m.map_id=$1 ORDER BY s.sig_id`, [mapId])).rows)
      .toEqual([{ sig_id: 'SYN-001', sig_type: 'wormhole', wh_type: 'WH-SYNTH-1' }, { sig_id: 'SYN-002', sig_type: 'relic', wh_type: '' }]);

    const replay = await sendTopology(payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ createdSignatures: 2, mappings: { signatures: expect.arrayContaining([
      expect.objectContaining({ sourceId: 'sig-resource-1' }), expect.objectContaining({ sourceId: 'sig-resource-2' }),
    ]) }, checkpoint: { accepted: true, replayed: true, partial: false } });

    const changedDigest = structuredClone(payload);
    (changedDigest.signatures[0] as any).whType = 'WH-SYNTH-4';
    expect((await sendTopology(changedDigest)).status).toBe(409);
    const regressed = { sourceIdentity, snapshot: await newerSnapshot(payload.snapshot.fetchedAt), systems: payload.systems, connections: [] };
    expect((await sendTopology(regressed)).status).toBe(409);
    expect((await db.query('SELECT 1 FROM wormholesystems_topology_ownership WHERE map_id=$1 AND item_kind=\'signature\'', [mapId])).rows)
      .toHaveLength(2);
  });

  it('creates directional connection signature refs only for exact validated edge/scanner relations', async () => {
    const payload = v2Topology({
      signatures: [
        { sourceSignatureId: 'source-side', sourceSystemId: 'member-1', sourceConnectionId: 'edge-1', sigId: 'SYN-003', sigType: 'wormhole', whType: 'WH-SYNTH-2' },
        { sourceSignatureId: 'target-side', sourceSystemId: 'member-2', sourceConnectionId: 'edge-1', sigId: 'SYN-004', sigType: 'wormhole', whType: 'WH-SYNTH-3' },
      ],
      connections: [{ sourceConnectionId: 'edge-1', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: 'large', sourceSignatureId: 'source-side', targetSignatureId: 'target-side' }],
    });
    const result = await sendTopology(payload);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ createdSignatures: 2, createdConnections: 1, conflicts: [] });
    const refs = await db.query<{ source_signature_id: string; target_signature_id: string; source_id: string; target_id: string }>(
      `SELECT c.source_signature_id,c.target_signature_id,c.source_id,c.target_id FROM map_connections c WHERE c.map_id=$1`, [mapId]);
    expect(refs.rows).toHaveLength(1);
    const signatures = await db.query<{ id: string; system_id: string; sig_id: string }>(
      'SELECT id,system_id,sig_id FROM map_signatures ORDER BY sig_id');
    const sourceSig = signatures.rows.find(row => row.sig_id === 'SYN-003')!;
    const targetSig = signatures.rows.find(row => row.sig_id === 'SYN-004')!;
    expect(refs.rows[0]).toMatchObject({ source_signature_id: sourceSig.id, target_signature_id: targetSig.id,
      source_id: sourceSig.system_id, target_id: targetSig.system_id });
  });

  it('preserves source edges with null refs when a signature row is unresolved or incompatible', async () => {
    const initial = v2Topology({
      signatures: [{ sourceSignatureId: 'owned-edge-sig', sourceSystemId: 'member-1', sourceConnectionId: 'edge-one',
        sigId: 'OWN-201', sigType: 'wormhole', whType: 'WH-SYNTH-10' }],
      connections: [{ sourceConnectionId: 'edge-one', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: 'large', sourceSignatureId: 'owned-edge-sig' }],
    });
    expect((await sendTopology(initial)).body.createdConnections).toBe(1);
    const systems = await db.query<{ id: string; eve_system_id: number }>(
      'SELECT id,eve_system_id FROM map_systems WHERE map_id=$1 ORDER BY eve_system_id', [mapId]);
    await db.query(`UPDATE map_signatures SET sig_type='relic' WHERE sig_id='OWN-201'`);
    await db.query(`INSERT INTO map_signatures (id,system_id,sig_id,sig_type,wh_type) VALUES ($1,$2,'MAN-201','relic','')`,
      [crypto.randomUUID(), systems.rows[0].id]);

    const next = structuredClone(initial) as any;
    next.snapshot = await newerSnapshot(initial.snapshot.fetchedAt);
    next.signatures.push({ sourceSignatureId: 'manual-edge-sig', sourceSystemId: 'member-1', sourceConnectionId: 'edge-two',
      sigId: 'MAN-201', sigType: 'data', whType: '' });
    next.connections.push({ sourceConnectionId: 'edge-two', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
      connection_type: 'standard', ship_size: 'large', sourceSignatureId: 'manual-edge-sig' });

    const result = await sendTopology(next);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ updatedConnections: 1, createdConnections: 1, checkpoint: { partial: true },
      mappings: { connections: expect.arrayContaining([
        { sourceId: 'edge-one', ownership: 'owned' }, { sourceId: 'edge-two', ownership: 'owned' },
      ]) } });
    expect(result.body.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'edge-one', reason: expect.stringContaining('signature is unresolved') }),
      expect.objectContaining({ itemId: 'edge-two', reason: expect.stringContaining('signature is unresolved') }),
    ]));
    expect((await db.query<{ source_item_id: string; source_signature_id: string | null; target_signature_id: string | null }>(
      `SELECT o.source_item_id,c.source_signature_id,c.target_signature_id FROM map_connections c
        JOIN wormholesystems_topology_ownership o ON o.map_id=c.map_id AND o.item_kind='connection' AND o.row_id=c.id
       WHERE c.map_id=$1 ORDER BY o.source_item_id`, [mapId])).rows)
      .toEqual([{ source_item_id: 'edge-one', source_signature_id: null, target_signature_id: null },
        { source_item_id: 'edge-two', source_signature_id: null, target_signature_id: null }]);
  });

  it('uses database defaults only for absent positions and sizes, preserving existing values', async () => {
    const payload = v2Topology({
      systems: [
        { sourceSystemId: 'member-1', eveSystemId: 31_000_001 },
        { sourceSystemId: 'member-2', eveSystemId: 31_000_002, positionX: null, positionY: null },
      ],
      connections: [{ sourceConnectionId: 'default-size-edge', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: null }],
    });
    const created = await sendTopology(payload);
    expect(created.status).toBe(200);
    expect(created.body.diagnostics).toEqual(expect.arrayContaining([
      { itemId: 'member-1', reason: 'position_unavailable' }, { itemId: 'member-2', reason: 'position_unavailable' },
      { itemId: 'default-size-edge', reason: 'defaulted' },
    ]));
    expect((await db.query<{ eve_system_id: number; position_x: number; position_y: number }>(
      'SELECT eve_system_id,position_x,position_y FROM map_systems WHERE map_id=$1 ORDER BY eve_system_id', [mapId])).rows)
      .toEqual([{ eve_system_id: 31_000_001, position_x: 0, position_y: 0 },
        { eve_system_id: 31_000_002, position_x: 0, position_y: 0 }]);
    expect((await db.query<{ size: string }>('SELECT size FROM map_connections WHERE map_id=$1', [mapId])).rows)
      .toEqual([{ size: 'large' }]);

    await db.query(`UPDATE map_systems SET position_x=77 WHERE map_id=$1 AND eve_system_id=31000001`, [mapId]);
    await db.query(`UPDATE map_connections SET size='small' WHERE map_id=$1`, [mapId]);
    const replay = await sendTopology({ ...payload, snapshot: await newerSnapshot(payload.snapshot.fetchedAt) });
    expect(replay.body).toMatchObject({ updatedSystems: 0, updatedConnections: 0, checkpoint: { partial: true },
      conflicts: expect.arrayContaining([expect.objectContaining({ itemId: 'default-size-edge', reason: 'managed connection was manually changed; preserved' })]) });
    expect((await db.query<{ position_x: number }>(
      'SELECT position_x FROM map_systems WHERE map_id=$1 AND eve_system_id=31000001', [mapId])).rows[0].position_x).toBe(77);
    expect((await db.query<{ size: string }>('SELECT size FROM map_connections WHERE map_id=$1', [mapId])).rows[0].size).toBe('small');
  });

  it('locks maps before sweep item writes and preserves source-owned records from autonomous expiry', async () => {
    await db.query(`UPDATE maps SET lazy_remove_wormholes=TRUE,collapse_grace_hours=0 WHERE id=$1`, [mapId]);
    const topology = v2Topology({
      signatures: [{ sourceSignatureId: 'sweep-owned-signature', sourceSystemId: 'member-1', sourceConnectionId: 'sweep-owned-edge',
        sigId: 'SWP-201', sigType: 'wormhole', whType: 'C247' }],
      connections: [{ sourceConnectionId: 'sweep-owned-edge', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
        connection_type: 'standard', ship_size: 'large', sourceSignatureId: 'sweep-owned-signature' }],
    });
    expect((await sendTopology(topology)).body.createdConnections).toBe(1);
    const systemId = (await db.query<{ id: string }>(`SELECT id FROM map_systems WHERE map_id=$1 AND eve_system_id=31000002`, [mapId])).rows[0].id;
    const manualSignatureId = crypto.randomUUID();
    await db.query(`INSERT INTO map_signatures (id,system_id,sig_id,sig_type,wh_type,created_at)
      VALUES ($1,$2,'SWP-202','wormhole','C247',NOW()-INTERVAL '3 days')`, [manualSignatureId, systemId]);
    await db.query(`UPDATE map_signatures SET created_at=NOW()-INTERVAL '3 days' WHERE sig_id='SWP-201'`);
    await db.query(`UPDATE map_connections SET lifetime_expires_at=NOW()-INTERVAL '1 day' WHERE map_id=$1`, [mapId]);

    await sweepConnLifetimes();
    expect((await db.query<{ broken: boolean }>(`SELECT broken FROM map_connections WHERE map_id=$1`, [mapId])).rows)
      .toEqual([{ broken: false }]);

    const blocker = await db.connect();
    let held = false;
    let pendingSweep: Promise<void> | undefined;
    try {
      await blocker.query('BEGIN');
      held = true;
      await blocker.query('SELECT id FROM maps WHERE id=$1 FOR UPDATE', [mapId]);
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pendingSweep = sweepAll();
      expect(await waitForLockWait('SELECT id FROM maps WHERE id=$1 FOR UPDATE', blockerPid)).not.toBeNull();
      expect((await db.query('SELECT 1 FROM map_signatures WHERE id=ANY($1::uuid[])',
        [[manualSignatureId, (await db.query<{ id: string }>(`SELECT id FROM map_signatures WHERE sig_id='SWP-201'`)).rows[0].id]])).rows)
        .toHaveLength(2);
      await blocker.query('COMMIT');
      held = false;
      await pendingSweep;
    } finally {
      if (held) await blocker.query('ROLLBACK');
      if (pendingSweep) await Promise.allSettled([pendingSweep]);
      blocker.release();
    }
    expect((await db.query('SELECT 1 FROM map_signatures WHERE id=$1', [manualSignatureId])).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM map_signatures s JOIN wormholesystems_topology_ownership o
      ON o.map_id=$1 AND o.item_kind='signature' AND o.row_id=s.id WHERE s.sig_id='SWP-201'`, [mapId])).rows).toHaveLength(1);
    expect((await db.query<{ broken: boolean }>(`SELECT broken FROM map_connections WHERE map_id=$1`, [mapId])).rows)
      .toEqual([{ broken: false }]);
  }, 15_000);

  it('preserves matching manual signatures without ownership and reports managed-field conflicts', async () => {
    const systemId = crypto.randomUUID();
    await db.query(`INSERT INTO map_systems (id,map_id,eve_system_id,name,system_class) VALUES ($1,$2,31000001,'Manual','C2')`, [systemId, mapId]);
    const manualId = crypto.randomUUID();
    await db.query(`INSERT INTO map_signatures (id,system_id,sig_id,sig_type,wh_type,notes) VALUES ($1,$2,'ABC-123','data','', 'keep')`,
      [manualId, systemId]);
    const manualBlankId = crypto.randomUUID();
    await db.query(`INSERT INTO map_signatures (id,system_id,sig_id,sig_type,wh_type) VALUES ($1,$2,'','unknown','')`, [manualBlankId, systemId]);
    const payload = v2Topology({
      systems: [{ sourceSystemId: 'member-1', eveSystemId: 31_000_001, positionX: 1, positionY: 2 }],
      signatures: [
        { sourceSignatureId: 'source-manual-match', sourceSystemId: 'member-1', sourceConnectionId: null,
          sigId: 'ABC-123', sigType: 'wormhole', whType: 'WH-SYNTH-5' },
        { sourceSignatureId: 'source-unassigned', sourceSystemId: 'member-1', sourceConnectionId: null, sigId: '', sigType: 'unknown', whType: '' },
      ],
    });
    const result = await sendTopology(payload);
    expect(result.body).toMatchObject({ preservedSignatures: 1, createdSignatures: 1, checkpoint: { partial: true }, conflicts: [
      { itemId: 'source-manual-match', reason: 'matching manual signature has different managed type fields; preserved' },
    ], mappings: { signatures: expect.arrayContaining([
      { sourceId: 'source-manual-match', rowId: manualId, ownership: 'preserved' },
      expect.objectContaining({ sourceId: 'source-unassigned', ownership: 'owned' }),
    ]) } });
    expect((await db.query<{ sig_type: string; wh_type: string; notes: string }>(
      'SELECT sig_type,wh_type,notes FROM map_signatures WHERE id=$1', [manualId])).rows[0])
      .toEqual({ sig_type: 'data', wh_type: '', notes: 'keep' });
    const blankRows = await db.query<{ id: string; source_item_id: string | null }>(`SELECT s.id,o.source_item_id FROM map_signatures s
      LEFT JOIN wormholesystems_topology_ownership o ON o.map_id=$1 AND o.item_kind='signature' AND o.row_id=s.id
      WHERE s.system_id=$2 AND s.sig_id='' ORDER BY s.id`, [mapId, systemId]);
    expect(blankRows.rows).toHaveLength(2);
    expect(blankRows.rows.find(row => row.id === manualBlankId)?.source_item_id).toBeNull();
    expect(blankRows.rows.find(row => row.id !== manualBlankId)?.source_item_id).toBe('source-unassigned');
  });

  it('deletes only unchanged absent owned signatures and protects manual data or connection references', async () => {
    const payload = v2Topology({ signatures: [
      { sourceSignatureId: 'safe-signature', sourceSystemId: 'member-1', sourceConnectionId: null, sigId: 'ABC-123', sigType: 'data', whType: '' },
      { sourceSignatureId: 'annotated-signature', sourceSystemId: 'member-2', sourceConnectionId: null, sigId: 'DEF-456', sigType: 'wormhole', whType: 'WH-SYNTH-6' },
      { sourceSignatureId: 'referenced-signature', sourceSystemId: 'member-1', sourceConnectionId: null, sigId: 'GHI-789', sigType: 'data', whType: '' },
    ] });
    expect((await sendTopology(payload)).body.createdSignatures).toBe(3);
    await db.query(`UPDATE map_signatures SET notes='manual',name='manual name' WHERE sig_id='DEF-456'`);
    const referencedSignature = (await db.query<{ id: string; system_id: string }>(
      `SELECT id,system_id FROM map_signatures WHERE sig_id='GHI-789'`)).rows[0];
    const otherSystem = (await db.query<{ id: string }>(`SELECT id FROM map_systems WHERE map_id=$1 AND eve_system_id=31000002`, [mapId])).rows[0].id;
    await db.query(`INSERT INTO map_connections (id,map_id,source_id,target_id,connection_type,source_signature_id)
      VALUES ($1,$2,$3,$4,'standard',$5)`,
      [crypto.randomUUID(), mapId, referencedSignature.system_id, otherSystem, referencedSignature.id]);
    const removed = await sendTopology({ ...payload, snapshot: await newerSnapshot(payload.snapshot.fetchedAt), signatures: [] });
    expect(removed.body).toMatchObject({ deletedSignatures: 1, checkpoint: { partial: true }, conflicts: expect.arrayContaining([
      expect.objectContaining({ itemId: 'annotated-signature', reason: 'removed source signature has manual data, changed fields, or connection references; preserved' }),
      expect.objectContaining({ itemId: 'referenced-signature', reason: 'removed source signature has manual data, changed fields, or connection references; preserved' }),
    ]) });
    expect((await db.query<{ sig_id: string; notes: string }>(`SELECT sig_id,notes FROM map_signatures s
      JOIN map_systems m ON m.id=s.system_id WHERE m.map_id=$1 ORDER BY s.sig_id`, [mapId])).rows)
      .toEqual([{ sig_id: 'DEF-456', notes: 'manual' }, { sig_id: 'GHI-789', notes: '' }]);
    expect((await db.query<{ source_signature_id: string }>(`SELECT source_signature_id FROM map_connections WHERE map_id=$1`, [mapId])).rows)
      .toEqual([{ source_signature_id: referencedSignature.id }]);
  });

  it('rejects malformed v2 references and unsupported edges before any deletion or checkpoint advance', async () => {
    const initial = v2Topology({
      signatures: [
        { sourceSignatureId: 'sig-a', sourceSystemId: 'member-1', sourceConnectionId: 'edge-a', sigId: 'ABC-123', sigType: 'wormhole', whType: 'WH-SYNTH-7' },
        { sourceSignatureId: 'sig-b', sourceSystemId: 'member-2', sourceConnectionId: 'edge-a', sigId: 'DEF-456', sigType: 'wormhole', whType: 'WH-SYNTH-8' },
        { sourceSignatureId: 'sig-c', sourceSystemId: 'member-1', sourceConnectionId: 'edge-b', sigId: 'GHI-789', sigType: 'data', whType: '' },
        { sourceSignatureId: 'sig-d', sourceSystemId: 'member-2', sourceConnectionId: 'edge-b', sigId: 'JKL-012', sigType: 'data', whType: '' },
      ],
      connections: [
        { sourceConnectionId: 'edge-a', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2', connection_type: 'standard', ship_size: 'large', sourceSignatureId: 'sig-a', targetSignatureId: 'sig-b' },
        { sourceConnectionId: 'edge-b', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2', connection_type: 'standard', ship_size: 'large', sourceSignatureId: 'sig-c', targetSignatureId: 'sig-d' },
      ],
    });
    expect((await sendTopology(initial)).body.createdConnections).toBe(2);
    const checkpointBefore = await db.query<{ fetched_at: Date; payload_digest: string }>(
      'SELECT fetched_at,payload_digest FROM wormholesystems_topology_checkpoints WHERE map_id=$1 AND source_identity=$2', [mapId, sourceIdentity]);

    const malformed = structuredClone(initial);
    malformed.snapshot = await newerSnapshot(initial.snapshot.fetchedAt);
    (malformed.connections[0] as any).connection_type = 'unsupported';
    malformed.connections = [malformed.connections[0]];
    malformed.signatures = malformed.signatures.slice(0, 2);
    expect((await sendTopology(malformed)).status).toBe(400);
    expect((await db.query('SELECT 1 FROM map_connections WHERE map_id=$1', [mapId])).rows).toHaveLength(2);
    expect((await db.query<{ fetched_at: Date; payload_digest: string }>(
      'SELECT fetched_at,payload_digest FROM wormholesystems_topology_checkpoints WHERE map_id=$1 AND source_identity=$2', [mapId, sourceIdentity])).rows)
      .toEqual(checkpointBefore.rows);

    for (const signatures of [
      [initial.signatures[0], { ...initial.signatures[1], sourceSignatureId: 'sig-a' }],
      [initial.signatures[0], { ...initial.signatures[1], sigId: 'ABC-123' }],
      [{ ...initial.signatures[0], sigType: 'wormhole-class' }],
      [{ ...initial.signatures[0], sourceConnectionId: 'absent-edge' }],
    ]) {
      expect((await sendTopology(v2Topology({ signatures }))).status).toBe(400);
    }
    expect((await db.query('SELECT 1 FROM map_connections WHERE map_id=$1', [mapId])).rows).toHaveLength(2);
  });
});
