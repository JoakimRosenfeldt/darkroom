"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cameraProfileIsCompatible } from "@/lib/camera-profiles/matrix";
import type { CameraProfileRegistrySnapshot } from "@/lib/camera-profiles/registry";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { calculateDevelopClipboardApplication } from "@/lib/develop/clipboard/apply";
import {
  DEFAULT_DEVELOP_CLIPBOARD_GROUPS,
  DEVELOP_CLIPBOARD_GROUPS,
  parseDevelopClipboardPayload,
  type DevelopClipboardGroup,
  type DevelopClipboardPayload,
  type DevelopClipboardReadResult,
} from "@/lib/develop/clipboard/schema";
import {
  captureDevelopPresetPayload,
  countDevelopMaskTransferClasses,
  type DevelopPresetApplyReport,
  type DevelopPresetCameraProfileContext,
} from "@/lib/develop/presets/apply";
import type { DevelopPresetField } from "@/lib/develop/presets/schema";
import { sourceSignatureForEntry } from "@/lib/develop/source-transform";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import {
  IDENTITY_MATRIX_3,
  persistedInputProfileFromMatrix,
} from "@/lib/develop/v3/profiles";
import type { LibraryEntry } from "@/lib/fs/types";
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import { isPresetTransientEdit, useDevelopStore } from "@/stores/develop-store";
import { useLibraryStore } from "@/stores/library-store";
import { ActionButton } from "./V3PanelControls";

const GROUP_LABELS: Readonly<Record<DevelopClipboardGroup, string>> = {
  basic: "Basic",
  mixer: "Color mixer",
  effects: "Effects",
  "tone-curves": "Tone curves",
  "camera-profile": "Camera profile",
  crop: "Crop",
  "manual-masks": "Manual masks",
  "ai-masks": "AI masks",
  metadata: "Pick, rating, label",
};

type ClipboardState =
  | { readonly kind: "loading" }
  | DevelopClipboardReadResult;

interface CameraProfileBinding {
  readonly entryId: string;
  readonly image: DevelopImage;
  readonly resolved: boolean;
  readonly context: DevelopPresetCameraProfileContext;
}

function unavailableCameraProfile(reason: string): DevelopPresetCameraProfileContext {
  return { kind: "unavailable", reason };
}

function sameClipboardPayload(
  left: DevelopClipboardPayload,
  right: DevelopClipboardPayload,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Clipboard operation failed.";
}

function sourceSummary(
  payload: DevelopClipboardPayload,
  group: DevelopClipboardGroup,
): string {
  if (group === "metadata") {
    const metadata = payload.metadata;
    return metadata
      ? `${metadata.pick}, ${metadata.rating} stars, ${metadata.colorLabel ?? "no label"}`
      : "Unavailable";
  }
  const item = payload.payload.find((entry) => entry.field === group);
  if (!item) return "Unavailable";
  if (item.field === "manual-masks") return `${item.value.length} masks`;
  if (item.field === "ai-masks") return `${item.value.masks.length} masks`;
  if (item.field === "camera-profile") {
    return item.value.selection.kind === "selected"
      ? item.value.selection.profileId
      : item.value.selection.kind;
  }
  if (item.field === "crop") return item.value.enabled ? "Enabled crop" : "Full frame";
  if (item.field === "tone-curves") return "4 × 256 samples";
  return "Expanded values";
}

function reportReasons(report: DevelopPresetApplyReport): readonly string[] {
  return [
    ...report.unsupported.map((item) => `${GROUP_LABELS[item.field]}: ${item.reason}`),
    ...report.skipped.map((item) => `${GROUP_LABELS[item.field]}: ${item.reason}`),
    ...report.regenerationRequests.map((item) => `${GROUP_LABELS[item.field]}: ${item.reason}`),
  ];
}

function currentCommittedDocument(entryId: string): DevelopDocumentV3 | null {
  const session = useDevelopStore.getState().sessions[entryId];
  const document = session?.persistedDocument;
  return session?.processKind === "v3" && document?.version === 3 ? document : null;
}

function sameSourceRevision(payload: DevelopClipboardPayload, source: LibraryEntry): boolean {
  return source.catalogId === payload.source.catalogId &&
    source.id === payload.source.entryId &&
    source.sourceId === payload.source.sourceId &&
    source.assetId === payload.source.assetId &&
    source.assetRevision === payload.source.assetRevision &&
    source.size === payload.source.size &&
    source.lastModified === payload.source.lastModified;
}

