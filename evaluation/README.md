# Phase 4 retrieval evaluation

`acceptance-v2.json` is the immutable Phase 4 release set. Its corpus, labels, grades, `gateGroup` values, and source spans must not be changed while implementing or tuning Phase 4. Corrections require a new versioned fixture and explicit review. Version 1 remains only as historical evidence.

`development-v2.json` contains the corresponding non-blocking tuning queries. It may be used for RRF/MMR and text-builder work without changing the acceptance set.

Run the lexical baseline or a later semantic evaluation with:

```shell
npm run evaluate:quality -- --fixture acceptance-v2
npm run evaluate:quality -- --fixture development-v2
npm run evaluate:quality -- --fixture acceptance-v2 --semantic-model C:/models/multilingual-e5-small
```

The evaluator reports macro-gated and micro diagnostic Recall, MRR, nDCG, context evidence coverage, token usage, near-duplicate waste, 20-run determinism, environment metadata, and warm latency. Binary relevance for Recall and MRR is grade 2 or 3; nDCG uses `2^grade - 1`. Challenge Recall must be at least `max(0.80, baseline+0.15)` when the baseline is below 0.75, otherwise 0.90. Required nDCG is `min(1.0, baseline+0.08)`. Code and memory non-challenge Recall, MRR, and nDCG must each remain at or above the lexical baseline. Context evidence coverage@2000 targets 0.80 with an explicit 0.025 absolute boundary tolerance for approved ONNX CPU-profile variation, and must still improve by 0.10; inactive, expired, superseded, or forgotten memory must never be returned; duplicate waste must be at most 10% and, when the baseline is at least 1%, fall by at least 30%. Determinism signatures cover pagination/truncation, every public score, direct/anchor/search source state, and context relationships in addition to ordered IDs.

`phase3-lexical-v2.json` records the Phase 3 source commit separately from the v2 evaluator and immutable fixture commits. Fixture SHA uses UTF-8 bytes after CRLF/CR-to-LF normalization so Windows and Unix checkouts agree. `baselineDigest` is SHA-256 over canonical UTF-8 JSON with the `baselineDigest` property omitted; keys are serialized directly in UTF-16 code-unit order. The artifact has no BOM and ends with exactly one LF (the digest payload itself has no LF). `SOURCE_DATE_EPOCH` fixes artifact time. Once acceptance-v2 is fixed, the baseline is not overwritten except for an explicitly reviewed provenance-format correction.

## v0.5.1 external-source holdout

`v051-external-holdout-v2.json` pins byte-identical source slices and licenses from three public release commits: Nx 23.1.0 (large TypeScript monorepo), Flask 3.1.3 (Python `src` layout), and Kubernetes client-go v0.36.2 (Go generated code). Minimal project-discovery files and one external Go interface stub are separately identified as harness files. Every upstream and harness byte has a SHA-256 digest, and changing a repository, file, case, threshold, or expected path requires a new fixture identity. Version 2 corrects two Flask labels from unresolved to their statically determined same-class and explicit-import targets; version 1 is retained only in Git history as rejected review evidence.

The 23 gold cases use exact source and target declaration start lines as well as qualified names, so repeated generated Go method names cannot match the wrong declaration. They do not claim complete byte-span or call-site-span validation. Each Tier 1 language includes positive and explicit unresolved cases, including a Python function containing both a statically bound receiver call and a genuinely dynamic loader call. This is an external-source, offline-replayable holdout for the selected call paths; it does not claim complete provider coverage across the full upstream repositories or independent third-party annotation.

Run and verify the source-bound artifact with:

```shell
npm run evaluate:v051-holdout -- --output artifacts/v051-external-holdout.json
npm run verify:v051-holdout
```

The hardening gate requires resolved-edge precision of at least 0.90, resolved-edge recall of at least 0.80, complete case classification, exact declaration-line paths, healthy or explicitly partial Tier 1 providers, and one identical normalized semantic graph/case/provider fingerprint across 20 fresh Node processes with independent applications, databases, and materialized workspaces. The signature includes full declaration spans, edge and unresolved evidence, case outcomes, provider states, and candidate order; it intentionally excludes workspace-scoped IDs and revision counters. Provider-reported whole-corpus coverage remains visible in the artifact and is not relabeled as holdout recall. The `v0.5.1` label names this hardening gate for the 0.5.0 package line and does not claim that the npm package version has changed.
