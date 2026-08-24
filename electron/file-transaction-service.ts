import path from "node:path";
import type { AssetId } from "../lib/catalog/ids.ts";
import {
  sameFileObservation,
  type FileObservation,
  type FrozenImportPlan,
  type ImportPlanItem,
} from "../lib/import/domain.ts";
import { verifyFrozenImportPlan } from "./import-plan-service.ts";
import {
  CatalogFaultInjectedError,
  CATALOG_FAULT_STAGES,
  type CatalogFaultInjector,
  type CatalogFaultPoint,
  type CatalogFaultStage,
} from "./catalog-fault-injection.ts";
import {
  createNativeFileTransactionFileSystem,
  NativeFileTransactionError,
} from "./native-file-transaction-helper.ts";

export interface ResolvedXmpPaths {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceObservation: {
    readonly size: number;
    readonly modifiedAt: number;
    readonly localFileId: string | null;
  };
}

export interface ResolvedTransactionPaths {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly xmp: ResolvedXmpPaths | null;
}

export interface FileTransactionPathResolver {
  resolve(item: ImportPlanItem): Promise<ResolvedTransactionPaths>;
}

export interface FileTransactionCatalogAdapter {
  apply(item: ImportPlanItem, xmpStatus: FileTransactionXmpStatus): Promise<void>;
}

export interface ImportSourceRegistrar {
  registerSource(item: ImportPlanItem): Promise<void>;
}

export type FileTransactionXmpStatus = "absent" | "preserved" | "mismatch";

export interface FileTransactionJournalRecord {
  readonly operationId: FrozenImportPlan["operationId"];
  readonly itemId: AssetId;
  readonly action: ImportPlanItem["action"];
  readonly destinationAssetId: AssetId;
  readonly stage: CatalogFaultStage;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly xmpSourcePath: string | null;
  readonly xmpDestinationPath: string | null;
  readonly imageStagePath: string;
  readonly xmpStagePath: string | null;
  readonly imageBackupPath: string | null;
  readonly xmpBackupPath: string | null;
  readonly imageBackupProof: FileTransactionBackupProof | null;
  readonly xmpBackupProof: FileTransactionBackupProof | null;
  readonly xmpStatus: FileTransactionXmpStatus;
  readonly updatedAt: number;
}

export interface FileTransactionBackupProof {
  readonly sha256: string;
  readonly observation: FileObservation;
}

export interface FileTransactionJournal {
  read(operationId: FrozenImportPlan["operationId"], itemId: AssetId): Promise<FileTransactionJournalRecord | null>;
  write(record: FileTransactionJournalRecord): Promise<void>;
  list(operationId: FrozenImportPlan["operationId"]): Promise<readonly FileTransactionJournalRecord[]>;
}

export interface FileTransactionFileSystem {
  readonly exists: (filePath: string) => Promise<boolean>;
  readonly mkdir: (directoryPath: string) => Promise<void>;
  readonly copyFile: (sourcePath: string, destinationPath: string) => Promise<void>;
  readonly rename: (sourcePath: string, destinationPath: string) => Promise<void>;
  readonly removeFile: (filePath: string) => Promise<void>;
  readonly observe: (filePath: string) => Promise<FileObservation>;
  readonly digest: (filePath: string) => Promise<FileTransactionBackupProof>;
  readonly verifyCopy: (
    sourcePath: string,
    destinationPath: string,
    expectedSource: FileObservation,
  ) => Promise<void>;
  readonly verifyObservation: (filePath: string, expected: FileObservation) => Promise<void>;
}

export interface FileTransactionResult {
  readonly itemId: AssetId;
  readonly destinationAssetId: AssetId;
  readonly stage: CatalogFaultStage;
  readonly status: "completed" | "skipped" | "cancelled" | "failed";
  readonly xmpStatus: FileTransactionXmpStatus;
  readonly sourceCleaned: boolean;
  readonly error: string | null;
  readonly retryable?: boolean;
}

export interface ExecuteFileTransactionsInput {
  readonly plan: FrozenImportPlan;
  readonly itemIds?: ReadonlySet<AssetId>;
  readonly paths: FileTransactionPathResolver;
  readonly journal: FileTransactionJournal;
  readonly catalog: FileTransactionCatalogAdapter;
  readonly faultInjector: CatalogFaultInjector;
  readonly fileSystem?: FileTransactionFileSystem;
  readonly isCancelled?: () => boolean;
  readonly now?: () => number;
}

export class FileTransactionCancelledError extends Error {
  constructor() {
    super("File transaction was cancelled.");
    this.name = "FileTransactionCancelledError";
  }
}

export class FileTransactionRecoveryError extends Error {
  readonly itemId: AssetId;

