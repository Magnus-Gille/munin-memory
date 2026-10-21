# Paired context-packing answer quality

This lane evaluates the frozen #341 baseline and the unchanged #392 core-first
packing rule on the same retrieved entries at 8,192 estimated tokens. It does
not change `memory_query`, the runtime default, the frozen baseline, or the
existing primary reader/judge prompts.

`prepareQualityManifest` validates the detached public snapshot, frozen query
vectors, source manifest, message boundaries and their explicit SHA256 pins.
It reproduces the retained retrieval/control/core report before emitting the
two contexts per question. Expected answer labels are never selector input.
The contexts and model-call ledger belong in an ignored output directory.

`runPairedQuality` receives an explicit injected transport. It can run readers
first and judges second, or inspect an existing run without dispatching calls.
Query-ID order is stable and baseline/core ordering alternates. Every attempt
is flushed as pending before dispatch. A completed call is reused only under
identical input, source and model-profile bindings. Pending, unknown, invalid
or malformed attempts block replay; interrupted work requires reconciliation.
There are no automatic retries or silent model fallbacks.

Paid mode requires pinned prices and reserves a conservative per-request bound
before dispatch under a total cap. Actual charges are reconciled afterward;
unknown charges prevent further calls. Local mode explicitly records the
self-hosted no-paid-API assumption and null dollar cost, not a fabricated
provider receipt. Model aliases do not establish immutable weight revisions.

Calibration reuses public July reader answers, keeps prior verdicts out of
model prompts, and reports agreement with the recorded judge rather than
claiming human truth. Preferences are reported separately, with a frozen
preference-aware sensitivity rubric. The original rubric remains unchanged.

The protocol is fixed in
`protocols/longmemeval-s-closeout-20261021.json`. Its 500 questions were already
used for packing development: paired answer results are development-set
evidence, not held-out generalization. Failed adoption criteria retain the
experimental policy; no score alone authorizes runtime adoption.

Tests use injected fake transports and synthetic databases. Ordinary CI must
never invoke a model, use a credential, update the baseline, or accept an
incomplete run as a successful quality comparison. Live model runs require an
explicit authorized evaluation and the same pinned inputs and profile.
