"use client";

import { useEffect, useMemo, useState } from "react";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  cameraProfileIsCompatible,
} from "@/lib/camera-profiles/matrix";
import type {
  CameraProfileImportResult,
  CameraProfileRegistrySnapshot,
  ReadyCameraProfileRecord,
} from "@/lib/camera-profiles/registry";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import {
  IDENTITY_MATRIX_3,
  persistedInputProfileFromMatrix,
} from "@/lib/develop/v3/profiles";
import type { LibraryEntry } from "@/lib/fs/types";
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import { useDevelopStore } from "@/stores/develop-store";
import { ActionButton, StatusCard } from "./V3PanelControls";

interface CameraProfileControlsProps {
  readonly document: DevelopDocumentV3;
  readonly image: DevelopImage;
  readonly entry: LibraryEntry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Camera profile operation failed.";
}

function sameCamera(left: ReadyCameraProfileRecord, right: ReadyCameraProfileRecord): boolean {
  return left.profile.kind === right.profile.kind &&
    left.profile.compatibility.make.trim().toLocaleLowerCase() ===
      right.profile.compatibility.make.trim().toLocaleLowerCase() &&
    left.profile.compatibility.model.trim().toLocaleLowerCase() ===
      right.profile.compatibility.model.trim().toLocaleLowerCase();
}

