# Rotating the OAuth client-secret wrap key (MUNIN-438)

Confidential OAuth client secrets are stored AES-256-GCM encrypted. The key is
`sha256(MUNIN_OAUTH_CLIENT_SECRET_KEY)`, or `sha256(MUNIN_API_KEY)` when the
dedicated variable is unset (the server logs a warning at startup in that case).
Rotating the bearer therefore breaks stored client secrets unless the wrap key is
pinned or re-wrapped. This runbook replaces a pinned (retired) wrap key with a
fresh dedicated one without re-registering clients.

**Secret handling.** Never pass keys on the command line, never paste them into
chat or tickets, never `cat`/echo them, and do not set the `MUNIN_OAUTH_WRAP_KEY_*`
variables inline in an interactive shell (history). Use 0600 key files. The
command prints counts only; errors name a client_id, never a secret.

Run as the service user. Use the same invocation your host uses for the admin CLI
(`munin-admin`, or `npx munin-admin` from the install directory). **Always pass
`--db <path>` with the exact path the service uses** (`MUNIN_MEMORY_DB_PATH` in
the service `.env`); the CLI does not read that `.env`, and the default DB may be
a different, empty one.

## Procedure

1. **Stop the service and take a consistent backup.**
   ```bash
   sudo systemctl stop munin-memory
   sqlite3 "$DB" ".backup '$HOME/memory.db.pre-wrap-rotation'"   # or your normal backup job
   ```
2. **Old key file** — the value the secrets are *currently* wrapped with:
   - If `MUNIN_OAUTH_CLIENT_SECRET_KEY` is set in `.env`, use it. If it is unset or
     empty, it is `MUNIN_API_KEY` **as it was when the secrets were wrapped**
     (the pre-rotation bearer if the bearer has since been rotated).
   - Write it to a 0600 file without displaying it, e.g. (replace `VAR`):
     ```bash
     umask 077
     grep '^VAR=' ~/munin-memory/.env | cut -d= -f2- | tr -d '"'"'" > ~/wrap-old.key
     ```
     (strips quotes; if the line has an inline comment, edit the file instead.
     The dry run in step 4 proves the key is right.)
3. **New key file**, generated locally and never displayed:
   ```bash
   umask 077
   openssl rand -hex 32 > ~/wrap-new.key
   ```
4. **Dry run** (writes nothing; fails if any client decrypts under neither key):
   ```bash
   munin-admin oauth-clients rewrap-secrets --dry-run --db "$DB" \
     --old-key-file ~/wrap-old.key --new-key-file ~/wrap-new.key
   ```
   Check that `total` matches the number of confidential clients you expect. A
   total of 0 triggers a warning: you are probably on the wrong DB.
5. **Re-wrap** (one immediate transaction, idempotent, audit event
   `oauth_wrap_key_rewrap`):
   ```bash
   munin-admin oauth-clients rewrap-secrets --db "$DB" \
     --old-key-file ~/wrap-old.key --new-key-file ~/wrap-new.key
   ```
6. **Switch the service key** without displaying it:
   ```bash
   sed -i '/^MUNIN_OAUTH_CLIENT_SECRET_KEY=/d' ~/munin-memory/.env
   printf 'MUNIN_OAUTH_CLIENT_SECRET_KEY=%s\n' "$(cat ~/wrap-new.key)" >> ~/munin-memory/.env
   chmod 600 ~/munin-memory/.env
   sudo systemctl start munin-memory
   ```
   The log must show no "MUNIN_OAUTH_CLIENT_SECRET_KEY is not set" warning and no
   decrypt errors.
7. **Verify**: an existing confidential OAuth client completes a token/refresh
   request. Re-running step 5 (or 4) with the same files must now report
   `0 re-wrapped, N already on new key`.
8. **Store the new key** in the password manager (copy it from the file with your
   editor/clipboard tool, not into chat), confirm it is stored, then
   `shred -u ~/wrap-old.key ~/wrap-new.key`. Treat the old value as retired.

## Rollback

Stop the service, restore `~/memory.db.pre-wrap-rotation` over the DB (remove stale
`-wal`/`-shm` files), put the old value back in `.env`, start the service. If the
re-wrap itself failed it was a single transaction, so the DB is unchanged and the
step can simply be re-run after fixing the cause.

## Alternative

Without the command, remove confidential clients (`munin-admin oauth-clients
remove <id>`) and re-register them under the new key.
