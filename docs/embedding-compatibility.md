# Embedding compatibility

Migration 31 adds nullable `entries.embedding_identity`. It does not rewrite any
memory content, timestamps, vector values or shipped migrations. Old vectors keep
an unknown identity until the background worker regenerates them.

The version-1 canonical JSON manifest binds model ID, immutable 40-character model
revision, effective dtype, 384 dimensions, mean pooling, L2 normalization,
`raw-text-v1` preprocessing, installed Transformers and onnxruntime-node versions,
CPU provider, platform and architecture. Exact equality is required before vector
ranking, including the expired-candidate probe. Matching model names alone cannot
establish compatibility. Platform/runtime aliases require independent retrieval
quality evidence before they can be supported; this change makes no equivalence
claim. Weight-file hashing is not implemented; immutable upstream commit pins and
runtime metadata establish the configured artifact identity.

The built-in [BGE revision](https://huggingface.co/Xenova/bge-small-en-v1.5/tree/ea104dacec62c0de699686887e3f920caeb4f3e3) is `ea104dacec62c0de699686887e3f920caeb4f3e3` and
[MiniLM revision](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9) is `751bff37182d3f1213fa05d7196b954e230abad9`. Custom models require
`MUNIN_EMBEDDINGS_REVISION`. Dtype follows profile/environment configuration, with
an explicit CPU fp32 fallback. Missing/invalid revision or runtime metadata fails
closed: no model initialization or worker claims, and semantic/hybrid requests
fall back explicitly to lexical search.

Model IDs must use Hugging Face `owner/repository` syntax. Unversioned local model
directories and URLs are unsupported because Transformers does not apply a
revision to those sources. Loads use the pinned Hub revision or its revision-scoped
filesystem cache. `MUNIN_EMBEDDINGS_LOCAL_ONLY=true` still supports offline reloads
from that cache and fails if the pinned revision is absent; it never falls back to
an unversioned local directory.

Use `node --import tsx scripts/embedding-compatibility.ts --db /absolute/path/to/snapshot.db`
with the intended configuration and runtime to preview counts. It opens an existing
SQLite database read-only, does not run migrations or initialize models, and accepts
pre-migration-31 databases. A snapshot avoids contention with a live service. Run
on the intended platform/architecture when assessing a target host; a macOS preview
cannot predict Linux identity equality.

After deployment, the normal worker claims pending/failed and incompatible/unknown
generated rows in bounded batches. Its captured extractor identity is stored
atomically with the vector and model; a changed configuration discards in-flight
results and requeues work. Content changes retain the existing CAS protection.
Writes never wait for embedding generation. While rebuilding, semantic search can
return no candidates; hybrid search retains its lexical candidates. Health reports
the configured identity, compatible coverage, and backlog including processing and
failed rows. Unknown/stale vectors remain excluded even if the worker is disabled.

Take the repository's normal recoverable backup before deployment and compare
preview/health counts. Verify background convergence and representative searches
on the target before declaring rollout complete. No production reindex or deploy
is performed by this PR. Recovery keeps migration 31 in place (forward-only):
restore the previous configuration and re-embed into its identity. Avoid rolling
back to model-name-only code against mixed vectors, since that code cannot enforce
this guard. Any data-restoring rollback remains a separate approved operation.

Frozen benchmark fixtures retain their recorded provenance and may explicitly omit
identity for legacy fixture compatibility. Production MCP queries always supply
an active extractor identity; benchmark exemptions do not apply to them.

Representative old/new and mixed-runtime quality evaluation remains pending the
human-reviewed bank in #369. Deterministic compatibility tests and native runtime
smokes establish the guard, not retrieval-quality equivalence. This PR references
#374 without closing its remaining evaluation acceptance criterion.
