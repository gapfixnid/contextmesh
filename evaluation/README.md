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
