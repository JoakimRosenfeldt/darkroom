# Masks and prototype AI architecture

## Problem

Darkroom already has a global `DevelopDocumentV3`, a shared preview and export runtime, a content-addressed asset store, and strict v2 compatibility. Masking still uses the flat v2 component list. AI selection jobs live in React state, accept artifacts before the document edit is durable, and disappear on navigation. The new work must extend the existing v3 document, keep old reads exact, and make invented capabilities unmistakably provisional.

## Usage

The masking UI edits one complete mask program through ordinary Develop commands:

```ts
dispatchV3({
  kind: "replace-v3-semantic-group",
  group: "local",
  value: replaceMaskExpression(document.local, maskId, expression),
}, "Intersect mask sources");
```

Preview, overlay, histogram, and export ask the same evaluator for coverage:

```ts
const result = evaluateMask({
  expression: mask.expression,
  point,
  analysis,
  artifacts,
});
```

The renderer starts durable work through one capability API. It does not coordinate staging, publication, document acceptance, or recovery:

```ts
const job = await window.darkroom.developJobs.start({
  kind: "source-operation",
  operation: "denoise",
  implementation: "builtin-prototype-denoise-v1",
  entry,
  documentRevision,
  amount: 45,
});

await window.darkroom.developJobs.accept({
  jobId: job.id,
  expectedDocumentRevision: documentRevision,
});
```

Generative Remove uses the same API, but the main process validates a consent receipt before it runs the configured mock provider:

```ts
await window.darkroom.developJobs.start({
  kind: "generative-remove",
  implementation: "local-mock-remove-v1",
  entry,
  documentRevision,
  selection,
  consent,
});
```

## Shape

### One v3 document

`DevelopDocumentV3` remains the only editable v3 document. Schema revision 2 adds required source processing, mask programs, cleanup artifact references, and prototype provenance. The decoder accepts frozen v2, `darkroom-v3-document-1`, and `darkroom-v3-document-2`. It always returns the complete revision-2 in-memory shape.

```ts
type MaskExpression =
  | {
      readonly kind: "source";
      readonly id: MaskNodeId;
      readonly enabled: boolean;
      readonly source: MaskSource;
    }
  | {
      readonly kind: "combine";
      readonly id: MaskNodeId;
      readonly enabled: boolean;
      readonly operation: "add" | "subtract" | "intersect";
      readonly left: MaskExpression;
      readonly right: MaskExpression;
    }
  | {
      readonly kind: "invert";
      readonly id: MaskNodeId;
      readonly enabled: boolean;
      readonly child: MaskExpression;
    };

type MaskSource =
  | BrushMaskSource
  | LinearGradientMaskSource
  | RadialGradientMaskSource
  | LuminanceRangeMaskSource
  | ColorRangeMaskSource
  | DepthRangeMaskSource
  | AiSelectionMaskSource;

interface LocalMaskV3 {
  readonly id: MaskId;
  readonly name: string;
  readonly enabled: boolean;
  readonly expression: MaskExpression;
  readonly adjustments: LocalAdjustmentValues;
}

interface SourceProcessingV1 {
  readonly activeVariant: SourceVariantRef | null;
}
```

The schema stores no alternate flat representation. The migration left-folds v2 and schema-1 components with exact legacy add and subtract math, then wraps the root in one invert node when needed.

### One mask evaluator

`lib/develop/v3/masking.ts` owns parsing, canonicalization, admission, expression traversal, analytic source coverage, raster source coverage, and diagnostics. Callers supply pixels and artifact readers. They do not reimplement operators, staleness, or coordinate rules.

```ts
function parseMaskExpression(value: unknown): MaskExpression;
function migrateLegacyMask(mask: LocalMask): LocalMaskV3;
function admitMaskExpression(input: MaskAdmissionInput): MaskAdmissionResult;
function evaluateMask(input: MaskEvaluationInput): MaskEvaluationResult;
function referencedMaskArtifacts(expression: MaskExpression): readonly DevelopAssetRef[];
```

The evaluator uses `mask-analysis-v1`, source-normalized coordinates, linear luminance, and OKLab D65 color distance. Auto Mask uses a deterministic luminance and chroma edge weight. Depth uses a versioned prototype map. Prototype algorithms never replace production capabilities silently.

### One local adjustment registry

`lib/develop/v3/local-adjustments.ts` owns defaults, bounds, UI groups, serialized validation, evaluator order, and capability labels for Basic, Texture, Clarity, Sharpness, Noise, Moire, Defringe, and Colorize.

```ts
interface LocalAdjustmentValues {
  readonly basic: BasicSettings;
  readonly texture: number;
  readonly clarity: number;
  readonly sharpness: number;
  readonly noise: number;
  readonly moire: number;
  readonly defringe: number;
  readonly colorize: {
    readonly color: readonly [number, number, number];
    readonly amount: number;
  };
}

function parseLocalAdjustmentValues(value: unknown): LocalAdjustmentValues;
function localAdjustmentDefinitions(): readonly LocalAdjustmentDefinition[];
function accumulateLocalAdjustments(input: LocalAccumulationInput): LocalAdjustmentFields;
```

The CPU backend accumulates coverage-weighted fields, clamps once, then applies the fixed registry order. The GPU backend reports the existing unsupported state until it can run the same kernels. It does not substitute different math.

### One durable job boundary

`electron/develop-job-runtime.ts` owns job journals, processors, cancellation, staging, consent checks, acceptance receipts, and startup reconciliation. `electron/preload.ts` exposes only parsed requests and snapshots. Feature processors are private handlers behind this boundary.

