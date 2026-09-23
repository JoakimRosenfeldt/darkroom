import { spawn } from "node:child_process";
import path from "node:path";

const binary = path.resolve("src-tauri/target/release", process.platform === "win32" ? "darkroom.exe" : "darkroom");
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
child.on("error", (error) => {
  console.error(`Could not start Darkroom. Run npm run build first. ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
