# Offsite backup — encrypted cloud copy of the memory DB (munin-memory#172)

An encrypted third copy of Munin's SQLite memory DB, pushed to cloud (OneDrive)
through an rclone **crypt** remote. It **reuses the reference offsite mechanism**
from mimir#10 (`scripts/offsite-backup.sh`, copied verbatim) and adds the one
munin-specific step: a **consistent SQLite snapshot** before the sync, so a live DB
is never uploaded mid-write.

## Where this fits

Grimnir backups follow **3-2-1**, split by data class:

- **Copy 1** — live `~/.munin-memory/memory.db` on the Pi (huginmunin).
- **Copy 2** — NAS disk `/mnt/timemachine/backups/munin-memory/` (`backup-to-nas.sh`,
  `sqlite3 .backup` snapshots, GFS retention).
- **Copy 3 (this)** — encrypted push to OneDrive. Geographically offsite, automatic,
  survives loss of the whole property.

The memory DB holds personal/assistant memory, so the cloud copy is **client-side
encrypted** — the provider only ever stores opaque blobs (contents *and* filenames).

## What the job does

Two scripts on the Pi, run by `munin-offsite.timer` (daily 03:45):

**`scripts/offsite-snapshot.sh`** (the munin entrypoint):

1. `VACUUM INTO` a fresh, standalone snapshot at `~/.munin-memory/offsite-staging/munin.sqlite`.
   `VACUUM INTO` is safe to run while the server writes (WAL readers don't block
   writers) and yields a consistent point-in-time DB with **no WAL sidecars** — no torn
   write can be uploaded.
2. Verify the snapshot with `PRAGMA integrity_check` — a corrupt snapshot is refused
   (fail-loud: `fail` Heimdall panel + non-zero exit) rather than shipped.
3. Set `MIMIR_OFFSITE_ROOT` to the staging dir and hand off (`exec`) to the shared
   mechanism.

