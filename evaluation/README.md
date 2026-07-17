# Phase 4 retrieval evaluation

`acceptance-v1.json` is the immutable Phase 4 acceptance set. Its corpus, labels, grades, and source spans must not be changed while implementing or tuning Phase 4. Corrections require a new versioned fixture and an explicit review.

`development-v1.json` reuses the acceptance corpus but contains separate queries that may be used for RRF/MMR and text-builder tuning.

Run the lexical baseline or a later semantic evaluation with:

```shell
npm run evaluate:quality -- --fixture acceptance-v1
npm run evaluate:quality -- --fixture development-v1
```

The evaluator reports macro-gated and micro diagnostic Recall, MRR, nDCG, context evidence coverage, token usage, near-duplicate waste, determinism, environment metadata, and warm latency. Binary relevance for Recall and MRR is grade 2 or 3; nDCG uses `2^grade - 1`. Acceptance labels are evaluated only in a ready semantic state; disabled, partial, and unavailable behavior is covered separately by integration tests.