  constructor(itemId: AssetId, message: string) {
    super(message);
    this.name = "FileTransactionRecoveryError";
    this.itemId = itemId;
  }
}

export class FileTransactionXmpMismatchError extends FileTransactionRecoveryError {
  constructor(itemId: AssetId, message: string) {
    super(itemId, message);
    this.name = "FileTransactionXmpMismatchError";
  }
}

class FileTransactionBackupIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileTransactionBackupIntegrityError";
  }
}

function isExdev(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EXDEV"
  );
}

function assertAbsoluteFilePath(filePath: string, label: string): string {
  if (!path.isAbsolute(filePath) || filePath !== path.normalize(filePath)) {
    throw new Error(`${label} must be a normalized absolute path.`);
  }
  if (filePath === path.parse(filePath).root) {
    throw new Error(`${label} cannot be a filesystem root.`);
  }
  return filePath;
}

function stagePath(destinationPath: string, operationId: string, itemId: string): string {
  return `${destinationPath}.darkroom-stage-${operationId}-${itemId}`;
}

interface FileTransactionBackupPaths {
  readonly image: string | null;
  readonly xmp: string | null;
  readonly imageProof: FileTransactionBackupProof | null;
  readonly xmpProof: FileTransactionBackupProof | null;
}

function backupPath(destinationPath: string, operationId: string, itemId: string): string {
  return `${destinationPath}.darkroom-backup-${operationId}-${itemId}`;
}

function backupPathsFor(
  item: ImportPlanItem,
  paths: ResolvedTransactionPaths,
  operationId: string,
): FileTransactionBackupPaths {
  if (item.conflictDecisions.destination?.kind !== "replace") {
    return { image: null, xmp: null, imageProof: null, xmpProof: null };
  }
  return {
    image: backupPath(paths.destinationPath, operationId, item.itemId),
    xmp: paths.xmp === null
      ? null
      : backupPath(paths.xmp.destinationPath, operationId, item.itemId),
    imageProof: null,
    xmpProof: null,
  };
}

function xmpObservation(paths: ResolvedTransactionPaths): FileObservation | null {
  if (paths.xmp === null) return null;
  return {
    size: paths.xmp.sourceObservation.size,
    modifiedAt: paths.xmp.sourceObservation.modifiedAt,
    localFileId: paths.xmp.sourceObservation.localFileId,
    observedAt: Date.now(),
  };
}

const nativeFileSystem = createNativeFileTransactionFileSystem();

async function renameWithCrossVolumeFallback(
  fileSystem: FileTransactionFileSystem,
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  try {
    await fileSystem.rename(sourcePath, destinationPath);
  } catch (error) {
    if (!isExdev(error)) {
      throw error;
    }
    await fileSystem.copyFile(sourcePath, destinationPath);
    await fileSystem.removeFile(sourcePath);
  }
}

function faultPoint(
  plan: FrozenImportPlan,
  item: ImportPlanItem,
  stage: CatalogFaultStage,
): CatalogFaultPoint {
  return {
    operationId: plan.operationId,
    itemId: item.itemId,
    stage,
  };
}

async function transition(
  input: ExecuteFileTransactionsInput,
  item: ImportPlanItem,
  paths: ResolvedTransactionPaths,
  backupPaths: FileTransactionBackupPaths,
  stage: CatalogFaultStage,
  xmpStatus: FileTransactionXmpStatus,
  now: () => number,
): Promise<FileTransactionJournalRecord> {
  const record: FileTransactionJournalRecord = {
    operationId: input.plan.operationId,
    itemId: item.itemId,
    action: item.action,
    destinationAssetId: item.destinationAssetId,
    stage,
    sourcePath: paths.sourcePath,
    destinationPath: paths.destinationPath,
    xmpSourcePath: paths.xmp?.sourcePath ?? null,
    xmpDestinationPath: paths.xmp?.destinationPath ?? null,
    imageStagePath: stagePath(paths.destinationPath, input.plan.operationId, item.itemId),
    xmpStagePath: paths.xmp === null
      ? null
      : stagePath(paths.xmp.destinationPath, input.plan.operationId, item.itemId),
    imageBackupPath: backupPaths.image,
    xmpBackupPath: backupPaths.xmp,
    imageBackupProof: backupPaths.imageProof,
    xmpBackupProof: backupPaths.xmpProof,
    xmpStatus,
    updatedAt: now(),
  };
  await input.journal.write(record);
  input.faultInjector.afterStage(faultPoint(input.plan, item, stage));
  return record;
}

function shouldCleanSource(action: ImportPlanItem["action"]): boolean {
  return action === "move" || action === "rename";
}

