# Publication safety note

The current tree is prepared as a public source release: generated user-test
transcripts and owner/client-specific deployment material are excluded, benchmark
fixtures remain ignored, and examples use synthetic identities.

This does **not** certify the existing Git history or hosting metadata. Before making
the repository public, scan every reachable ref (branches, tags, pull-request refs,
releases, Actions artifacts, issue attachments, and Git LFS objects) with a secret
scanner and review historical benchmark/output commits. If sensitive content is
found, rotate affected credentials first, then rewrite or replace the relevant
history and coordinate removal of cached hosting artifacts.

Never commit a Munin database, WAL/SHM sidecar, credentials file, `.env`, benchmark
snapshot, model transcript, rclone configuration, or restored backup.

`.gitleaks.toml` allowlists only exact, obviously synthetic credential strings used
by redaction tests. Do not broaden it to whole test directories.
