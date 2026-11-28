# OAuth client-secret wrap-key rotation — design proposal (MUNIN-440, MUNIN-438)

Status: proposal for owner review. Nothing here is implemented, and no key is rotated by this document.

## Problem

Confidential OAuth client secrets are stored as `enc:v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM). The wrap key is
`sha256(MUNIN_OAUTH_CLIENT_SECRET_KEY)`, and **falls back to `sha256(MUNIN_API_KEY)` when the dedicated variable is
unset** (`getClientSecretWrapKey` in `src/oauth.ts`). Two consequences:

1. Rotating the legacy bearer silently changes the wrap key and makes every stored client secret undecryptable
   (this is why MUNIN-438 pinned the wrap key to the old value).
2. There is no way to move to a new wrap key: decryption accepts exactly one key, and the stored format carries no key id.

## Goals and non-goals

- Rotate the wrap key without invalidating clients and without downtime or a flag day.
- Make the bearer-to-wrap-key coupling explicit and removable.
- Fail closed: an undecryptable secret is an error, never a silent skip or overwrite.
- Non-goals: HSM/KMS integration, rotating the OAuth clients' own secrets, changing the cipher.

## Proposal

### 1. Format v2 with a key id

`enc:v2:<kid>:<iv>:<tag>:<ciphertext>`, where `kid` is the first 8 hex chars of `sha256(sha256(key))` (a fingerprint
of the derived key, not reversible to the key). `v1` stays readable forever (no `kid`).

### 2. A key ring with one active key

- `MUNIN_OAUTH_CLIENT_SECRET_KEY` — the active key: all new writes use it.
- `MUNIN_OAUTH_CLIENT_SECRET_KEY_PREVIOUS` — optional, decrypt-only, during a rotation window.
- Decrypt order: `kid` match in the ring; for `v1` rows try active, then previous, then (compat) `MUNIN_API_KEY`.
- With neither variable set the legacy fallback to `MUNIN_API_KEY` still works for existing deployments, but startup logs
  a one-line deprecation warning and `memory_status` reports `oauth_wrap_key: "legacy-bearer-fallback"`.

### 3. An explicit re-wrap command

`munin-admin oauth-clients rewrap [--apply]`:

- Default is a dry run: decrypts every row with the ring and reports counts by format/kid and any undecryptable rows.
- `--apply` re-encrypts all rows under the active key in a single transaction, writes an audit row, and refuses to commit
  if any row fails to decrypt. Idempotent: rows already under the active key are left alone.
- Prints counts only, never secrets. Honors the DB-backup precondition (refuses unless a backup newer than N minutes is
  recorded, or `--no-backup-check` is given).

### 4. Rotation procedure (owner-run)

1. Back up the database. Generate a new random key and put it in the service env file as `..._KEY`, moving the old value
   to `..._KEY_PREVIOUS` (via the stdin installer in grimnir `scripts/install-secret-stdin.py`, never argv).
2. Restart; verify existing OAuth clients still authenticate (decrypt via PREVIOUS).
3. `munin-admin oauth-clients rewrap` (dry run), then `--apply`.
4. Verify again, then remove `..._KEY_PREVIOUS` and restart.
5. Reversal at every step before 4: restore the env file (`.prev` from the installer) and restart; v2 rows stay readable
   because the ring still holds both keys. After 4, reversal is a restore from the step-1 backup.

### 5. Decoupling the legacy bearer

After the first rotation the bearer can be rotated independently. A later release can drop the `MUNIN_API_KEY` fallback
(pre-1.0 breaking change, changelog entry) once `memory_status` shows no deployment relying on it.

## Risks and open questions

- A lost key makes rows permanently unreadable; the re-wrap dry run is the guard, and the backup is the recovery.
- `kid` is a fingerprint of key material: acceptable because it is of the derived hash and the key is high-entropy;
  alternative is a random per-key label stored in config (simpler to reason about, one more thing to configure).
- Should `rewrap` also cover other encrypted-at-rest fields added later? Proposal: make it a registry of wrap users.
- Tests needed: v1/v2 round trips, ring ordering, partial-failure rollback, undecryptable-row refusal, dry-run
  no-write, audit row content, no secret in any output.

## Suggested implementation order

1. v2 format + ring decrypt (behavior-preserving), tests.
2. `memory_status` reporting + deprecation warning.
3. `rewrap` command.
4. Runbook + grimnir credential registry entry updated from `no-rotation-path` to the real procedure.