function transactionErrorMessage(error: unknown): string {
  if (error instanceof FileTransactionXmpMismatchError) {
    return "XMP sidecar does not match the planned source bundle.";
  }
  if (error instanceof FileTransactionRecoveryError) {
    return error.message;
  }
  if (error instanceof FileTransactionBackupIntegrityError) {
    return error.message;
  }
  if (error instanceof NativeFileTransactionError) {
    return error.message;
  }
  return "File transaction failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileObservation(value: unknown): value is FileObservation {
  if (!isRecord(value)) return false;
  return (
    typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0 &&
    typeof value.modifiedAt === "number" && Number.isFinite(value.modifiedAt) &&
    typeof value.observedAt === "number" && Number.isFinite(value.observedAt) &&
    (value.localFileId === null || typeof value.localFileId === "string")
  );
}

function assertBackupProof(value: unknown, label: string): asserts value is FileTransactionBackupProof | null {
  if (value === null) return;
  if (!isRecord(value) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error(`${label} is invalid.`);
  }
  if (!isFileObservation(value.observation)) {
    throw new Error(`${label} observation is invalid.`);
  }
}

function assertJournalMatches(
  record: FileTransactionJournalRecord,
  input: ExecuteFileTransactionsInput,
  item: ImportPlanItem,
  paths: ResolvedTransactionPaths,
  stageImagePath: string,
  stageXmpPath: string | null,
  backupPaths: FileTransactionBackupPaths,
): void {
  if (!CATALOG_FAULT_STAGES.includes(record.stage)) {
    throw new FileTransactionRecoveryError(item.itemId, "Transaction journal stage is invalid.");
  }
  if (
    record.xmpStatus !== "absent" &&
    record.xmpStatus !== "preserved" &&
    record.xmpStatus !== "mismatch"
  ) {
    throw new FileTransactionRecoveryError(item.itemId, "Transaction journal XMP status is invalid.");
  }
  if (!Number.isFinite(record.updatedAt)) {
    throw new FileTransactionRecoveryError(item.itemId, "Transaction journal timestamp is invalid.");
  }
  if (
    record.operationId !== input.plan.operationId ||
    record.itemId !== item.itemId ||
    record.action !== item.action ||
    record.destinationAssetId !== item.destinationAssetId ||
    record.sourcePath !== paths.sourcePath ||
    record.destinationPath !== paths.destinationPath ||
    record.xmpSourcePath !== (paths.xmp?.sourcePath ?? null) ||
    record.xmpDestinationPath !== (paths.xmp?.destinationPath ?? null) ||
    record.imageStagePath !== stageImagePath ||
    record.xmpStagePath !== stageXmpPath ||
    record.imageBackupPath !== backupPaths.image ||
    record.xmpBackupPath !== backupPaths.xmp
  ) {
    throw new FileTransactionRecoveryError(item.itemId, "Transaction journal does not match the frozen plan.");
  }
  assertBackupProof(record.imageBackupProof, "Image backup proof");
  assertBackupProof(record.xmpBackupProof, "XMP backup proof");
  if (record.imageBackupPath === null && record.imageBackupProof !== null) {
    throw new FileTransactionRecoveryError(item.itemId, "Image backup proof does not match its path.");
  }
  if (record.xmpBackupPath === null && record.xmpBackupProof !== null) {
    throw new FileTransactionRecoveryError(item.itemId, "XMP backup proof does not match its path.");
  }
}

async function prepareBundle(
  input: ExecuteFileTransactionsInput,
  item: ImportPlanItem,
  paths: ResolvedTransactionPaths,
  stageImagePath: string,
  stageXmpPath: string | null,
): Promise<FileTransactionXmpStatus> {
  const fileSystem = input.fileSystem ?? nativeFileSystem;
  await fileSystem.mkdir(path.dirname(paths.destinationPath));
  await fileSystem.copyFile(paths.sourcePath, stageImagePath);
  await fileSystem.verifyCopy(paths.sourcePath, stageImagePath, item.source.observation);
  if (paths.xmp === null) {
    return "absent";
  }
  try {
    await fileSystem.copyFile(paths.xmp.sourcePath, stageXmpPath!);
    const sourceObservation: FileObservation = {
      size: paths.xmp.sourceObservation.size,
      modifiedAt: paths.xmp.sourceObservation.modifiedAt,
      localFileId: paths.xmp.sourceObservation.localFileId,
      observedAt: Date.now(),
    };
    await fileSystem.verifyCopy(paths.xmp.sourcePath, stageXmpPath!, sourceObservation);
  } catch (error) {
    await fileSystem.removeFile(stageImagePath).catch(() => undefined);
    throw new FileTransactionXmpMismatchError(
      item.itemId,
      error instanceof Error ? error.message : "XMP sidecar could not be staged.",
    );
  }
  return "preserved";
}

