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

## GHSA-f88m-g3jw-g9cj (`sharp`)

- **Status:** Temporarily accepted for the exact production chain
  `contextmesh → @huggingface/transformers@4.2.0 → sharp@0.34.5`.
- **Expires:** 2026-08-31. CI fails after this date unless the waiver is deliberately renewed.
- **Affected operation:** Decoding untrusted GIF, TIFF, VIPS, or other image input through the vulnerable bundled libvips operations in `sharp` before 0.35.0.
- **ContextMesh exposure:** Transformers.js may load `sharp` in its Node bundle. ContextMesh provides only the `feature-extraction` text embedding pipeline and has no image, audio, multimodal, arbitrary binary, `Buffer`, file, or URL media-input API. The untrusted-image precondition is therefore not reachable through the current product surface.
- **Residual risk:** A future media or multimodal input path could make the vulnerable decoder reachable. Loading the module alone is not treated as absence of exposure.
- **Controls:** Text embedding only; image, audio, and multimodal pipelines are prohibited; adding any media input invalidates this waiver immediately; production audit accepts only this exact advisory and dependency path; fresh-consumer package verification audits the installed topology; severity remains high and the waiver is printed in CI.
- **Removal condition:** Remove the waiver as soon as a supported Transformers.js release accepts `sharp@0.35.0` or later, or replace the dependency before adding any media-processing feature.
