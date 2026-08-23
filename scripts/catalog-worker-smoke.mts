import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCatalogWorkerClient,
  type CatalogWorkerClient,
} from "../electron/catalog-worker-client.ts";

interface WorkerSmokeReport {
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly workerThreadId: number;
  readonly transactionRows: number;
  readonly backupPages: number;
  readonly integrity: readonly string[];
  readonly reopenedWithoutLock: boolean;
}

interface AppSmokeReport {
  readonly ok: true;
  readonly packaged: boolean;
  readonly workerPath: string;
  readonly appPath: string;
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly reopenedWithoutLock: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Catalog worker app smoke report ${key} is invalid.`);
  }
  return value;
}

function parseAppSmokeReport(value: unknown, packaged: boolean): AppSmokeReport {
  if (!isRecord(value) || value.ok !== true || value.packaged !== packaged) {
    throw new Error("Catalog worker app smoke report is invalid.");
  }
  const nodeVersion = requiredString(value, "nodeVersion");
  const sqliteVersion = requiredString(value, "sqliteVersion");
  assert.match(nodeVersion, /^24\./);
  assert.notEqual(sqliteVersion, "unknown");
  if (
    value.reopenedWithoutLock !== true ||
    typeof value.workerPath !== "string" ||
    typeof value.appPath !== "string"
  ) {
    throw new Error("Catalog worker app smoke report lifecycle is invalid.");
  }
  return {
    ok: true,
    packaged,
    workerPath: value.workerPath,
    appPath: value.appPath,
    nodeVersion,
    sqliteVersion,
    reopenedWithoutLock: true,
  };
}

function electronExecutable(): string {
  const configured = process.env.DARKROOM_ELECTRON_EXECUTABLE;
  if (configured && path.isAbsolute(configured)) {
    return configured;
  }
  return path.resolve(
    "node_modules/.bin",
    process.platform === "win32" ? "electron.cmd" : "electron",
  );
}

function packagedExecutable(appPath: string): string {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "MacOS", "Darkroom");
  }
  return appPath;
}

async function launchApp(
  executable: string,
  args: readonly string[],
  reportPath: string,
): Promise<number> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DARKROOM_CATALOG_WORKER_SMOKE: "1",
    DARKROOM_CATALOG_WORKER_SMOKE_REPORT: reportPath,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  return new Promise<number>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: path.resolve("."),
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function runProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: path.resolve("."),
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function buildPackagedApp(outputRoot: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("Catalog worker packaged smoke needs an explicit packaged app on this platform.");
  }
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const builder = path.resolve("node_modules/.bin/electron-builder");
  const exitCode = await runProcess(
    builder,
    [
      "--dir",
      "--mac",
      "--arm64",
      `--config.directories.output=${outputRoot}`,
      "--config.mac.extraResources=null",
    ],
    environment,
  );
  assert.equal(exitCode, 0);
  return path.join(outputRoot, "mac-arm64", "Darkroom.app");
}

async function runWorkerSmoke(workerPath: string): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-worker-smoke-"));
  const databasePath = path.join(root, "catalog.db");
  const backupPath = path.join(root, "backup", "catalog.db");
  let client: CatalogWorkerClient | null = null;
  let reopened: CatalogWorkerClient | null = null;

  try {
    client = createCatalogWorkerClient({ workerPath, requestTimeoutMs: 10_000 });
    const runtime = await client.runtimeInfo();
    assert.match(runtime.nodeVersion, /^24\./);
    assert.notEqual(runtime.sqliteVersion, "unknown");
    const opened = await client.open(databasePath);
    const transaction = await client.transactionProbe();
    const backup = await client.backup(backupPath);
    const integrity = await client.integrityCheck();
    assert.equal(opened.created, true);
    assert.equal(transaction.committed, true);
    assert.equal(transaction.rowCount, 1);
    assert.deepEqual(integrity.integrityCheck, ["ok"]);
    assert.deepEqual(integrity.foreignKeyCheck, []);
    assert.ok((await readFile(backupPath)).byteLength > 0);
    await client.shutdown();
    client = null;

    reopened = createCatalogWorkerClient({ workerPath, requestTimeoutMs: 10_000 });
    await reopened.open(databasePath);
    const reopenedIntegrity = await reopened.integrityCheck();
    assert.deepEqual(reopenedIntegrity.integrityCheck, ["ok"]);
    await reopened.shutdown();
    reopened = null;

    const report: WorkerSmokeReport = {
      nodeVersion: runtime.nodeVersion,
      sqliteVersion: runtime.sqliteVersion,
      workerThreadId: runtime.workerThreadId,
      transactionRows: transaction.rowCount,
      backupPages: backup.pages,
      integrity: integrity.integrityCheck,
      reopenedWithoutLock: true,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await client?.forceTerminate().catch(() => undefined);
    await reopened?.forceTerminate().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function runAppSmoke(configuredPackagedAppPath: string | null): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-app-smoke-launcher-"));
  const devReportPath = path.join(root, "dev.json");
  const packagedReportPath = path.join(root, "packaged.json");
  try {
    const devExitCode = await launchApp(electronExecutable(), ["."], devReportPath);
    assert.equal(devExitCode, 0);
    const devRaw = await readFile(devReportPath, "utf8");
    const devValue: unknown = JSON.parse(devRaw);
    const devReport = parseAppSmokeReport(devValue, false);

    const packagedAppPath = configuredPackagedAppPath ?? await buildPackagedApp(path.join(root, "package"));
    await access(path.join(packagedAppPath, "Contents", "Resources", "app.asar"));
    const packagedExitCode = await launchApp(
      packagedExecutable(packagedAppPath),
      [],
      packagedReportPath,
    );
    assert.equal(packagedExitCode, 0);
    const packagedRaw = await readFile(packagedReportPath, "utf8");
    const packagedValue: unknown = JSON.parse(packagedRaw);
    const packagedReport = parseAppSmokeReport(packagedValue, true);

    process.stdout.write(`${JSON.stringify({ dev: devReport, packaged: packagedReport })}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === "--app") {
  const configuredPackagedApp = process.env.DARKROOM_CATALOG_PACKAGED_APP;
  const packagedAppArgument = process.argv[3] ?? configuredPackagedApp;
  await runAppSmoke(packagedAppArgument ? path.resolve(packagedAppArgument) : null);
} else if (mode) {
  await runWorkerSmoke(path.resolve(mode));
} else {
  throw new Error("Catalog worker smoke test needs a worker path or --app.");
}