async function prepareOrReconcileBundle(
  input: ExecuteFileTransactionsInput,
  item: ImportPlanItem,
  paths: ResolvedTransactionPaths,
  stageImagePath: string,
  stageXmpPath: string | null,
): Promise<FileTransactionXmpStatus> {
  const fileSystem = input.fileSystem ?? nativeFileSystem;
  const imageExists = await fileSystem.exists(stageImagePath);
  const xmpExists = stageXmpPath !== null && await fileSystem.exists(stageXmpPath);
  if (paths.xmp === null) {
    if (imageExists) {
      try {
        await fileSystem.verifyCopy(paths.sourcePath, stageImagePath, item.source.observation);
        return "absent";
      } catch {
        await fileSystem.removeFile(stageImagePath);
      }
    }
    return prepareBundle(input, item, paths, stageImagePath, stageXmpPath);
  }
  const xmpSourceObservation = xmpObservation(paths)!;
  if (imageExists && xmpExists) {
    try {
      await fileSystem.verifyCopy(paths.sourcePath, stageImagePath, item.source.observation);
      await fileSystem.verifyCopy(paths.xmp.sourcePath, stageXmpPath!, xmpSourceObservation);
      return "preserved";
    } catch {
      await fileSystem.removeFile(stageImagePath).catch(() => undefined);
      await fileSystem.removeFile(stageXmpPath!).catch(() => undefined);
      return prepareBundle(input, item, paths, stageImagePath, stageXmpPath);
    }
  }
  if (imageExists) await fileSystem.removeFile(stageImagePath);
  if (xmpExists) await fileSystem.removeFile(stageXmpPath!);
  return prepareBundle(input, item, paths, stageImagePath, stageXmpPath);
}

async function verifyBackup(
  fileSystem: FileTransactionFileSystem,
  backupPathValue: string,
  expected: FileTransactionBackupProof | null,
): Promise<FileTransactionBackupProof> {
  const actual = await fileSystem.digest(backupPathValue);
  if (!/^[0-9a-f]{64}$/.test(actual.sha256) || !isFileObservation(actual.observation)) {
    throw new FileTransactionBackupIntegrityError("Transaction backup digest is invalid.");
  }
  if (
    expected !== null &&
    (actual.sha256 !== expected.sha256 || !sameFileObservation(expected.observation, actual.observation))
  ) {
    throw new FileTransactionBackupIntegrityError("Transaction backup integrity proof does not match.");
  }
  return actual;
}

async function preserveExistingDestination(
  fileSystem: FileTransactionFileSystem,
  destinationPath: string,
  backupPathValue: string | null,
  expected: FileTransactionBackupProof | null,
  onProof: (proof: FileTransactionBackupProof) => Promise<void>,
): Promise<FileTransactionBackupProof | null> {
  if (backupPathValue === null || !(await fileSystem.exists(destinationPath))) {
    return null;
  }
  if (await fileSystem.exists(backupPathValue)) {
    const proof = await verifyBackup(fileSystem, backupPathValue, expected);
    if (expected === null) await onProof(proof);
    return proof;
  }
  const before = await fileSystem.digest(destinationPath);
  await renameWithCrossVolumeFallback(fileSystem, destinationPath, backupPathValue);
  const proof = await verifyBackup(fileSystem, backupPathValue, null);
  if (proof.sha256 !== before.sha256 || proof.observation.size !== before.observation.size) {
    throw new Error("Transaction backup bytes changed during preservation.");
  }
  await onProof(proof);
  return proof;
}

async function publishFile(
  fileSystem: FileTransactionFileSystem,
  itemId: AssetId,
  sourcePath: string,
  destinationPath: string,
  stagePathValue: string,
  backupPathValue: string | null,
  backupProof: FileTransactionBackupProof | null,
  expectedSource: FileObservation,
  replaceExisting: boolean,
  onBackupProof: (proof: FileTransactionBackupProof) => Promise<void>,
): Promise<FileTransactionBackupProof | null> {
  const destinationExists = await fileSystem.exists(destinationPath);
  const stageExists = await fileSystem.exists(stagePathValue);
  const backupExists = backupPathValue !== null && await fileSystem.exists(backupPathValue);
  let proof: FileTransactionBackupProof | null = null;
  if (backupExists) {
    proof = await verifyBackup(fileSystem, backupPathValue!, backupProof);
    if (backupProof === null) await onBackupProof(proof);
  }

  if (destinationExists && stageExists) {
    if (backupExists) {
      await fileSystem.verifyCopy(sourcePath, destinationPath, expectedSource);
      await fileSystem.removeFile(stagePathValue);
    } else {
      if (!replaceExisting) {
        throw new FileTransactionRecoveryError(
          itemId,
          "Destination already exists.",
        );
      }
      proof = await preserveExistingDestination(
        fileSystem,
        destinationPath,
        backupPathValue,
        backupProof,
        onBackupProof,
      );
      await renameWithCrossVolumeFallback(fileSystem, stagePathValue, destinationPath);
    }
  } else if (destinationExists) {
    await fileSystem.verifyCopy(sourcePath, destinationPath, expectedSource);
  } else {
    if (!stageExists) {
      throw new FileTransactionRecoveryError(
        itemId,
        "Staged destination is missing.",
      );
    }
    await renameWithCrossVolumeFallback(fileSystem, stagePathValue, destinationPath);
  }
  await fileSystem.verifyCopy(sourcePath, destinationPath, expectedSource);
  return proof;
}

