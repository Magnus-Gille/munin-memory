#!/usr/bin/env node
/**
 * Hermetic semantic gate for docs/backup-dependency-contract-v1.schema.json.
 * JSON Schema checks record shape; this gate checks cross-record, deadline and
 * freshness semantics a generic schema cannot express. It never contacts a
 * target and deliberately has no endpoint, credential, or path input.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "tests", "fixtures", "backup-dependency-contract");
const schema = JSON.parse(fs.readFileSync(path.join(root, "docs", "backup-dependency-contract-v1.schema.json"), "utf8"));
const read = (file) => JSON.parse(fs.readFileSync(path.join(fixtures, file), "utf8"));
const positive = read("positive.json");
const negative = read("negative.json");
const id = /^[a-z][a-z0-9-]{2,62}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const fail = (message) => { throw new Error(message); };
const exact = (value, names, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  for (const name of names) if (!Object.hasOwn(value, name)) fail(`${label}.${name} missing`);
  for (const name of Object.keys(value)) if (!names.includes(name)) fail(`${label}.${name} is not a v1 field`);
};
const date = (value, label) => { if (typeof value !== "string" || !utc.test(value) || Number.isNaN(Date.parse(value))) fail(`${label} must be a UTC timestamp`); return Date.parse(value); };

function rejectPrivate(value, label = "$") {
  if (typeof value === "string") {
    if (/(?:\b(?:10|127|192\.168)\.|\b172\.(?:1[6-9]|2\d|3[01])\.|\.local\b|\/(?:home|Users)\/|\.ssh\/|(?:password|token|secret)=)/i.test(value)) fail(`${label} contains private locator or credential-like data`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => rejectPrivate(item, `${label}[${index}]`));
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (/^(?:host|address|path|credential|password|token|secret|private_path)$/i.test(key)) fail(`${label}.${key} is not public contract data`);
    rejectPrivate(item, `${label}.${key}`);
  }
}

function recordsFor(input, requireRestore = true) {
  const records = input.records;
  if (!Array.isArray(records) || records.length !== (requireRestore ? 4 : 3)) fail("fixture has an unexpected evidence set");
  const find = (kind) => records.find((record) => record.kind === kind) ?? fail(`missing ${kind}`);
  return { contract: find("backup-dependency"), target: find("backup-target-evidence"), backup: find("backup-run-evidence"), restore: requireRestore ? find("restore-evidence") : records.find((record) => record.kind === "restore-evidence") };
}

function validateShape({ contract, target, backup, restore }) {
  exact(contract, ["kind", "schema_version", "node_substrate_contract", "workload_id", "dependency_id", "target", "snapshot", "transfer", "storage", "verification", "failure_behavior", "offsite"], "contract");
  if (contract.kind !== "backup-dependency" || contract.schema_version !== "v1" || contract.node_substrate_contract !== "grimnir.node-substrate/v1" || contract.workload_id !== "munin-memory" || !id.test(contract.dependency_id)) fail("unsupported backup contract identity");
  exact(contract.target, ["target_id", "logical_storage_role", "authentication_boundary"], "contract.target");
  exact(contract.snapshot, ["consistency", "expected_size_mib", "cadence_seconds", "timeout_seconds"], "contract.snapshot");
  exact(contract.transfer, ["minimum_throughput_mibps", "window_seconds"], "contract.transfer");
  exact(contract.storage, ["minimum_free_mib", "write_guarantee"], "contract.storage");
  exact(contract.verification, ["integrity", "restore_cadence_seconds", "restore_max_age_seconds"], "contract.verification");
  exact(contract.failure_behavior, ["target_offline", "stale_evidence", "interrupted_transfer", "target_relocated"], "contract.failure_behavior");
  exact(contract.offsite, ["independent_from_near_site", "encryption"], "contract.offsite");
  if (!id.test(contract.target.target_id) || contract.target.logical_storage_role !== "near-site-backup" || contract.target.authentication_boundary !== "owner-overlay" || contract.snapshot.consistency !== "sqlite-online-backup" || contract.storage.write_guarantee !== "verified-size-and-sha256" || contract.verification.integrity !== "sqlite-integrity-check" || contract.offsite.independent_from_near_site !== true || contract.offsite.encryption !== "client-side") fail("invalid public backup dependency declaration");
  for (const [label, value] of Object.entries({ ...contract.snapshot, ...contract.transfer, ...contract.storage, ...contract.verification })) if (typeof value === "number" && (!Number.isInteger(value) || value < 1)) fail(`${label} must be a positive integer`);
  if (contract.failure_behavior.target_offline !== "blocked" || contract.failure_behavior.stale_evidence !== "blocked" || contract.failure_behavior.interrupted_transfer !== "retain-prior-verified-copy-and-block" || contract.failure_behavior.target_relocated !== "require-new-target-id-and-fresh-preflight") fail("failure behavior must fail closed");
  for (const [label, record, fields] of [
    ["target", target, ["kind", "schema_version", "dependency_id", "target_id", "observed_at", "valid_until", "free_mib", "write_probe", "throughput_mibps", "evidence_digest"]],
    ["backup", backup, ["kind", "schema_version", "dependency_id", "target_id", "completed_at", "outcome", "snapshot_consistency", "integrity", "copy_verification", "transfer_seconds", "evidence_digest"]],
    ...(restore ? [["restore", restore, ["kind", "schema_version", "dependency_id", "target_id", "restored_at", "outcome", "representative_data", "evidence_digest"]]] : []),
  ]) exact(record, fields, label);
  for (const record of [target, backup, ...(restore ? [restore] : [])]) if (record.schema_version !== "v1" || record.dependency_id !== contract.dependency_id || record.target_id !== contract.target.target_id || !digest.test(record.evidence_digest)) fail("evidence binding or digest invalid");
  if (!Number.isInteger(target.free_mib) || target.free_mib < 0 || !Number.isInteger(target.throughput_mibps) || target.throughput_mibps < 0 || !Number.isInteger(backup.transfer_seconds) || backup.transfer_seconds < 0) fail("invalid measurement");
}

function preflight(input, requireRestore = true) {
  const records = recordsFor(input, requireRestore); validateShape(records); rejectPrivate(input);
  const { contract, target, backup, restore } = records; const now = date(input.now, "now");
  const observedAt = date(target.observed_at, "target.observed_at"); const validUntil = date(target.valid_until, "target.valid_until");
  if (validUntil <= observedAt || validUntil <= now) fail("target evidence is stale or invalid");
  if (target.write_probe !== "verified") fail("target write guarantee is unverified");
  if (target.free_mib < contract.storage.minimum_free_mib) fail("target lacks required free space");
  if (target.throughput_mibps < contract.transfer.minimum_throughput_mibps) fail("target throughput below declared minimum");
  const plannedSeconds = Math.ceil(contract.snapshot.expected_size_mib / target.throughput_mibps);
  if (plannedSeconds > contract.transfer.window_seconds || plannedSeconds > contract.snapshot.timeout_seconds) fail("transfer cannot complete inside declared window or timeout");
  const completedAt = date(backup.completed_at, "backup.completed_at");
  if (completedAt > now || now - completedAt > contract.snapshot.cadence_seconds * 1000) fail("backup evidence is stale or from the future");
  if (backup.outcome !== "success" || backup.snapshot_consistency !== contract.snapshot.consistency || backup.integrity !== "passed" || backup.copy_verification !== "passed" || backup.transfer_seconds > contract.transfer.window_seconds || backup.transfer_seconds > contract.snapshot.timeout_seconds) fail("backup run is not a verified SQLite-consistent copy");
  const restoreAt = restore ? date(restore.restored_at, "restore.restored_at") : 0;
  const restoreCurrent = Boolean(restore) && restore.outcome === "passed" && restore.representative_data === "verified" && now - restoreAt <= contract.verification.restore_max_age_seconds * 1000;
  if (requireRestore && !restoreCurrent) fail("representative restore evidence is absent or stale");
  return { restoreCurrent };
}

const cloned = () => structuredClone(positive);
assert.equal(schema.$id, "https://munin-memory.gille.ai/contracts/backup-dependency/v1/schema.json");
assert.deepEqual(schema.oneOf.map((branch) => branch.$ref).sort(), ["#/$defs/backup-dependency", "#/$defs/backup-run-evidence", "#/$defs/backup-target-evidence", "#/$defs/restore-evidence"].sort(), "schema must expose every v1 contract record");
assert.deepEqual(preflight(positive), { restoreCurrent: true });
for (const [name, changes] of Object.entries(negative)) {
  if (name === "integrity_without_restore" || name === "privacy_adversarial") continue;
  const fixture = cloned();
  if (name === "poor_throughput" || name === "stale_target_evidence") Object.assign(fixture.records.find((r) => r.kind === "backup-target-evidence"), changes);
  else if (name === "timeout" || name === "interrupted_transfer") Object.assign(fixture.records.find((r) => r.kind === "backup-run-evidence"), changes);
  else if (name === "relocated_target") Object.assign(fixture.records.find((r) => r.kind === "backup-target-evidence"), changes);
  assert.throws(() => preflight(fixture), undefined, `${name} must fail closed`);
}
const integrityOnly = cloned(); integrityOnly.records = integrityOnly.records.filter((record) => record.kind !== "restore-evidence");
// Integrity/copy proves this run's snapshot. It deliberately does not become restore evidence.
assert.deepEqual(preflight(integrityOnly, false), { restoreCurrent: false });
assert.throws(() => preflight(integrityOnly), undefined, "missing restore evidence blocks recovery-ready preflight");
const privacy = cloned(); Object.assign(privacy.records[0].target, negative.privacy_adversarial);
assert.throws(() => preflight(privacy), undefined, "private contract material must be rejected");
console.log("Backup dependency v1 contract fixtures validated: positive plus throughput, timeout, interruption, stale, relocation, privacy, and restore-distinction adversaries.");