**`scripts/offsite-backup.sh`** (copied verbatim from mimir#10 — the shared pattern):

4. Preflight: rclone present, source exists, and the remote is a **verified crypt
   remote** with filename encryption on — fails *closed* otherwise, so a misconfig can
   never upload plaintext.
5. Delete-count gate: aborts *before* touching the remote if the sync would move an
   implausible share of `current/` to the archive.
6. `rclone sync <staging>/ → munin-crypt:current` — mirrors the snapshot (destination
   auto-created on first run).
7. Overwritten/deleted files are **moved** to a per-run `munin-crypt:archive/<utc-timestamp>/`
   via `--backup-dir` (never destroyed), giving **30-day version history**. `--max-delete`
   is a second-line guard behind the gate in step 5.
8. Prunes whole archive run-dirs older than 30 days **by their timestamped name** — not
   by object mtime (sync preserves source mtimes, so mtime-based pruning would wrongly
   delete a just-archived *old* file the moment it was archived — a critical data-loss
   bug caught in the mimir review; do not reintroduce it).
9. Writes a heartbeat stamp and pushes a `pass`/`fail` **Heimdall status panel**
   (service `munin`).

The snapshot + mirror path is fail-loud: any error exits non-zero **and** pushes a
`fail` panel. Archive pruning is best-effort — a prune failure logs a warning but still
reports `pass`.

---

## One-time setup

### 1. Install rclone on the Pi

```bash
ssh magnus@huginmunin.local
sudo -v ; curl https://rclone.org/install.sh | sudo bash
rclone version   # confirm
```

### 2. Authorize OneDrive (headless — token minted on the laptop)

The Pi has no browser, so mint the OAuth token on the **laptop** and paste it over.

On the **laptop** (`brew install rclone` first):

```bash
rclone authorize "onedrive"
# → opens a browser, log in as magnus.gille@outlook.com, grant access
# → prints a JSON token blob. Copy the whole {...}.
```

On the **Pi**, `rclone config`:

```
n) New remote
name> onedrive
Storage> onedrive
client_id>            (blank)
client_secret>        (blank)
region> global
Edit advanced config? n
Use auto config? n                     ← headless
config_token> <paste the JSON from the laptop>
Choose a number ... Type of connection> 1  (OneDrive Personal)
Yes this is OK> y
```

> If mimir already created an `onedrive` remote on the same Pi, you can reuse it — the
> crypt remote below is what isolates munin's data and key. Munin lands under a
> **separate path** (`onedrive:Grimnir/munin`).

Verify: `rclone lsd onedrive:` lists your OneDrive top-level folders.

### 3. Create munin's OWN crypt remote (client-side encryption)

**Do NOT reuse mimir's `mimir-crypt` remote or its key.** Munin gets its own crypt
remote with its own password + salt.

```
rclone config
n) New remote
name> munin-crypt
Storage> crypt
remote> onedrive:Grimnir/munin          ← where munin's encrypted blobs land
filename_encryption> standard           ← encrypt filenames too
directory_name_encryption> true
Password or pass phrase for encryption:
  g) Generate random password  → choose a LONG one (or paste your own)
Password or pass phrase for salt (password2):
  g) Generate random password  → generate a separate salt
Edit advanced config? n
Yes this is OK> y
```

> **Use the `munin-crypt` remote name the script defaults to**, or set
> `MIMIR_OFFSITE_REMOTE` to whatever you named it.

### 4. 🔑 Key custody (do NOT skip — this is the single point of no return)

The crypt **password + salt** are the only way to decrypt munin's offsite copy. They
live (obscured) inside `~/.config/rclone/rclone.conf` on the Pi. **If the Pi dies and
you don't have them elsewhere, every byte of the memory DB in OneDrive is permanently
unreadable.**

- This is a **separate key from mimir's** — back it up **independently**.
- Reveal once: `rclone config show munin-crypt` (shows `password` / `password2` in
  obscured form) — or better, note the *plaintext* password + salt you set in step 3.
- Store the **plaintext password + salt** in your password manager (and/or the
  fireproof safe), under an entry like `munin-crypt (rclone offsite key)`.
- **Never** commit them, never write them into the DB, and **never store them in
  Munin** (that would encrypt the key into the very backup it unlocks).

Lock the config down:

```bash
chmod 600 ~/.config/rclone/rclone.conf
```

### 5. Environment

The service reads `EnvironmentFile=-/home/magnus/repos/munin-memory/.env` (optional).
It only needs the shared Heimdall vars there for the status panel — **no crypt key**
(that stays in the rclone config). Optional overrides (defaults shown):

```
# HEIMDALL_HUB_URL / HEIMDALL_FLEET_TOKEN            # shared — pass/fail status panel
# MIMIR_OFFSITE_REMOTE=munin-crypt                   # crypt remote NAME (no ':' / path)
# MIMIR_OFFSITE_SERVICE=munin                        # Heimdall service id
# MIMIR_OFFSITE_RETENTION_DAYS=30                    # archive prune horizon
# MIMIR_OFFSITE_MAX_DELETE=1000                      # abort if a run removes ≥ this many files
# MIMIR_OFFSITE_MAX_DELETE_PCT=25                    # ...or more than this % of current/
# MUNIN_OFFSITE_DB=$HOME/.munin-memory/memory.db     # live DB to snapshot
# MUNIN_OFFSITE_STAGING=$HOME/.munin-memory/offsite-staging   # DEDICATED snapshot dir (becomes ROOT)
# MUNIN_OFFSITE_LOCK=$HOME/.munin-memory/offsite-snapshot.lock # concurrency guard (flock)
# MIMIR_OFFSITE_STAMP=$HOME/.munin-memory/offsite.stamp
# MIMIR_OFFSITE_LOG=$HOME/.munin-memory/offsite-backup.log
# MIMIR_OFFSITE_DRYRUN=1                             # same as passing --dry-run
# RCLONE_BIN=rclone                                  # rclone binary path
```

### 6. Install the timer

```bash
sudo cp /home/magnus/repos/munin-memory/munin-offsite.service /etc/systemd/system/
sudo cp /home/magnus/repos/munin-memory/munin-offsite.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now munin-offsite.timer
systemctl list-timers munin-offsite.timer   # confirm next run
```

---

## Verification (acceptance criteria)

Run these once after setup. **A backup you haven't restored from is not a backup.**

```bash
cd /home/magnus/repos/munin-memory

# a) First push, then confirm ONLY encrypted blobs are in OneDrive.
./scripts/offsite-snapshot.sh
rclone ls onedrive:Grimnir/munin | head        # filenames must be gibberish
#   ↳ open the OneDrive web UI too: names unreadable, no plaintext content.

# b) Integrity: cryptcheck compares hashes THROUGH the crypt layer (plain `check`
#    can silently degrade to size/modtime on a crypt remote).
rclone cryptcheck ~/.munin-memory/offsite-staging munin-crypt:current

# c) RESTORE TEST — decrypt to a scratch dir, verify the DB opens and is intact.
rclone copy munin-crypt:current /tmp/munin-restore
sqlite3 /tmp/munin-restore/munin.sqlite "PRAGMA integrity_check;"   # want: ok
rm -rf /tmp/munin-restore

# d) 30-day history: two runs after a change, confirm the prior version is preserved
#    in the most recent archive run-dir.
./scripts/offsite-snapshot.sh       # run 1
# ... make a memory write via the server ...
./scripts/offsite-snapshot.sh       # run 2
LATEST=$(rclone lsf --dirs-only munin-crypt:archive | sort | tail -1)
rclone lsf "munin-crypt:archive/${LATEST}"   # prior munin.sqlite preserved

# e) Fail-loud: point at a bad remote, confirm non-zero exit + a fail panel in Heimdall.
MIMIR_OFFSITE_REMOTE=does-not-exist ./scripts/offsite-snapshot.sh; echo "exit=$? (want non-zero)"
```

Dry-run any time without touching the remote (still takes a local snapshot):
`./scripts/offsite-snapshot.sh --dry-run`.

## Disaster recovery (Pi is gone)

1. On any machine: `brew install rclone` (or the install script).
2. `rclone config` → recreate the `onedrive` remote (re-authorize) **and** the
   `munin-crypt` remote using the **password + salt from your password manager**
   (step 4). The remote path must match: `onedrive:Grimnir/munin`.
3. `rclone copy munin-crypt:current ~/munin-restored` → plaintext `munin.sqlite` back.
4. `sqlite3 ~/munin-restored/munin.sqlite "PRAGMA integrity_check;"` → confirm `ok`,
   then move it into place at `~/.munin-memory/memory.db` (server stopped).

## Reuse note

`scripts/offsite-backup.sh` is a **verbatim copy** of mimir's reference script (mimir#10)
— keep it diffable so shared safety fixes propagate. Munin-specific behavior lives only
in `scripts/offsite-snapshot.sh` (the consistent-snapshot wrapper). The `MIMIR_OFFSITE_*`
env-var names are the shared offsite namespace, not the mimir service.