async function publishBundle(
  input: ExecuteFileTransactionsInput,
  itemId: AssetId,
  item: ImportPlanItem,
  paths: ResolvedTransactionPaths,
  backupPaths: FileTransactionBackupPaths,
  stageImagePath: string,
  stageXmpPath: string | null,
  onBackupProof: (member: "image" | "xmp", proof: FileTransactionBackupProof) => Promise<void>,
): Promise<void> {
  const fileSystem = input.fileSystem ?? nativeFileSystem;
  const replaceExisting = item.conflictDecisions.destination?.kind === "replace";
  await publishFile(
    fileSystem,
    itemId,
    paths.sourcePath,
    paths.destinationPath,
    stageImagePath,
    backupPaths.image,
    backupPaths.imageProof,
    item.source.observation,
    replaceExisting,
    (proof) => onBackupProof("image", proof),
  );
  if (paths.xmp !== null && stageXmpPath !== null) {
    await publishFile(
      fileSystem,
      itemId,
      paths.xmp.sourcePath,
      paths.xmp.destinationPath,
      stageXmpPath,
      backupPaths.xmp,
      backupPaths.xmpProof,
      xmpObservation(paths)!,
      replaceExisting,
      (proof) => onBackupProof("xmp", proof),
    );
  }
}

async function restoreFileBeforeCatalog(
  fileSystem: FileTransactionFileSystem,
  itemId: AssetId,
  sourcePath: string,
  destinationPath: string,
  stagePathValue: string,
  backupPathValue: string | null,
  backupProof: FileTransactionBackupProof | null,
  expectedSource: FileObservation,
): Promise<void> {
  const backupExists = backupPathValue !== null
    ? await fileSystem.exists(backupPathValue)
    : false;
  if (backupExists && backupPathValue !== null) {
    if (backupProof === null) {
      throw new FileTransactionRecoveryError(itemId, "Replace backup has no integrity proof.");
    }
    await verifyBackup(fileSystem, backupPathValue, backupProof);
  }
  const destinationExists = await fileSystem.exists(destinationPath);
  const stageExists = await fileSystem.exists(stagePathValue);
  if (destinationExists) {
    if (backupExists) {
      if (stageExists) {
        await fileSystem.removeFile(destinationPath);
      } else {
        await renameWithCrossVolumeFallback(fileSystem, destinationPath, stagePathValue);
      }
    } else {
      if (backupPathValue !== null) {
        throw new FileTransactionRecoveryError(itemId, "Replace backup is missing.");
      }
      await fileSystem.verifyCopy(sourcePath, destinationPath, expectedSource);
      if (stageExists) {
        await fileSystem.removeFile(destinationPath);
      } else {
        await renameWithCrossVolumeFallback(fileSystem, destinationPath, stagePathValue);
      }
    }
  }
  if (backupExists && backupPathValue !== null) {
    if (await fileSystem.exists(destinationPath)) {
      throw new FileTransactionRecoveryError(itemId, "Cannot restore the previous destination.");
    }
    await renameWithCrossVolumeFallback(fileSystem, backupPathValue, destinationPath);
    await verifyBackup(fileSystem, destinationPath, backupProof);
  }
}

