# Security waivers

## GHSA-xcpc-8h2w-3j85 (`adm-zip`)

- **Status:** Temporarily accepted for the exact production chain
  `@huggingface/transformers@4.2.0 → onnxruntime-node@1.24.3 → adm-zip@0.5.18`.
- **Expires:** 2026-10-18. CI fails after this date unless the waiver is deliberately renewed.
- **Affected operation:** `onnxruntime-node` loads `adm-zip` from its postinstall helper to extract optional native packages downloaded from the configured Microsoft NuGet feed.
- **ContextMesh exposure:** ContextMesh does not accept or extract ZIP input at runtime. The approved E5 model is an already-expanded, manifest-verified local directory, and semantic runtime sessions run with network access denied.
- **Residual risk:** A crafted archive reaching the ORT postinstall download path could exhaust memory during package installation. This is an installation/supply-chain availability risk, not a semantic-query data path.
- **Controls:** Versions and integrity are locked; production audit accepts only this exact three-package advisory chain; fresh-consumer package verification audits the installed topology; any additional advisory fails CI; actual-model smoke runs on three operating systems.
- **Removal condition:** Remove the waiver when the pinned Transformers/ORT dependency accepts `adm-zip@0.6.0` or later, or when an upstream ORT release eliminates the affected extractor.

The npm override approach is not used as the release fix because dependency-level `overrides` are not enforced when the published ContextMesh tarball is installed into another root project. The waiver therefore reflects the dependency graph that consumers actually receive.