function resultMessage(result: CameraProfileImportResult): string {
  switch (result.kind) {
    case "cancelled": return "Import cancelled.";
    case "duplicate": return `${result.record.profile.label} is already installed.`;
    case "imported": return `${result.record.profile.label} imported.`;
    case "conflict": return `${result.incoming.profile.label} has the same profile ID as an installed file.`;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

export function CameraProfileControls({
  document,
  image,
  entry,
}: CameraProfileControlsProps) {
  const commitCompleteState = useDevelopStore((state) => state.commitV3CompleteState);
  const [registry, setRegistry] = useState<CameraProfileRegistrySnapshot | null>(null);
  const [conflict, setConflict] = useState<Extract<CameraProfileImportResult, { kind: "conflict" }> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const profileStage = image.pixelProvenance.cameraProfileStage;
  const ready = useMemo(
    () => registry?.profiles.filter(
      (record): record is ReadyCameraProfileRecord => record.kind === "ready",
    ) ?? [],
    [registry],
  );

  useEffect(() => {
    if (!isElectronApp()) return;
    let active = true;
    void getDarkroomAPI().cameraProfilesList().then((next) => {
      if (active) setRegistry(next);
    }).catch((error: unknown) => {
      if (active) setMessage(errorMessage(error));
    });
    return () => {
      active = false;
    };
  }, []);

  const compatible = (record: ReadyCameraProfileRecord): boolean =>
    profileStage.kind === "available" &&
    cameraProfileIsCompatible(record.profile, profileStage.camera);

  const selectProfile = (
    record: ReadyCameraProfileRecord,
    registryRevision = registry?.revision ?? "unknown",
  ): boolean => {
    if (profileStage.kind !== "available") {
      setMessage(`Camera profile unavailable: ${profileStage.reason}`);
      return false;
    }
    if (!cameraProfileIsCompatible(record.profile, profileStage.camera)) {
      setMessage(`${record.profile.label} is incompatible with this camera.`);
      return false;
    }
    const next: DevelopDocumentV3 = {
      ...document,
      color: {
        ...document.color,
        inputProfile: persistedInputProfileFromMatrix(record.profile, registryRevision),
      },
    };
    commitCompleteState(entry.catalogId, entry.id, next, `Select ${record.profile.label}`);
    setMessage(`${record.profile.label} applied before Develop tone.`);
    return true;
  };

  const useDecoderProfile = () => {
    if (profileStage.kind !== "available") {
      setMessage(`Decoder camera profile unavailable: ${profileStage.reason}`);
      return;
    }
    const next: DevelopDocumentV3 = {
      ...document,
      color: {
        ...document.color,
        inputProfile: {
          registryRevision: registry?.revision ?? "none",
          selection: { kind: "decoder-default" },
          calibration: {
            matrixToLinearSrgb: IDENTITY_MATRIX_3,
            channelScale: [1, 1, 1],
            exposureOffsetEv: 0,
          },
        },
      },
    };
    commitCompleteState(entry.catalogId, entry.id, next, "Use decoder camera profile");
    setMessage("Using the decoder camera profile available for this source.");
  };

  const importProfile = async () => {
    if (!isElectronApp()) {
      setMessage("Camera profile import is available in the desktop app.");
      return;
    }
    setBusy(true);
    try {
      const result = await getDarkroomAPI().cameraProfilesImport();
      setConflict(result.kind === "conflict" ? result : null);
      setMessage(resultMessage(result));
      if (result.kind === "imported" || result.kind === "duplicate") {
        setRegistry(await getDarkroomAPI().cameraProfilesList());
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const resolveConflict = async (action: "replace" | "import-copy" | "cancel") => {
    if (!conflict || !isElectronApp()) return;
    setBusy(true);
    try {
      const result = await getDarkroomAPI().cameraProfilesResolveConflict({
        token: conflict.token,
        action,
      });
      setConflict(null);
      setMessage(resultMessage(result));
      const nextRegistry = await getDarkroomAPI().cameraProfilesList();
      setRegistry(nextRegistry);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const rescan = async () => {
    if (!isElectronApp()) return;
    setBusy(true);
    try {
      setRegistry(await getDarkroomAPI().cameraProfilesRescan());
      setMessage("Camera profile folder rescanned.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (
    removed: ReadyCameraProfileRecord,
    replacement: ReadyCameraProfileRecord,
  ) => {
    if (!isElectronApp()) return;
    if (!window.confirm(`Remove ${removed.profile.label} and use ${replacement.profile.label} for stored references?`)) {
      return;
    }
    setBusy(true);
    try {
      const next = await getDarkroomAPI().cameraProfilesRemove({
        profileId: removed.profile.id,
        replacementProfileId: replacement.profile.id,
      });
      setRegistry(next);
      if (document.color.inputProfile.selection.kind === "selected" &&
        document.color.inputProfile.selection.profileId === removed.profile.id) {
        selectProfile(replacement, next.revision);
      } else {
        setMessage(`${removed.profile.label} removed from future choices. Existing edits keep their embedded calibration.`);
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <StatusCard title="Supported subset">
        Matrix-only DCP with one ForwardMatrix, or Darkroom matrix profile-XMP. Hue/sat maps,
        look tables, tone curves, dual-illuminant interpolation, and opcodes are rejected.
      </StatusCard>
      <div className="flex gap-1.5">
        <ActionButton onClick={() => void importProfile()} disabled={busy}>Import</ActionButton>
        <ActionButton onClick={() => void rescan()} disabled={busy || !isElectronApp()}>Rescan</ActionButton>
        <ActionButton onClick={useDecoderProfile} disabled={busy || profileStage.kind !== "available"}>Use decoder</ActionButton>
      </div>
      {profileStage.kind === "unavailable" ? (
        <p className="text-[10px] leading-4 text-lr-danger">
          Imported profiles unavailable for this source: {profileStage.reason}
        </p>
      ) : (
        <p className="text-[10px] leading-4 text-lr-text-faint">
          Camera: {profileStage.camera.make} {profileStage.camera.model}
        </p>
      )}
      {message ? <p role="status" className="text-[10px] leading-4 text-lr-accent">{message}</p> : null}
      {conflict ? (
        <div className="rounded-md border border-lr-accent/50 bg-lr-panel-raised p-2">
          <p className="text-[10px] leading-4 text-lr-text">
            Installed hash {conflict.existing.hash.slice(0, 12)} differs from imported hash {conflict.incoming.hash.slice(0, 12)}.
          </p>
          <div className="mt-2 flex gap-1.5">
            <ActionButton
              onClick={() => void resolveConflict("replace")}
              disabled={busy || !sameCamera(conflict.existing, conflict.incoming)}
              title={sameCamera(conflict.existing, conflict.incoming)
                ? "Replace the matching camera profile."
                : "Replace requires the same camera make, model, and profile kind."}
            >
              Replace
            </ActionButton>
            <ActionButton onClick={() => void resolveConflict("import-copy")} disabled={busy}>Import copy</ActionButton>
            <ActionButton onClick={() => void resolveConflict("cancel")} disabled={busy}>Cancel</ActionButton>
          </div>
        </div>
      ) : null}
      <div className="space-y-1.5" aria-label="Installed camera profiles">
        {registry?.profiles.length === 0 ? (
          <p className="text-[10px] leading-4 text-lr-text-faint">No imported profiles.</p>
        ) : null}
        {registry?.profiles.map((record) => {
          if (record.kind === "invalid") {
            return (
              <div key={record.hash} className="rounded-md border border-lr-danger/40 p-2">
                <p className="truncate text-[10px] font-medium text-lr-text">{record.sourceFilename}</p>
                <p className="mt-1 text-[9px] leading-3 text-lr-danger">Invalid: {record.parseError}</p>
              </div>
            );
          }
          const replacement = ready.find((candidate) => candidate !== record && sameCamera(candidate, record));
          const selected = document.color.inputProfile.selection.kind === "selected" &&
            document.color.inputProfile.selection.profileId === record.profile.id;
          return (
            <div key={record.profile.id} className="rounded-md border border-lr-border-subtle p-2">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[10px] font-medium text-lr-text">
                    {record.profile.label}{selected ? " · active" : ""}
                  </p>
                  <p className="mt-0.5 text-[9px] leading-3 text-lr-text-faint">
                    {record.format.toUpperCase()} · {record.profile.compatibility.make} {record.profile.compatibility.model}
                  </p>
                  <p className="mt-0.5 truncate text-[9px] leading-3 text-lr-text-faint">
                    {record.profile.id} · {record.profile.revision} · {record.hash.slice(0, 12)}
                  </p>
                  <p className="mt-0.5 text-[9px] leading-3 text-lr-text-faint">
                    Matrix, channel scale, exposure offset. No look tables or opcodes.
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <ActionButton
                    onClick={() => selectProfile(record)}
                    disabled={busy || selected || !compatible(record)}
                  >
                    {compatible(record) ? "Use" : "Incompatible"}
                  </ActionButton>
                  <ActionButton
                    onClick={() => replacement && void remove(record, replacement)}
                    disabled={busy || !replacement}
                    title={replacement
                      ? `Replace stored references with ${replacement.profile.label}`
                      : "Import another compatible profile before removing this one."}
                  >
                    Remove
                  </ActionButton>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