async function rollbackPublishedBundle(
  input: ExecuteFileTransactionsInput,
  itemId: AssetId,
  item: ImportPlanItem,
  paths: ResolvedTransactionPaths,
  backupPaths: FileTransactionBackupPaths,
  stageImagePath: string,
  stageXmpPath: string | null,
): Promise<void> {
  const fileSystem = input.fileSystem ?? nativeFileSystem;
  const backupMembers: readonly [string | null, FileTransactionBackupProof | null][] = [
    [backupPaths.image, backupPaths.imageProof],
    [backupPaths.xmp, backupPaths.xmpProof],
  ];
  for (const [backupPathValue, proof] of backupMembers) {
    if (backupPathValue !== null && await fileSystem.exists(backupPathValue)) {
      if (proof === null) {
        throw new FileTransactionRecoveryError(itemId, "Replace backup has no integrity proof.");
      }
      await verifyBackup(fileSystem, backupPathValue, proof);
    }
  }
  await restoreFileBeforeCatalog(
    fileSystem,
    itemId,
    paths.sourcePath,
    paths.destinationPath,
    stageImagePath,
    backupPaths.image,
    backupPaths.imageProof,
    item.source.observation,
  );
  if (paths.xmp !== null && stageXmpPath !== null) {
    await restoreFileBeforeCatalog(
      fileSystem,
      itemId,
      paths.xmp.sourcePath,
      paths.xmp.destinationPath,
      stageXmpPath,
      backupPaths.xmp,
      backupPaths.xmpProof,
      xmpObservation(paths)!,
    );
  }
}

async function cleanBackups(
  fileSystem: FileTransactionFileSystem,
  backupPaths: FileTransactionBackupPaths,
): Promise<void> {
  const backups: readonly [string | null, FileTransactionBackupProof | null][] = [
    [backupPaths.image, backupPaths.imageProof],
    [backupPaths.xmp, backupPaths.xmpProof],
  ];
  const existing: [string, FileTransactionBackupProof][] = [];
  for (const [backupPathValue, proof] of backups) {
    if (backupPathValue !== null && await fileSystem.exists(backupPathValue)) {
      if (proof === null) {
        throw new Error("Replace backup has no integrity proof.");
      }
      await verifyBackup(fileSystem, backupPathValue, proof);
      existing.push([backupPathValue, proof]);
    }
  }
  for (const [backupPathValue] of existing) {
    await fileSystem.removeFile(backupPathValue);
  }
}

async function cleanSource(
  input: ExecuteFileTransactionsInput,
  item: ImportPlanItem,
  paths: ResolvedTransactionPaths,
  action: ImportPlanItem["action"],
): Promise<void> {
  if (!shouldCleanSource(action)) {
    return;
  }
  const fileSystem = input.fileSystem ?? nativeFileSystem;
  const members: readonly { readonly filePath: string; readonly expected: FileObservation }[] = [
    { filePath: paths.sourcePath, expected: item.source.observation },
    ...(paths.xmp === null
      ? []
      : [{ filePath: paths.xmp.sourcePath, expected: xmpObservation(paths)! }]),
  ];
  const present: { readonly filePath: string; readonly expected: FileObservation }[] = [];
  for (const member of members) {
    if (!(await fileSystem.exists(member.filePath))) continue;
    await fileSystem.verifyObservation(member.filePath, member.expected);
    present.push(member);
  }
  for (const member of present) {
    await fileSystem.removeFile(member.filePath);
  }
}