export function DevelopClipboardControls({
  document,
  image,
  entry,
  disabled = false,
}: {
  readonly document: DevelopDocumentV3;
  readonly image: DevelopImage;
  readonly entry: LibraryEntry;
  readonly disabled?: boolean;
}) {
  const entryMetadata = useLibraryStore((state) => state.entryMetadata);
  const restoreEntryMetadata = useLibraryStore((state) => state.restoreEntryMetadata);
  const [clipboardState, setClipboardState] = useState<ClipboardState>({ kind: "loading" });
  const [preferences, setPreferences] = useState<readonly DevelopClipboardGroup[]>(
    DEFAULT_DEVELOP_CLIPBOARD_GROUPS,
  );
  const [copyGroups, setCopyGroups] = useState<readonly DevelopClipboardGroup[]>(
    DEFAULT_DEVELOP_CLIPBOARD_GROUPS,
  );
  const [pasteGroups, setPasteGroups] = useState<readonly DevelopClipboardGroup[]>([]);
  const [copyOpen, setCopyOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [requestRegeneration, setRequestRegeneration] = useState(false);
  const initialCameraProfileBinding: CameraProfileBinding = {
    entryId: entry.id,
    image,
    resolved: false,
    context: unavailableCameraProfile("Camera profile registry is loading."),
  };
  const [cameraProfileBinding, setCameraProfileBinding] = useState<CameraProfileBinding>(
    initialCameraProfileBinding,
  );
  const cameraProfileBindingRef = useRef(initialCameraProfileBinding);
  const cameraProfileRequestRef = useRef(0);
  const [lastReport, setLastReport] = useState<DevelopPresetApplyReport | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const desktopAvailable = isElectronApp();
  const cameraProfile = cameraProfileBinding.entryId === entry.id &&
      cameraProfileBinding.image === image
    ? cameraProfileBinding.context
    : unavailableCameraProfile("Camera profile compatibility is loading for this photo.");

  const publishCameraProfile = useCallback((binding: CameraProfileBinding) => {
    cameraProfileBindingRef.current = binding;
    setCameraProfileBinding(binding);
  }, []);

  const readyPayload = clipboardState.kind === "ready" ? clipboardState.payload : null;
  const plainPasteGroups = useMemo(
    () => readyPayload
      ? preferences.filter((group) => readyPayload.selectedGroups.includes(group))
      : [],
    [preferences, readyPayload],
  );

  const refreshClipboard = useCallback(async () => {
    if (!isElectronApp()) {
      setClipboardState({ kind: "invalid", reason: "Paste is available in the desktop app." });
      return;
    }
    try {
      const result = await getDarkroomAPI().developClipboardRead();
      setClipboardState(result);
      if (result.kind === "ready") {
        setPasteGroups((current) => {
          const retained = current.filter((group) => result.payload.selectedGroups.includes(group));
          return retained.length > 0
            ? retained
            : preferences.filter((group) => result.payload.selectedGroups.includes(group));
        });
      } else {
        setPasteOpen(false);
        setLastReport(null);
      }
    } catch (error) {
      setClipboardState({ kind: "invalid", reason: errorMessage(error) });
    }
  }, [preferences]);

  useEffect(() => {
    if (!isElectronApp()) return;
    let active = true;
    void Promise.all([
      getDarkroomAPI().developClipboardGroupsGet(),
      getDarkroomAPI().developClipboardRead(),
    ]).then(([groups, result]) => {
      if (!active) return;
      setPreferences(groups);
      setCopyGroups(groups);
      setClipboardState(result);
      if (result.kind === "ready") {
        setPasteGroups(groups.filter((group) => result.payload.selectedGroups.includes(group)));
      }
    }).catch((error: unknown) => {
      if (active) setClipboardState({ kind: "invalid", reason: errorMessage(error) });
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onFocus = () => void refreshClipboard();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshClipboard]);

  useEffect(() => {
    if (!isElectronApp()) return;
    const request = cameraProfileRequestRef.current + 1;
    cameraProfileRequestRef.current = request;
    let active = true;
    void getDarkroomAPI().cameraProfilesList().then((registry: CameraProfileRegistrySnapshot) => {
      if (!active || cameraProfileRequestRef.current !== request) return;
      const stage = image.pixelProvenance.cameraProfileStage;
      if (stage.kind !== "available" || stage.stage !== "before-develop-tone") {
        publishCameraProfile({
          entryId: entry.id,
          image,
          resolved: true,
          context: unavailableCameraProfile(
            stage.kind === "unavailable" ? stage.reason : "Camera profile stage is unavailable.",
          ),
        });
        return;
      }
      publishCameraProfile({
        entryId: entry.id,
        image,
        resolved: true,
        context: {
          kind: "available-before-tone",
          decoderDefault: {
            registryRevision: registry.revision,
            selection: { kind: "decoder-default" },
            calibration: {
              matrixToLinearSrgb: IDENTITY_MATRIX_3,
              channelScale: [1, 1, 1],
              exposureOffsetEv: 0,
            },
          },
          compatibleProfiles: registry.profiles.flatMap((record) =>
            record.kind === "ready" && cameraProfileIsCompatible(record.profile, stage.camera)
              ? [persistedInputProfileFromMatrix(record.profile, registry.revision)]
              : [],
          ),
        },
      });
    }).catch((error: unknown) => {
      if (active && cameraProfileRequestRef.current === request) {
        publishCameraProfile({
          entryId: entry.id,
          image,
          resolved: true,
          context: unavailableCameraProfile(errorMessage(error)),
        });
      }
    });
    return () => {
      active = false;
    };
  }, [entry.id, image, publishCameraProfile]);

  const chooserReport = (() => {
    if (!readyPayload || pasteGroups.length === 0) return null;
    try {
      const result = calculateDevelopClipboardApplication({
        document,
        clipboard: readyPayload,
        selectedGroups: pasteGroups,
        context: {
          sourceId: entry.sourceId,
          cameraProfile,
          regenerateAiMasks: requestRegeneration,
        },
      });
      return result.report;
    } catch {
      return null;
    }
  })();

  const toggleGroup = (
    groups: readonly DevelopClipboardGroup[],
    group: DevelopClipboardGroup,
  ): readonly DevelopClipboardGroup[] => groups.includes(group)
    ? groups.filter((candidate) => candidate !== group)
    : DEVELOP_CLIPBOARD_GROUPS.filter((candidate) =>
        candidate === group || groups.includes(candidate),
      );

  const copy = async () => {
    if (!isElectronApp() || copyGroups.length === 0) return;
    const committed = currentCommittedDocument(entry.id);
    if (!committed) {
      setMessage("Copy requires an editable Develop document.");
      return;
    }
    setBusy(true);
    try {
      const maskCounts = countDevelopMaskTransferClasses(committed);
      const omittedMaskGroups = new Set<DevelopClipboardGroup>();
      if (copyGroups.includes("manual-masks") && maskCounts.manual === 0) {
        omittedMaskGroups.add("manual-masks");
      }
      if (copyGroups.includes("ai-masks") && maskCounts.ai === 0) {
        omittedMaskGroups.add("ai-masks");
      }
      const transferredGroups = copyGroups.filter((group) => !omittedMaskGroups.has(group));
      if (transferredGroups.length === 0) {
        setMessage("The selected groups contain no transferable settings.");
        return;
      }
      const fields = transferredGroups.filter(
        (group): group is DevelopPresetField => group !== "metadata",
      );
      const payload = captureDevelopPresetPayload(committed, fields, entry.sourceId);
      const sourceMetadata = getEntryMetadata(entryMetadata, entry.id);
      const value = parseDevelopClipboardPayload({
        schemaVersion: 1,
        source: {
          catalogId: entry.catalogId,
          entryId: entry.id,
          sourceId: entry.sourceId,
          assetId: entry.assetId,
          assetRevision: entry.assetRevision,
          size: entry.size,
          lastModified: entry.lastModified,
        },
        document: { process: "darkroom-v3", schemaRevision: committed.schemaRevision },
        createdAt: Date.now(),
        selectedGroups: transferredGroups,
        payload,
        assetRefs: payload.flatMap((item) => item.field === "ai-masks" ? item.value.assetRefs : []),
        metadata: transferredGroups.includes("metadata")
          ? {
              pick: sourceMetadata.pick,
              rating: sourceMetadata.rating,
              colorLabel: sourceMetadata.colorLabel,
            }
          : null,
      });
      await getDarkroomAPI().developClipboardWrite(value);
      await getDarkroomAPI().developClipboardGroupsSet(copyGroups);
      setPreferences(copyGroups);
      setClipboardState({ kind: "ready", payload: value });
      setPasteGroups(transferredGroups);
      setCopyOpen(false);
      const skipped = [
        ...[...omittedMaskGroups].map((group) => `${GROUP_LABELS[group]} had no transferable masks`),
        ...(maskCounts["source-specific"] > 0 &&
            (copyGroups.includes("manual-masks") || copyGroups.includes("ai-masks"))
          ? [`${maskCounts["source-specific"]} mixed or depth masks are source-specific`]
          : []),
      ];
      setMessage(
        `Copied ${transferredGroups.map((group) => GROUP_LABELS[group]).join(", ")}.` +
        (skipped.length > 0 ? ` Skipped: ${skipped.join("; ")}.` : ""),
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const verifySourceAndAssets = async (
    payload: DevelopClipboardPayload,
    groups: readonly DevelopClipboardGroup[],
  ): Promise<void> => {
    const source = useLibraryStore.getState().entries.find((candidate) =>
      candidate.catalogId === payload.source.catalogId &&
      candidate.id === payload.source.entryId,
    );
    if (!source || !sameSourceRevision(payload, source) || source.health !== "present") {
      throw new Error("Clipboard source changed or is no longer available.");
    }
    if (!groups.includes("ai-masks")) return;
    if (!isElectronApp()) throw new Error("AI mask assets require the desktop app.");
    const sourceSignature = sourceSignatureForEntry(source);
    if (sourceSignature.catalogId === undefined || sourceSignature.assetRevision === undefined) {
      throw new Error("Clipboard source signature is incomplete.");
    }
    for (const reference of payload.assetRefs) {
      const result = await getDarkroomAPI().developAssetRead({
        reference,
        sourceSignature: {
          ...sourceSignature,
          catalogId: sourceSignature.catalogId,
          assetRevision: sourceSignature.assetRevision,
        },
      });
      if (result.kind !== "ready") {
        throw new Error(`Clipboard asset ${reference.assetId.slice(0, 12)} is ${result.kind}.`);
      }
    }
  };

  const paste = async (
    groups: readonly DevelopClipboardGroup[],
    regenerateAiMasks: boolean,
    persistGroups: boolean,
  ) => {
    if (!readyPayload || groups.length === 0) return;
    const clipboardBefore = readyPayload;
    const sessionBefore = useDevelopStore.getState().sessions[entry.id];
    const revisionBefore = sessionBefore?.documentRevision;
    const metadataRevisionBefore = sessionBefore?.metadataRevision;
    const targetMetadataBefore = getEntryMetadata(
      useLibraryStore.getState().entryMetadata,
      entry.id,
    );
    const committed = currentCommittedDocument(entry.id);
    if (
      !committed ||
      sessionBefore?.processKind !== "v3" ||
      revisionBefore === undefined ||
      metadataRevisionBefore === undefined
    ) {
      setMessage("Paste requires an editable Develop document.");
      return;
    }
    setBusy(true);
    try {
      const clipboardNow = await getDarkroomAPI().developClipboardRead();
      setClipboardState(clipboardNow);
      if (
        clipboardNow.kind !== "ready" ||
        !sameClipboardPayload(clipboardBefore, clipboardNow.payload)
      ) {
        throw new Error("Clipboard changed while preparing the paste. Review it and try again.");
      }
      if (persistGroups) {
        await getDarkroomAPI().developClipboardGroupsSet(groups);
        setPreferences(groups);
      }
      await verifySourceAndAssets(clipboardNow.payload, groups);
      const developState = useDevelopStore.getState();
      const latestEntry = useLibraryStore.getState().entries.find(
        (candidate) => candidate.catalogId === entry.catalogId && candidate.id === entry.id,
      );
      const latestSession = developState.sessions[entry.id];
      const latestCameraProfile = cameraProfileBindingRef.current;
      if (
        developState.activeCatalogId !== entry.catalogId ||
        developState.activeEntryId !== entry.id ||
        !latestEntry ||
        latestEntry.assetRevision !== entry.assetRevision ||
        latestEntry.size !== entry.size ||
        latestEntry.lastModified !== entry.lastModified ||
        isPresetTransientEdit(latestSession?.transientEdit) ||
        latestSession?.documentRevision !== revisionBefore ||
        latestSession?.metadataRevision !== metadataRevisionBefore ||
        getEntryMetadata(
          useLibraryStore.getState().entryMetadata,
          entry.id,
        ).updatedAt !== targetMetadataBefore.updatedAt
      ) {
        throw new Error("Target changed while validating clipboard settings.");
      }
      if (
        groups.includes("camera-profile") &&
        (latestCameraProfile.entryId !== entry.id ||
          latestCameraProfile.image !== image ||
          !latestCameraProfile.resolved)
      ) {
        throw new Error("Camera profile compatibility changed while preparing the paste.");
      }
      const latestDocument = currentCommittedDocument(entry.id);
      if (!latestDocument) throw new Error("Target Develop document is unavailable.");
      const result = calculateDevelopClipboardApplication({
        document: latestDocument,
        clipboard: clipboardNow.payload,
        selectedGroups: groups,
        context: {
          sourceId: entry.sourceId,
          cameraProfile: latestCameraProfile.context,
          regenerateAiMasks,
        },
      });
      const metadataAfter = result.appliedMetadata && clipboardNow.payload.metadata
        ? clipboardNow.payload.metadata
        : targetMetadataBefore;
      const commit = useDevelopStore.getState().commitV3CompleteStateWithMetadata(
          entry.catalogId,
          entry.id,
          result.document,
          targetMetadataBefore,
          metadataAfter,
          "Paste Develop settings",
        );
      if (commit.metadataChanged) {
        restoreEntryMetadata(entry.id, metadataAfter);
      }
      setLastReport(result.report);
      const applied = [
        ...(commit.documentChanged
          ? result.report.included.map((field) => GROUP_LABELS[field])
          : []),
        ...(commit.metadataChanged ? [GROUP_LABELS.metadata] : []),
      ];
      setMessage(applied.length > 0
        ? `Applied: ${applied.join(", ")}.`
        : "No compatible settings were applied.");
      setPasteOpen(false);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const pasteReason = !desktopAvailable
    ? "Paste is available in the desktop app."
    : clipboardState.kind === "loading"
    ? "Reading clipboard…"
    : clipboardState.kind === "empty"
      ? "Clipboard is empty."
      : clipboardState.kind === "invalid"
        ? clipboardState.reason
        : plainPasteGroups.length === 0
          ? "Clipboard has none of the saved Paste groups."
          : null;

  return (
    <section className="border-b border-lr-border-subtle px-3 py-2.5">
      <div className="flex flex-wrap gap-1.5" aria-label="Develop settings clipboard">
        <ActionButton onClick={() => setCopyOpen((open) => !open)} pressed={copyOpen} disabled={disabled || !desktopAvailable}>Copy</ActionButton>
        <ActionButton
          onClick={() => void paste(plainPasteGroups, false, false)}
          disabled={disabled || busy || pasteReason !== null}
          title={pasteReason ?? undefined}
        >
          Paste
        </ActionButton>
        <ActionButton
          onClick={() => {
            void refreshClipboard();
            setPasteOpen((open) => !open);
          }}
          pressed={pasteOpen}
          disabled={disabled || busy || !desktopAvailable || clipboardState.kind !== "ready"}
          title={clipboardState.kind === "invalid" ? clipboardState.reason : undefined}
        >
          Paste settings
        </ActionButton>
      </div>
      {disabled ? <p className="mt-1.5 text-[9px] leading-3 text-lr-text-faint">Clipboard edits pause during preset Preview or Amount.</p> : null}
      {!desktopAvailable ? <p className="mt-1.5 text-[9px] leading-3 text-lr-text-faint">Develop clipboard requires the desktop app.</p> : null}
      {pasteReason ? <p className="mt-1.5 text-[9px] leading-3 text-lr-text-faint">Paste unavailable: {pasteReason}</p> : null}

      {copyOpen ? (
        <div className="mt-2.5 border-t border-lr-border-subtle pt-2.5">
          <p className="text-[10px] font-medium text-lr-text">Copy groups</p>
          <GroupChooser
            available={DEVELOP_CLIPBOARD_GROUPS}
            selected={copyGroups}
            onToggle={(group) => setCopyGroups(toggleGroup(copyGroups, group))}
          />
          <div className="mt-2 flex gap-1.5">
            <ActionButton onClick={() => void copy()} disabled={busy || copyGroups.length === 0}>Copy selected</ActionButton>
            <ActionButton onClick={() => setCopyOpen(false)}>Cancel</ActionButton>
          </div>
        </div>
      ) : null}

      {pasteOpen && readyPayload ? (
        <div className="mt-2.5 border-t border-lr-border-subtle pt-2.5">
          <div className="flex items-baseline gap-2">
            <p className="text-[10px] font-medium text-lr-text">Paste settings</p>
            <p className="ml-auto text-[9px] text-lr-text-faint">{new Date(readyPayload.createdAt).toLocaleString()}</p>
          </div>
          <div className="mt-2 space-y-1">
            {readyPayload.selectedGroups.map((group) => (
              <label key={group} className="grid grid-cols-[14px_1fr_auto] items-start gap-1.5 rounded px-1 py-1 hover:bg-lr-panel-raised/60">
                <input
                  type="checkbox"
                  checked={pasteGroups.includes(group)}
                  onChange={() => setPasteGroups(toggleGroup(pasteGroups, group))}
                  className="mt-0.5 size-3 accent-lr-accent"
                />
                <span className="text-[10px] text-lr-text-muted">{GROUP_LABELS[group]}</span>
                <span className="max-w-[126px] truncate text-right text-[9px] text-lr-text-faint">{sourceSummary(readyPayload, group)}</span>
              </label>
            ))}
          </div>
          {readyPayload.selectedGroups.includes("ai-masks") && readyPayload.source.sourceId !== entry.sourceId ? (
            <label className="mt-2 flex items-start gap-2 text-[10px] leading-4 text-lr-text-muted">
              <input
                type="checkbox"
                checked={requestRegeneration}
                onChange={(event) => setRequestRegeneration(event.target.checked)}
                className="mt-0.5 size-3 accent-lr-accent"
              />
              <span>Request AI regeneration. Regeneration is unavailable, so AI masks stay skipped.</span>
            </label>
          ) : null}
          {chooserReport ? (
            <div className="mt-2 text-[9px] leading-4 text-lr-text-faint">
              <p>Will apply: {chooserReport.included.length ? chooserReport.included.map((field) => GROUP_LABELS[field]).join(", ") : "no Develop groups"}</p>
              {reportReasons(chooserReport).map((reason) => <p key={reason} className="text-lr-accent">{reason}</p>)}
            </div>
          ) : null}
          <div className="mt-2 flex gap-1.5">
            <ActionButton onClick={() => void paste(pasteGroups, requestRegeneration, true)} disabled={busy || pasteGroups.length === 0}>Apply</ActionButton>
            <ActionButton onClick={() => setPasteOpen(false)}>Cancel</ActionButton>
          </div>
        </div>
      ) : null}
      {message ? <p role="status" className="mt-2 text-[10px] leading-4 text-lr-accent">{message}</p> : null}
      {lastReport && reportReasons(lastReport).length > 0 ? (
        <div className="mt-1 text-[9px] leading-4 text-lr-text-faint">
          <p>Skipped:</p>
          {reportReasons(lastReport).map((reason) => <p key={reason}>{reason}</p>)}
        </div>
      ) : null}
    </section>
  );
}

function GroupChooser({
  available,
  selected,
  onToggle,
}: {
  readonly available: readonly DevelopClipboardGroup[];
  readonly selected: readonly DevelopClipboardGroup[];
  readonly onToggle: (group: DevelopClipboardGroup) => void;
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1">
      {available.map((group) => (
        <label key={group} className="flex items-center gap-1.5 text-[10px] text-lr-text-muted">
          <input
            type="checkbox"
            checked={selected.includes(group)}
            onChange={() => onToggle(group)}
            className="size-3 accent-lr-accent"
          />
          {GROUP_LABELS[group]}
        </label>
      ))}
    </div>
  );
}
