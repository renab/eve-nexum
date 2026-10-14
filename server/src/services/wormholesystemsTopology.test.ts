import { describe, expect, it } from 'vitest';
import { validateWormholesystemsTopology } from './wormholesystemsTopology.js';

const valid = () => {
  const fetchedAt = new Date().toISOString();
  return {
  sourceIdentity: 'wormholesystems:["https://source.example","map-1"]',
  snapshot: { complete: true, fetchedAt },
  systems: [
    { sourceSystemId: 'member-1', eveSystemId: 31000001, positionX: 10, positionY: 20 },
    { sourceSystemId: 'member-2', eveSystemId: 31000002, positionX: 30, positionY: 40 },
  ],
  connections: [{ sourceConnectionId: 'edge-1', fromSourceSystemId: 'member-1', toSourceSystemId: 'member-2',
    connection_type: 'standard', ship_size: 'large' }],
  };
};

describe('WormholeSystems topology request validation', () => {
  it('accepts bounded, explicitly identified source topology', () => {
    expect(validateWormholesystemsTopology(valid()).systems).toHaveLength(2);
    expect(validateWormholesystemsTopology(valid()).connections).toHaveLength(1);
  });

  it('canonicalizes coordinates to PostgreSQL REAL precision', () => {
    const input = valid();
    input.systems[0].positionX = 10.1;
    expect(validateWormholesystemsTopology(input).systems[0].positionX).toBe(Math.fround(10.1));
  });

  it('rejects duplicate or malformed source identities and EVE IDs', () => {
    const invalidNamespace = valid() as any;
    invalidNamespace.sourceIdentity = 'wormholesystems:["https://source.example/path","map-1"]';
    expect(() => validateWormholesystemsTopology(invalidNamespace)).toThrow(/canonical source identity/);

    const duplicate = valid();
    duplicate.systems[1].sourceSystemId = duplicate.systems[0].sourceSystemId;
    expect(() => validateWormholesystemsTopology(duplicate)).toThrow(/Duplicate source system/);

    const badEveId = valid();
    (badEveId.systems[0] as any).eveSystemId = '31000001';
    expect(() => validateWormholesystemsTopology(badEveId)).toThrow(/source system identity/);
  });

  it('rejects connections outside the declared source-system scope', () => {
    const invalid = valid();
    invalid.connections[0].toSourceSystemId = 'not-in-snapshot';
    expect(() => validateWormholesystemsTopology(invalid)).toThrow(/source connection identity/);
  });

  it('requires a complete validated snapshot, one server-bounded fetch timestamp, and no client-selected freshness policy', () => {
    const incomplete = valid() as any;
    incomplete.snapshot.complete = false;
    expect(() => validateWormholesystemsTopology(incomplete)).toThrow(/completeness or freshness/);

    const clientLimit = valid() as any;
    clientLimit.snapshot.maxAgeMs = 1_000_000_000;
    expect(() => validateWormholesystemsTopology(clientLimit)).toThrow(/Unrecognized topology field|Invalid source completeness/);

    const stale = valid() as any;
    stale.snapshot.fetchedAt = '2000-01-01T00:00:00Z';
    expect(() => validateWormholesystemsTopology(stale)).toThrow(/stale/);

    const future = valid() as any;
    future.snapshot.fetchedAt = new Date(Date.now() + 60_000).toISOString();
    expect(() => validateWormholesystemsTopology(future)).toThrow(/future-dated or stale/);
  });

  it('rejects impossible ISO calendar dates before freshness validation', () => {
    for (const fetchedAt of ['2024-02-30T12:00:00Z', '2023-02-29T12:00:00Z', '2024-04-31T12:00:00Z']) {
      const input = valid();
      input.snapshot.fetchedAt = fetchedAt;
      expect(() => validateWormholesystemsTopology(input)).toThrow(/completeness or freshness evidence/);
    }
  });

  it('does not accept client fields that could mutate labels or other manual data', () => {
    const invalid = valid() as any;
    invalid.systems[0].customLabels = ['A'];
    expect(() => validateWormholesystemsTopology(invalid)).toThrow(/Unrecognized source system field/);

    const fabricatedStatus = valid() as any;
    fabricatedStatus.systems[0].status = 'active';
    expect(() => validateWormholesystemsTopology(fabricatedStatus)).toThrow(/Unrecognized source system field/);
  });

  it('accepts Nexum connection types and ship sizes without inventing defaults', () => {
    const input = valid();
    input.connections[0].connection_type = 'cyno';
    input.connections[0].ship_size = 'xl';
    expect(validateWormholesystemsTopology(input).connections[0]).toMatchObject({ connectionType: 'cyno', size: 'xl' });

    (input.connections[0] as any).ship_size = 'xlarge';
    expect(() => validateWormholesystemsTopology(input)).toThrow(/source connection identity/);
  });
});
