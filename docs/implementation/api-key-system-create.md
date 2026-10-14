# WormholeSystems topology reconciliation

## Authorization and trust boundary

`PUT /api/v1/maps/:mapId/wormholesystems/topology` is the dedicated topology route. A `wormholesystems_sync` API key is explicitly bound to one Nexum map and inherits the existing read, events, and content-write capabilities, but topology changes are allowed only through this route. No human approver, per-change approval flow, or separate source-signing/control plane is involved.

The map-bound key is held only by the trusted Galaxy service. Its map binding plus that service trust is the authorization boundary; Nexum does not independently authenticate WormholeSystems upstream. Do not add source identity to the key UI or key metadata. Galaxy supplies `sourceIdentity` as a validated canonical ownership namespace in the form `wormholesystems:${JSON.stringify([origin, selectedSourceMapId])}`. Nexum validates that canonical form and uses the exact identity to scope ownership, checkpoint, update, and delete queries. One identity can never mutate or delete rows recorded under another identity.

Galaxy may submit only after it has validated a complete full-map fetch, including response fan-out, member/reference consistency, and the exact target map. The request's `snapshot.complete` is an attestation from this trusted service, not independently verifiable source proof. Complete map membership represents topology presence only; it does not claim a system or connection is physically live. `fetchedAt` is stamped by Galaxy after the validated full-map fetch completes. Nexum rejects missing, malformed, future-dated, or more-than-10-minute-old timestamps. `snapshot.maxAgeMs` is not accepted or client-configurable. Per-row observation timestamps and fabricated active/status values are not part of the request contract.

## Request and ownership rules

The body is strict and bounded: at most 100 systems and 2,000 connections; source IDs are bounded trimmed strings, EVE system IDs are positive valid Nexum SDE IDs, positions are finite and bounded, and source connection fields `connection_type` / `ship_size` must use Nexum values (`standard`, `gate`, `jumpgate`, `cyno`; `small`, `medium`, `large`, `xl`). No unsupported defaults are invented. Unknown fields, duplicate identities, invalid endpoints, incomplete membership, and invalid freshness evidence are rejected before topology mutation.

Only rows transactionally created and recorded in `wormholesystems_topology_ownership` are eligible for source updates/deletes. Existing manual rows are never claimed. Reconciliation preserves managed-field edits, ambiguous endpoints, dependencies, and manual data. Omission from a complete validated membership snapshot is topology absence for that source, not a physical-liveness assertion. Publish `map.resync` only after a committed topology change.

## Ordering and retry behavior

Galaxy serializes source fetch/apply per map in its process. Nexum additionally serializes applies by locking the map row and persists `(map_id, source_identity, fetchedAt, digest)` in `wormholesystems_topology_checkpoints`. The checkpoint comparison, topology reconciliation, and checkpoint advance share one database transaction.

The digest covers the canonically normalized full validated payload, including desired IDs/fields and `fetchedAt`; list order alone does not change it. A timestamp older than the accepted checkpoint returns 409. The same timestamp and digest is a successful no-op. The same timestamp with a different digest returns 409. A later fresh timestamp can apply and advance the checkpoint even if topology itself is unchanged; failed transactions never advance it. This protects against out-of-order Galaxy submissions using trusted Galaxy's per-map serialization; it does not establish upstream source ordering or detect an upstream rollback. No generation counter or run journal is used.

## Validation

Run Nexum server/web builds, focused topology service tests, the topology integration test, and `git diff --check`. Report an integration database skip as skipped; it is not a passing database-backed authorization/ownership check.
