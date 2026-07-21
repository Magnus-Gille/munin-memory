# Encrypted offsite backup

Munin ships an optional, provider-neutral rclone backup path for its SQLite
database. The design takes a consistent snapshot first and then sends only
client-side encrypted content and filenames to an rclone `crypt` remote.

## Safety model

1. `scripts/offsite-snapshot.sh` creates a standalone database with
   `VACUUM INTO` while the live WAL database remains online.
2. It verifies the copy with `PRAGMA integrity_check` and refuses a corrupt
   snapshot.
3. `scripts/offsite-backup.sh` verifies that the configured remote is an rclone
   `crypt` remote with filename encryption enabled.
4. The script mirrors `current/`, moves overwritten objects to timestamped
   `archive/` directories, and enforces delete-count limits.
5. Optional Heimdall environment variables publish pass/fail status without
   logging credentials.

Never point the rclone script directly at the live SQLite directory. Use the
snapshot wrapper so WAL sidecars cannot produce a torn backup.

## Configure rclone

Create any supported storage remote, then place a dedicated crypt remote over a
directory in it. For example:

```text
name> munin-crypt
Storage> crypt
remote> storage:backups/munin
filename_encryption> standard
directory_name_encryption> true
```

Store the crypt password and salt outside Munin and outside the machine being
backed up. Without those values, an offsite copy cannot be recovered. Keep the
rclone configuration mode at `0600`.

## Configuration

The operational service reads an optional `${HOME}/munin-ops/.env`. Supported
overrides include:

```bash
MIMIR_OFFSITE_REMOTE=munin-crypt
MIMIR_OFFSITE_RETENTION_DAYS=30
MIMIR_OFFSITE_MAX_DELETE=1000
MIMIR_OFFSITE_MAX_DELETE_PCT=25
```

> **A systemd `EnvironmentFile` is not a shell and performs no expansion.** A
> value such as `${HOME}/.munin-memory/memory.db` or `~/.munin-memory/memory.db`
> is passed through literally, the preflight then cannot find that path, and the
> offsite job fails. Omit the database and staging overrides to use the service's
> own `$HOME`-relative defaults, which is the normal case. Override them only
> with fully literal absolute paths:
>
> ```bash
> MUNIN_OFFSITE_DB=/home/youruser/.munin-memory/memory.db
> MUNIN_OFFSITE_STAGING=/home/youruser/.munin-memory/offsite-staging
> ```

The `MIMIR_OFFSITE_*` prefix is retained for compatibility with the shared
backup implementation. It does not require the Mimir service.

## Install and verify

```bash
scripts/install-ops.sh
sudo systemctl enable --now munin-offsite.timer
${HOME}/munin-ops/scripts/offsite-snapshot.sh --dry-run
${HOME}/munin-ops/scripts/offsite-snapshot.sh
```

A backup is not complete until restore has been tested:

```bash
mkdir -p /tmp/munin-restore-test
rclone copy munin-crypt:current /tmp/munin-restore-test
sqlite3 /tmp/munin-restore-test/munin.sqlite "PRAGMA integrity_check;"
```

Delete the restore-test directory after verification; it contains plaintext
memory data.
