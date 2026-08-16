import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = process.cwd();
const sharpPackagePath = path.join(rootDir, "node_modules/sharp/package.json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const builder = path.join(
  rootDir,
  "node_modules/.bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
);

const targetSpecs = [
  {
    id: "mac-arm64",
    platform: "darwin",
    arch: "arm64",
    args: ["--mac", "--arm64"],
    packages: ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"],
  },
  {
    id: "win-x64",
    platform: "win32",
    arch: "x64",
    args: ["--win", "--x64"],
    packages: ["@img/sharp-win32-x64"],
  },
  {
    id: "linux-x64",
    platform: "linux",
    arch: "x64",
    args: ["--linux", "--x64"],
    packages: ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"],
  },
];

const platformFlags = new Set([
  "--mac",
  "--macos",
  "-m",
  "--win",
  "--windows",
  "-w",
  "--linux",
  "-l",
  "--arm64",
  "--x64",
  "--ia32",
  "--armv7l",
  "--universal",
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}.`);
  }
}

function readJson(filePath) {
  return fs.readFile(filePath, "utf8").then((raw) => JSON.parse(raw));
}

function packagePath(packageName) {
  return path.join(rootDir, "node_modules", ...packageName.split("/"));
}

async function packageVersion(packageName) {
  try {
    const packageJson = await readJson(path.join(packagePath(packageName), "package.json"));
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    return null;
  }
}

async function packInto(packageName, version, stagingRoot) {
  const destination = path.join(stagingRoot, "npm-pack");
  await fs.mkdir(destination, { recursive: true });
  const result = spawnSync(npmCommand, [
    "pack",
    "--silent",
    "--pack-destination",
    destination,
    `${packageName}@${version}`,
  ], {
    cwd: rootDir,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`npm pack failed for ${packageName}@${version}.`);
  }
  const archiveName = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!archiveName) {
    throw new Error(`npm pack returned no archive for ${packageName}@${version}.`);
  }
  const archivePath = path.isAbsolute(archiveName)
    ? archiveName
    : path.join(destination, archiveName);
  const unpacked = path.join(stagingRoot, packageName.replaceAll("/", "-"));
  await fs.mkdir(unpacked, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", unpacked]);
  return path.join(unpacked, "package");
}

async function ensureTargetPackages(spec, sharpPackage, stagingRoot) {
  const copied = [];
  try {
    for (const packageName of spec.packages) {
      const version = sharpPackage.optionalDependencies?.[packageName];
      if (typeof version !== "string") {
        throw new Error(`Sharp does not declare ${packageName} as an optional dependency.`);
      }
      if (await packageVersion(packageName) === version) {
        continue;
      }
      if (await packageVersion(packageName) !== null) {
        throw new Error(
          `${packageName} is installed at an unexpected version; refusing to overwrite it during release staging.`,
        );
      }
      const source = await packInto(packageName, version, stagingRoot);
      const destination = packagePath(packageName);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.cp(source, destination, { recursive: true });
      copied.push(destination);
    }
  } catch (error) {
    await restoreCopiedPackages(copied);
    throw error;
  }
  return copied;
}

async function restoreCopiedPackages(copied) {
  for (const packagePathToRemove of copied.reverse()) {
    await fs.rm(packagePathToRemove, { recursive: true, force: true });
  }
}

function selectedTargets(args) {
  const requested = new Set();
  if (args.some((arg) => arg === "--mac" || arg === "--macos" || arg === "-m")) {
    requested.add("mac-arm64");
  }
  if (args.some((arg) => arg === "--win" || arg === "--windows" || arg === "-w")) {
    requested.add("win-x64");
  }
  if (args.some((arg) => arg === "--linux" || arg === "-l")) {
    requested.add("linux-x64");
  }
  return requested.size === 0
    ? targetSpecs
    : targetSpecs.filter((spec) => requested.has(spec.id));
}

function forwardedArgs(args) {
  return args.filter((arg) => !platformFlags.has(arg));
}

if (process.platform === "darwin") {
  const sdkRoot = path.resolve(
    process.env.DARKROOM_NEF_SDK_ROOT ?? path.join(os.homedir(), ".darkroom-sdk/nikon-nef"),
  );
  const required = [
    "spike/DarkroomNefSpike.app/Contents/MacOS/nikon-nef-decoder",
    "spike/DarkroomNefSpike.app/Contents/Frameworks/libImgSDK.dylib",
    "spike/DarkroomNefSpike.app/Contents/Frameworks/libRCSigProc.dylib",
    "spike/DarkroomNefSpike.app/Contents/Frameworks/libboost_atomic-clang-darwin150-mt-1_82.dylib",
    "spike/DarkroomNefSpike.app/Contents/Frameworks/libboost_filesystem-clang-darwin150-mt-1_82.dylib",
    "spike/DarkroomNefSpike.app/Contents/Frameworks/libboost_system-clang-darwin150-mt-1_82.dylib",
    "spike/DarkroomNefSpike.app/Contents/Frameworks/libboost_thread-clang-darwin150-mt-1_82.dylib",
    "spike/DarkroomNefSpike.app/Contents/Frameworks/libtbb.dylib",
    "spike/DarkroomNefSpike.app/Contents/Frameworks/libtbbmalloc.dylib",
    "spike/DarkroomNefSpike.app/Contents/Frameworks/Elm.framework/Versions/A/Elm",
    "spike/DarkroomNefSpike.app/Contents/Resources/NKsRGB.icm",
    "spike/DarkroomNefSpike.app/Contents/Resources/prm.bin",
    "Image SDK/Library/Mac/Doc/Third Party Legal Notices.rtf",
  ];
  const missing = required.filter((file) => !existsSync(path.join(sdkRoot, file)));
  if (missing.length) {
    throw new Error(`Nikon NEF release runtime is incomplete:\n${missing.join("\n")}`);
  }
  process.env.DARKROOM_NEF_SDK_FROM = path.relative(rootDir, sdkRoot);
}

const releaseArgs = process.argv.slice(2);
const targets = selectedTargets(releaseArgs);
const sharpPackage = await readJson(sharpPackagePath);
const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "darkroom-sharp-"));
const commonArgs = forwardedArgs(releaseArgs);

try {
  for (const target of targets) {
    const copied = await ensureTargetPackages(target, sharpPackage, stagingRoot);
    try {
      console.log(`Packaging ${target.id} with matching Sharp optional dependencies.`);
      run(builder, [...commonArgs, ...target.args]);
    } finally {
      await restoreCopiedPackages(copied);
    }
  }
} finally {
  await fs.rm(stagingRoot, { recursive: true, force: true });
}
