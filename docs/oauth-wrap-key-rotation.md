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

Prerequisites: this PR's build is deployed on the host (the command does not exist
otherwise) and `sqlite3` is installed. Run as the service user, with `umask 077` set
for the whole session (`umask 077`), so every file created below is private. Use the same invocation your host uses for the admin CLI
(`munin-admin`, or `npx munin-admin` from the install directory). **Always pass
`--db <path>` with the exact path the service uses** (`MUNIN_MEMORY_DB_PATH` in
the service `.env`); the CLI does not read that `.env`, and the default DB may be
a different, empty one.

## Procedure

0. **Define the DB path** exactly as the service uses it and check it:
   ```bash
   umask 077
   DB=/path/from/MUNIN_MEMORY_DB_PATH   # fill in; never leave empty
   test -s "$DB" || echo "STOP: DB path wrong or empty"
   cp -p ~/munin-memory/.env ~/munin-memory/.env.pre-wrap-rotation
   ```
1. **Stop the service and take a consistent backup, then verify it.**
   ```bash
   sudo systemctl stop munin-memory
   sqlite3 "$DB" ".backup '$HOME/memory.db.pre-wrap-rotation'"   # or your normal backup job
   sqlite3 ~/memory.db.pre-wrap-rotation "select count(*) from oauth_clients"
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
     (strips quotes. systemd does not strip inline comments, so a comment on that
     line would be part of the real key. If there are duplicate lines, edit the file
     so it holds exactly one line. If the old key is a retired bearer no longer in
     `.env`, create the file without echoing it: `read -rs K; printf %s "$K" > ~/wrap-old.key; unset K`.
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
   **Required result on this first run:** `N would be re-wrapped, 0 already on new
   key`, with `N` equal to the confidential clients you expect. Anything else:
   STOP. `0 re-wrapped, N already on new key` means the key files are swapped; a
   total of 0 means wrong DB; an abort naming a client means some rows are wrapped
   under a different key (e.g. registered after a bearer rotation): re-run the
   command in two passes (old=A, new=B, then old=B, new=final) or re-register that
   client.
5. **Re-wrap** (one immediate transaction, idempotent, audit event
   `oauth_wrap_key_rewrap`):
   ```bash
   munin-admin oauth-clients rewrap-secrets --db "$DB" \
     --old-key-file ~/wrap-old.key --new-key-file ~/wrap-new.key
   ```
6. **Switch the service key** without displaying it:
   ```bash
   sed -i '/^MUNIN_OAUTH_CLIENT_SECRET_KEY=/d' ~/munin-memory/.env
   [ -n "$(tail -c1 ~/munin-memory/.env)" ] && echo >> ~/munin-memory/.env   # ensure trailing newline
   printf 'MUNIN_OAUTH_CLIENT_SECRET_KEY=%s\n' "$(cat ~/wrap-new.key)" >> ~/munin-memory/.env
   chmod 600 ~/munin-memory/.env
   grep -c '^MUNIN_OAUTH_CLIENT_SECRET_KEY=' ~/munin-memory/.env   # must print 1
   sudo systemctl start munin-memory
   ```
   The log must show no "MUNIN_OAUTH_CLIENT_SECRET_KEY is not set" warning and no
   decrypt errors.
7. **Verify**: an existing confidential OAuth client completes a token/refresh
   request (this is the real proof). Re-running step 4 with the same files must now
   report `0 re-wrapped, N already on new key`; on its own that output also appears
   when files are swapped, which is why step 4's first-run check matters.
8. **Store the new key** in the password manager (copy it from the file with your
   editor/clipboard tool, not into chat), confirm it is stored, then
   `shred -u ~/wrap-old.key ~/wrap-new.key ~/memory.db.pre-wrap-rotation ~/munin-memory/.env.pre-wrap-rotation`
   (keep the DB backup until you are satisfied; it holds secrets wrapped under the retired key). Treat the old value as retired.

## Rollback

Stop the service, restore `~/memory.db.pre-wrap-rotation` over the DB (remove stale
`-wal`/`-shm` files), restore `~/munin-memory/.env.pre-wrap-rotation` over `.env`, start the service. If the
re-wrap itself failed it was a single transaction, so the DB is unchanged and the
step can simply be re-run after fixing the cause.

## Alternative

Without the command, remove confidential clients (`munin-admin oauth-clients
remove <id>`) and re-register them under the new key.
