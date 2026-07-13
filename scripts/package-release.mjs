import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  process.env.DARKROOM_NEF_SDK_FROM = path.relative(process.cwd(), sdkRoot);
}

const builder = path.join(
  process.cwd(),
  "node_modules/.bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
);
const result = spawnSync(builder, process.argv.slice(2), { env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
