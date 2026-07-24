# CI execution policy

ContextMesh keeps remote backups frequent while separating development feedback
from release evidence.

## Automatic development checks

`Fast CI` runs once for pull requests targeting `main` and again after changes
land on `main`. Feature-branch pushes do not trigger a second copy of the same
workflow.

The Ubuntu job runs:

- `npm ci`
- Go provider tests
- TypeScript typecheck and lint
- native debug build
- the non-artifact source test suite

Before pushing, run `npm run check:source` locally. Use focused tests for small
changes and `npm run check` for migration, native, provider, or storage changes.

Fast CI does not generate v0.7 release evidence. The manual/reusable Full CI
runs `evaluate:v07`, verifies the canonical 20-run artifact, and uploads
`artifacts/v07-memory-validation.json` after the source has been frozen.

## Stage-boundary checks

`Full CI` is manual and reusable. Run it at the v0.7 and v0.8 boundaries and
before v1.0 release candidates. It retains the three-OS matrix, real-model
smoke, acceptance parity, package and audit checks, checked release artifacts,
and clean source ZIP gate.

The legacy v0.6 three-OS source gate remains available as a manual workflow for
baseline diagnosis, but it no longer runs on every pull-request update.

## Release checks

Tags matching `v1.0.0-rc.*` or `v1.0.0` invoke the reusable full gate through
`Release candidate full gate`. Extend this workflow with the final v1.0
long-term migration, backup/restore, and recovery contracts before declaring
the release complete.

Do not weaken artifact freshness or security verifiers to make a stage pass.
Regenerate commit-bound release evidence once the stage source commit is
frozen.
