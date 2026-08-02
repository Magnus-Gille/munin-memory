# External backup dependency contract (v1)

Munin Memory publishes `backup-dependency` v1 as a workload/dependency extension
for the [Grimnir node/substrate v1 boundary](https://github.com/Magnus-Gille/grimnir/blob/main/docs/adr-007-node-substrate-contract.md).
It declares requirements; it is not an inventory, a deployment instruction, or
permission to mutate a target.

The normative schema is [backup-dependency-contract-v1.schema.json](backup-dependency-contract-v1.schema.json).
Its hermetic fixture gate is `node scripts/validate-backup-dependency-contract.mjs`.

## Boundary and privacy

The consumer is `munin-memory`; `dependency_id` and `target_id` are stable,
logical identities. `logical_storage_role` names the near-site role, not a
machine or share. Authentication is represented only as `owner-overlay`:
endpoints, paths, usernames, credentials, topology and mount details remain in
the owner-only operational overlay.

The contract is compatible with node/substrate v1's separation of facts:

- Munin owns its SQLite snapshot, transfer, integrity and restore semantics.
- Brokkr (or another approved substrate observer) produces fresh target evidence.
- Grimnir owns desired placement and the public component registry.

An evidence record is bound to the declared `dependency_id` and `target_id`.
A changed target ID is a relocation, not an update: the consumer blocks until a
fresh preflight addresses the new identity.

## Decision gate

Before a near-site backup or relocation plan is accepted, the consumer requires:

1. Fresh target evidence with the declared free space, verified write probe and
   measured throughput.
2. A preflight calculation: `ceil(expected_size_mib / measured_mibps)` must fit
   both the transfer window and snapshot timeout.
3. A SQLite-consistent `sqlite-online-backup` snapshot. A successful transport
   process is insufficient: the copy needs both SQLite integrity and verified
   destination size/SHA-256 evidence.

Target offline, missing/expired evidence, insufficient capacity, throughput
below minimum, an interrupted or timed-out transfer, and target-ID mismatch all
block. An interrupted transfer retains the prior verified copy; it must never
be treated as a new success.

## Restore evidence and offsite independence

`backup-run-evidence` proves a single copy's consistency, integrity and delivery.
It is intentionally different from `restore-evidence`, which proves a periodic,
representative restore. A planner requiring recovery readiness blocks when the
restore evidence is missing, failed or older than `restore_max_age_seconds`.

The near-site target does not replace the encrypted offsite path. v1 requires
`offsite.independent_from_near_site: true` and client-side encryption. The
existing offsite snapshot/rclone mechanism remains separately configured and is
not reachable through this contract.

## Current implementation boundary

This is a versioned declaration and validation contract only. It does not alter
the service unit, choose an endpoint, install timers, or execute a backup.
Live evidence must be produced and retained by the substrate/operations owner
before any planner can claim that a real target satisfies v1.