```ts
interface DevelopJobApi {
  readonly list: () => Promise<readonly DevelopJobSnapshot[]>;
  readonly start: (request: DevelopJobRequest) => Promise<DevelopJobSnapshot>;
  readonly cancel: (jobId: DevelopJobId) => Promise<DevelopJobSnapshot>;
  readonly retry: (jobId: DevelopJobId) => Promise<DevelopJobSnapshot>;
  readonly discard: (jobId: DevelopJobId) => Promise<DevelopJobSnapshot>;
  readonly accept: (request: DevelopJobAcceptRequest) => Promise<DevelopJobSnapshot>;
  readonly subscribe: (listener: DevelopJobListener) => () => void;
}
```

Every processor receives validated immutable intent and returns staged bytes plus metadata. Only `accept` may connect an artifact to a Develop document. Acceptance records intent, publishes verified content-addressed bytes, commits the expected document revision, then records success. Reconciliation can replay every step without changing the outcome.

### Honest prototype processors

The invented implementations are deterministic and versioned:

- Depth uses luminance, local edge magnitude, and vertical position to create a normalized Float32 depth map.
- Denoise uses an edge-preserving bilateral filter.
- Raw Details uses a fixed-radius high-pass blend.
- Super Resolution uses 2x bicubic scaling followed by restrained fixed sharpening.
- Generative Remove uses a seeded surrounding-pixel fill in the main process and can return two deterministic alternatives.

Documents and job snapshots record `implementation: "prototype"`, an algorithm ID, revision, parameter hash, source revision, and frame revision. UI labels read "Prototype" or "Mock prototype". Generative Remove consent says no image leaves the computer. A future remote adapter must use a different provider ID and consent disclosure.

### Library and export

`stores/develop-job-store.ts` is a transient read model hydrated from the main-process journal. It survives component navigation because the journal remains authoritative. `components/develop/DevelopJobDrawer.tsx` shows stage, cancel, retry, review, accept, discard, and stale reasons. `components/library/PhotoTile.tsx` derives one accessible status badge per entry.

`lib/export/runner.ts` runs preflight before decode. Missing or stale required artifacts block export. Accepted prototype output requires an explicit warning acknowledgement in the export dialog. Preview and export still call the same v3 runtime.

Backup includes the artifact manifest, referenced object bytes, active acceptance receipts, and job journal. Relink accepts matching hash and metadata only. Garbage collection retains current, history, staged, recovery, and backup roots until its grace period expires.

## Module map

| Owner | Files |
| --- | --- |
| Document shape and migration | `lib/develop/v3/document.ts`, `codec.ts`, `migration.ts` |
| Mask program and coverage | new `lib/develop/v3/masking.ts`, `manual-edits.ts`, `cpu-backend.ts` |
| Local fields | new `lib/develop/v3/local-adjustments.ts`, `compiler.ts`, `cpu-backend.ts` |
| Artifact kinds and retention | `lib/develop/v3/assets.ts`, `asset-store.ts`, `electron/develop-asset-store.ts` |
| Jobs and processors | new `lib/develop/v3/jobs.ts`, new `electron/develop-job-runtime.ts` |
| Provider boundary | new `electron/generative-remove-service.ts` |
| IPC | `electron/main.ts`, `preload.ts`, `types/electron.d.ts` |
| UI read model | new `stores/develop-job-store.ts` |
| Develop UI | new `components/develop/MaskingPanel.tsx`, new `PrototypeOperations.tsx`, new `DevelopJobDrawer.tsx` |
| Library and export | `components/library/PhotoTile.tsx`, `app/page.tsx`, `components/export/ExportDialog.tsx`, `lib/export/runner.ts` |
| Backup and collection | `electron/catalog-admin-service.ts`, `electron/develop-asset-store.ts` |

## Synthesis decision

Candidate A is the base because its small main-process workspace hides acceptance and recovery from the renderer. Candidate B contributed feature-owned private processors, the explicit recursive expression variants, content-addressed document-last acceptance, and a consented mock provider. Both candidates proposed optional document fields. That was rejected because it would spread schema compatibility checks into every caller. Revision-2 decoding produces one complete in-memory document instead.

The arena judge also required current repository paths, one shared evaluator, backup and collection roots, and explicit consent persistence. Those requirements are part of this design.

## Tradeoffs accepted

- We accept CPU prototype latency in exchange for deterministic offline behavior with no new model downloads.
- We accept a schema revision migration in exchange for one required in-memory document shape.
- We accept document-last recoverable acceptance in exchange for avoiding a false claim of cross-filesystem atomicity.
- We accept a mock local remove provider in exchange for proving consent, staging, alternatives, cancellation wording, recovery, and offline rendering.
- We accept a visible GPU unsupported state for new local kernels until the GPU can run identical math.

## Alternatives considered

A second masking-specific v3 document lost because it would split identity, XMP, history, and render ownership. Keeping optional new fields on schema revision 1 lost because every caller would need migration policy. A large renderer-owned job manager lost because it would expose filesystem, provider, and recovery sequencing to UI code. Feature-specific public IPC lost because it would duplicate journal and acceptance rules.

## Open questions and risks

- Do the prototype algorithms meet useful quality thresholds on the bundled demo set?
- Does artifact-aware catalog backup need a format revision before release?
- Can the current v3 CPU runtime keep 2x prototype output inside the measured memory limit?
- Which future production provider and model IDs will replace the prototype IDs without reinterpreting accepted output?

## Implementation commits

1. Add schema revision 2, canonical mask expressions, ranges, Auto Mask, and local adjustment registry.
2. Add durable job contracts, artifact kinds, prototype processors, consent, and recoverable acceptance.
3. Add masking tree, prototype operation panels, Library badges, global drawer, and export preflight.
4. Add artifact-aware backup, relink, collection, accessibility fixes, and packaged Electron evidence.

## Next implementation step

Implement schema revision 2 and its schema-1 and v2 migrations before changing any renderer or UI caller.