async function executeItem(
  input: ExecuteFileTransactionsInput,
  item: ImportPlanItem,
): Promise<FileTransactionResult> {
  if (
    item.conflictDecisions.duplicate?.kind === "skip-incoming" ||
    item.conflictDecisions.destination?.kind === "skip"
  ) {
    return {
      itemId: item.itemId,
      destinationAssetId: item.destinationAssetId,
      stage: "planned",
      status: "skipped",
      xmpStatus: item.source.xmpState === "present" ? "preserved" : "absent",
      sourceCleaned: false,
      error: null,
    };
  }
  const paths = await input.paths.resolve(item);
  assertAbsoluteFilePath(paths.sourcePath, "Source path");
  assertAbsoluteFilePath(paths.destinationPath, "Destination path");
  if (paths.sourcePath === paths.destinationPath) {
    throw new FileTransactionRecoveryError(item.itemId, "Source and destination paths must differ.");
  }
  if (paths.xmp !== null) {
    assertAbsoluteFilePath(paths.xmp.sourcePath, "XMP source path");
    assertAbsoluteFilePath(paths.xmp.destinationPath, "XMP destination path");
  }
  const fileSystem = input.fileSystem ?? nativeFileSystem;
  const now = input.now ?? Date.now;
  const stageImagePath = stagePath(paths.destinationPath, input.plan.operationId, item.itemId);
  const stageXmpPath = paths.xmp === null ? null : stagePath(paths.xmp.destinationPath, input.plan.operationId, item.itemId);
  const backupPaths = backupPathsFor(item, paths, input.plan.operationId);
  let record = await input.journal.read(input.plan.operationId, item.itemId);
  if (record !== null) {
    assertJournalMatches(record, input, item, paths, stageImagePath, stageXmpPath, backupPaths);
  }
  let backupState: FileTransactionBackupPaths = {
    ...backupPaths,
    imageProof: record?.imageBackupProof ?? null,
    xmpProof: record?.xmpBackupProof ?? null,
  };
  let xmpStatus = record?.xmpStatus ?? (paths.xmp === null ? "absent" : "preserved");
  let catalogApplyAttempted = record?.stage === "catalog-applied" || record?.stage === "source-cleaned";
  const persistBackupProof = async (
    member: "image" | "xmp",
    proof: FileTransactionBackupProof,
  ): Promise<void> => {
    backupState = member === "image"
      ? { ...backupState, imageProof: proof }
      : { ...backupState, xmpProof: proof };
    if (record !== null) {
      record = {
        ...record,
        imageBackupProof: backupState.imageProof,
        xmpBackupProof: backupState.xmpProof,
        updatedAt: now(),
      };
      await input.journal.write(record);
    }
  };
  try {
    if (input.isCancelled?.() === true) {
      throw new FileTransactionCancelledError();
    }
    if (record === null || record.stage === "planned") {
      record = await transition(input, item, paths, backupState, "planned", xmpStatus, now);
    }
    if (record.stage === "planned") {
      if (input.isCancelled?.() === true) {
        throw new FileTransactionCancelledError();
      }
      xmpStatus = await prepareOrReconcileBundle(input, item, paths, stageImagePath, stageXmpPath);
      if (input.isCancelled?.() === true) {
        throw new FileTransactionCancelledError();
      }
      record = await transition(input, item, paths, backupState, "destination-prepared", xmpStatus, now);
    }
    if (record.stage === "destination-prepared") {
      if (input.isCancelled?.() === true) {
        throw new FileTransactionCancelledError();
      }
      const destinationExists = await fileSystem.exists(paths.destinationPath);
      const replaceExisting = item.conflictDecisions.destination?.kind === "replace";
      if (destinationExists && !replaceExisting) {
        await fileSystem.verifyCopy(paths.sourcePath, paths.destinationPath, item.source.observation);
        if (paths.xmp !== null) {
          await fileSystem.verifyCopy(paths.xmp.sourcePath, paths.xmp.destinationPath, xmpObservation(paths)!);
          xmpStatus = "preserved";
        }
        await fileSystem.removeFile(stageImagePath).catch(() => undefined);
        if (stageXmpPath !== null) await fileSystem.removeFile(stageXmpPath).catch(() => undefined);
      } else {
        xmpStatus = await prepareOrReconcileBundle(input, item, paths, stageImagePath, stageXmpPath);
        if (input.isCancelled?.() === true) {
          throw new FileTransactionCancelledError();
        }
        await publishBundle(
          input,
          item.itemId,
          item,
          paths,
          backupState,
          stageImagePath,
          stageXmpPath,
          persistBackupProof,
        );
      }
      record = await transition(input, item, paths, backupState, "destination-published", xmpStatus, now);
    }
    if (record.stage === "destination-published") {
      const backupEntries: readonly (readonly [string | null, FileTransactionBackupProof | null])[] = [
        [backupState.image, backupState.imageProof],
        [backupState.xmp, backupState.xmpProof],
      ];
      for (const [backupPathValue, proof] of backupEntries) {
        if (backupPathValue !== null && await fileSystem.exists(backupPathValue)) {
          if (proof === null) {
            throw new FileTransactionRecoveryError(item.itemId, "Replace backup has no integrity proof.");
          }
          await verifyBackup(fileSystem, backupPathValue, proof);
        }
      }
      const imageNeedsPublish =
        !(await fileSystem.exists(paths.destinationPath)) || await fileSystem.exists(stageImagePath);
      const xmpNeedsPublish = paths.xmp !== null && (
        !(await fileSystem.exists(paths.xmp.destinationPath)) || await fileSystem.exists(stageXmpPath!)
      );
      if (imageNeedsPublish || xmpNeedsPublish) {
        await publishBundle(
          input,
          item.itemId,
          item,
          paths,
          backupState,
          stageImagePath,
          stageXmpPath,
          persistBackupProof,
        );
      }
      if (paths.xmp !== null && !(await fileSystem.exists(paths.xmp.destinationPath))) {
        throw new FileTransactionXmpMismatchError(item.itemId, "Published XMP sidecar is missing.");
      }
      catalogApplyAttempted = true;
      await input.catalog.apply(item, xmpStatus);
      record = await transition(input, item, paths, backupState, "catalog-applied", xmpStatus, now);
    }
    if (record.stage === "catalog-applied") {
      if (!(await fileSystem.exists(paths.destinationPath))) {
        throw new FileTransactionRecoveryError(item.itemId, "Catalog-applied destination is missing.");
      }
      await cleanBackups(fileSystem, backupState);
      await cleanSource(input, item, paths, item.action);
      record = await transition(input, item, paths, backupState, "source-cleaned", xmpStatus, now);
    }
    if (record.stage === "source-cleaned" && !(await fileSystem.exists(paths.destinationPath))) {
      throw new FileTransactionRecoveryError(item.itemId, "Completed destination is missing.");
    }
    return {
      itemId: item.itemId,
      destinationAssetId: item.destinationAssetId,
      stage: record.stage,
      status: "completed",
      xmpStatus,
      sourceCleaned: record.stage === "source-cleaned" && shouldCleanSource(item.action),
      error: null,
    };
  } catch (error) {
    if (error instanceof CatalogFaultInjectedError) {
      throw error;
    }
    if (!catalogApplyAttempted && item.conflictDecisions.destination?.kind === "replace") {
      await rollbackPublishedBundle(
        input,
        item.itemId,
        item,
        paths,
        backupState,
        stageImagePath,
        stageXmpPath,
      ).catch(() => undefined);
    }
    if (error instanceof FileTransactionXmpMismatchError) {
      xmpStatus = "mismatch";
    }
    if (error instanceof FileTransactionCancelledError) {
      if (record !== null && (record.stage === "planned" || record.stage === "destination-prepared")) {
        await fileSystem.removeFile(stageImagePath).catch(() => undefined);
        if (stageXmpPath !== null) {
          await fileSystem.removeFile(stageXmpPath).catch(() => undefined);
        }
        record = { ...record, stage: "planned", updatedAt: now() };
        await input.journal.write(record);
      }
      return {
        itemId: item.itemId,
        destinationAssetId: item.destinationAssetId,
        stage: record?.stage ?? "planned",
        status: "cancelled",
        xmpStatus,
        sourceCleaned: false,
        error: null,
      };
    }
    if (
      record?.stage === "catalog-applied" &&
      catalogApplyAttempted &&
      shouldCleanSource(item.action)
    ) {
      return {
        itemId: item.itemId,
        destinationAssetId: item.destinationAssetId,
        stage: "catalog-applied",
        status: "completed",
        xmpStatus,
        sourceCleaned: false,
        error: "Destination is active, but the source was retained.",
      };
    }
    return {
      itemId: item.itemId,
      destinationAssetId: item.destinationAssetId,
      stage: record?.stage ?? "planned",
      status: "failed",
      xmpStatus,
      sourceCleaned: false,
      error: transactionErrorMessage(error),
      retryable: catalogApplyAttempted,
    };
  }
}

