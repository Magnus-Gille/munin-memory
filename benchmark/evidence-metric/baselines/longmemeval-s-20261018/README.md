# LongMemEval-S packed entry-ID baseline, 2026-10-18

The new frozen run measured **297/500 questions (59.4%)** with every expected
entry ID present in packed context. This is a new reproduction using freshly
generated corpus and query vectors. It does not reproduce the historical
296/500 result, establish historical vector provenance, or attribute the one
question difference to a code improvement.

`baseline.json` is an exact copy of the initial measured report, SHA-256
`a705dee0e10c66409bac95404f7b78bed576a7b84facaf77e25c0debb2204e96`.
Its original `quality_state:"not_measured"` means that it had **no prior baseline
comparison**; the 500 measured rows and their summary are present. No report
fields were rewritten to manufacture a comparison or approval result. A separate
offline replay exited 0 with `quality_state:"unchanged"`: all 500 rows matched
exactly, including order, IDs, budgets and truncation flags; bindings and summary
also matched with no gained or lost all-gold questions. Its SHA-256 is
`7c0a5e38ffd768c29b525c3f6afffcc2edce9b34f3d57b5676cea12a77cd06f8`.
The full replay report is retained locally and a compact receipt is recorded in
provenance. This local baseline package passed independent source and artifact
review.

This metric counts entry IDs in packed context. It does not measure answer
accuracy or complete evidence text/span coverage. All 500 budgets have
`truncated:true` and omit at least one of the ten retrieved candidates. That
does not mean every first block's text was truncated. The serializer can count
the first block's ID even when that block's content is truncated.

The run uses LongMemEval-S session granularity, 23,854 entries, per-question
haystack namespaces, production hybrid retrieval, recency weight 0, top 10,
linear packing and an 8192-token UTF-8-byte estimate. The fixed clock is
`2026-10-01T00:00:00.000Z`; semantic distance cutoff is unset.

The frozen vectors were generated on **Node 26.11.1, darwin/arm64**, using
Transformers **4.3.1** and onnxruntime-node **1.30.0**, CPU/fp32, 384 dimensions,
mean pooling and L2 normalization. BGE `Xenova/bge-small-en-v1.5` is pinned to
`ea104dacec62c0de699686887e3f920caeb4f3e3`. Generation used clean source revision
`9009370463adf739c76f451dcefa161a17ac1a17`; the initial evaluator records revision
`fb00719b07651d7bf935314840773662a51363fe` and individual source hashes.

`provenance.json` records the input, runtime, source, clock, counts and file hashes
without machine-specific absolute paths. `upstream-model-verification.json` is
the retained upstream verification receipt for the pinned inference files and
the extra discovery config. Transformers 4.3.1 queried `main` during discovery;
the unversioned config's bytes matched the pinned upstream config. Actual model,
tokenizer and ONNX loads used the pinned revision. Evaluation never loads a
model or contacts a provider.

## Retained artifacts and replay

The large frozen inputs remain in the persistent, Git-ignored directory
`benchmark/generated/evidence-metric/longmemeval-s-20261018` in the primary local
repository. They are not committed or hosted by this package. Remote durable
cache/storage and a CI schedule remain undecided. A clean checkout alone does
not contain the inputs required to replay this baseline.

Run from the repository root and set `ARTIFACT_DIR` to the **absolute** location
of those retained artifacts. Check hashes before use; the commands below read
the retained files without downloads or model initialization:

```sh
ARTIFACT_DIR="/absolute/path/munin-memory/benchmark/generated/evidence-metric/longmemeval-s-20261018"
BASELINE_DIR="$PWD/benchmark/evidence-metric/baselines/longmemeval-s-20261018"

python3 - "$ARTIFACT_DIR" "$BASELINE_DIR" <<'PY'
import hashlib, json, sys
from pathlib import Path
artifacts, package = map(Path, sys.argv[1:])
assert artifacts.is_absolute(), "ARTIFACT_DIR must be absolute"
provenance = json.loads((package / "provenance.json").read_text())
def verify(root, record):
    relative = Path(record["path"])
    assert not relative.is_absolute() and ".." not in relative.parts
    path = root / relative
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    assert path.stat().st_size == record["bytes"], f"Size mismatch: {path}"
    assert digest.hexdigest() == record["sha256"], f"Hash mismatch: {path}"
for record in provenance["files"].values():
    verify(artifacts, record)
verify(artifacts, provenance["source_manifest"])
verify(package, provenance["baseline"])
verify(package, provenance["upstream_model_verification"])
print("Frozen input, source manifest, baseline and receipt hashes verified")
PY

env -u MUNIN_SEMANTIC_MAX_DISTANCE npm run benchmark:evidence -- \
  --snapshot "$ARTIFACT_DIR/snapshot.db" \
  --queries "$ARTIFACT_DIR/queries.jsonl" \
  --vectors "$ARTIFACT_DIR/query-vectors.json" \
  --as-of 2026-10-01T00:00:00.000Z \
  --baseline "$BASELINE_DIR/baseline.json" \
  --output "$ARTIFACT_DIR/offline-replay.json"
```

Use a fresh report output path if retaining earlier replay reports. An unchanged
comparison exits 0; a reproduced regression exits 1; invalid input/configuration
exits 2. Input bindings and every query's packed/retrieved IDs can be compared
without running embedding inference. The evaluator validates matching corpus
provenance and rejects a snapshot requiring SQLite sidecars.

Retain these exact frozen inputs to compare against this baseline. A fresh cold
build creates new file bindings, and a different generation platform/runtime
changes the embedding identity. Such a build is a separate candidate to review;
it cannot be substituted into this baseline merely because its model name or
aggregate score matches.