export async function executeFileTransactions(
  input: ExecuteFileTransactionsInput,
): Promise<readonly FileTransactionResult[]> {
  verifyFrozenImportPlan(input.plan);
  const items = input.itemIds === undefined
    ? input.plan.items
    : input.plan.items.filter((item) => input.itemIds?.has(item.itemId));
  if (items.some((item) => item.action === "add")) {
    throw new Error("Add items must use the source registration adapter.");
  }
  const results: FileTransactionResult[] = [];
  for (const item of items) {
    if (input.isCancelled?.() === true) {
      break;
    }
    results.push(await executeItem(input, item));
    if (results.at(-1)?.status !== "completed" && results.at(-1)?.status !== "skipped") {
      break;
    }
  }
  return results;
}

export async function registerImportSources(
  plan: FrozenImportPlan,
  registrar: ImportSourceRegistrar,
): Promise<readonly AssetId[]> {
  verifyFrozenImportPlan(plan);
  const registered: AssetId[] = [];
  for (const item of plan.items) {
    if (item.action !== "add") continue;
    await registrar.registerSource(item);
    registered.push(item.destinationAssetId);
  }
  return registered;
}

export async function recoverFileTransactions(
  input: ExecuteFileTransactionsInput,
): Promise<readonly FileTransactionResult[]> {
  return executeFileTransactions({ ...input, isCancelled: undefined });
}

export class MemoryFileTransactionJournal implements FileTransactionJournal {
  private readonly records = new Map<string, FileTransactionJournalRecord>();

  async read(
    operationId: FrozenImportPlan["operationId"],
    itemId: AssetId,
  ): Promise<FileTransactionJournalRecord | null> {
    return this.records.get(`${operationId}:${itemId}`) ?? null;
  }

  async write(record: FileTransactionJournalRecord): Promise<void> {
    this.records.set(`${record.operationId}:${record.itemId}`, structuredClone(record));
  }

  async list(
    operationId: FrozenImportPlan["operationId"],
  ): Promise<readonly FileTransactionJournalRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.operationId === operationId)
      .map((record) => structuredClone(record));
  }
}
