import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const index = arg.indexOf("=");
  if (!arg.startsWith("--") || index < 0) throw new Error("Use --name=value arguments.");
  return [arg.slice(2, index), arg.slice(index + 1)];
}));
if (process.platform !== "linux") throw new Error("Process-tree PSS measurement requires Linux /proc.");
const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "darkroom-desktop-benchmark-"));
const photos = path.join(temporary, "photos");
await mkdir(photos);
const count = Number(options.photos ?? 1000);
const iterations = Number(options.iterations ?? 5);
const originals = (await readdir(path.join(root, "public/demo"))).filter((file) => file.endsWith(".jpg")).sort();
for (let i = 0; i < count; i++) await copyFile(path.join(root, "public/demo", originals[i % originals.length]), path.join(photos, `photo-${String(i).padStart(4, "0")}.jpg`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processes() {
  const items = [];
  for (const id of (await readdir("/proc")).filter((id) => /^\d+$/.test(id))) {
    try {
      const status = await readFile(`/proc/${id}/status`, "utf8");
      items.push({ pid: Number(id), parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]), name: status.match(/^Name:\s+(.+)/m)?.[1] });
    } catch { /* A child may exit while reading /proc. */ }
  }
  return items;
}
async function memory(pid) {
  const items = await processes();
  const tree = new Set([pid]);
  for (let previous = 0; previous !== tree.size;) {
    previous = tree.size;
    for (const item of items) if (tree.has(item.parent)) tree.add(item.pid);
  }
  let pssKiB = 0, rssKiB = 0, processCount = 0;
  for (const id of tree) {
    try {
      const status = await readFile(`/proc/${id}/smaps_rollup`, "utf8");
      pssKiB += Number(status.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0);
      rssKiB += Number(status.match(/^Rss:\s+(\d+)/m)?.[1] ?? 0);
      processCount++;
    } catch { /* Ignore processes that exited during the snapshot. */ }
  }
  return { pssKiB, rssKiB, processCount };
}

async function launchElectron(profile) {
  const baseline = path.resolve(options["electron-root"]);
  const { _electron } = await import(pathToFileURL(path.join(baseline, "node_modules/playwright/index.mjs")).href);
  const launcher = path.join(temporary, "electron-launcher.cjs");
  await writeFile(launcher, `const {app}=require("electron");app.setPath('userData',process.env.DARKROOM_USER_DATA);Object.defineProperty(app,'isPackaged',{value:true});require(${JSON.stringify(path.join(baseline, "electron-dist/main.js"))});`);
  const env = { ...process.env, DARKROOM_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = performance.now();
  const app = await _electron.launch({ executablePath: path.join(baseline, "node_modules/electron/dist/electron"), args: ["--ozone-platform=x11", launcher], env });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, photos);
  return { started, pid: app.process().pid, evaluate: (script) => page.evaluate(`(${script})()`), close: () => app.close() };
}

async function launchRust(profile) {
  const port = Number(options.port ?? 4455);
  const args = ["--port", String(port), "--native-port", String(port + 1)];
  if (options["native-driver"]) args.push("--native-driver", options["native-driver"]);
  const driver = spawn(options.driver ?? "tauri-driver", args, { env: { ...process.env, DARKROOM_USER_DATA: profile, DARKROOM_SMOKE_PHOTOS: photos }, stdio: ["ignore", "ignore", "pipe"] });
  driver.stderr.on("data", (data) => process.stderr.write(data));
  const url = `http://127.0.0.1:${port}`;
  async function request(route, body, method = "POST") {
    const response = await fetch(url + route, { method, signal: AbortSignal.timeout(120000), headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
    return result.value;
  }
  let session;
  try {
    for (let i = 0; ; i++) {
      try { await fetch(url + "/status"); break; }
      catch { if (i >= 100 || driver.exitCode !== null) throw new Error("tauri-driver did not start."); await sleep(50); }
    }
    const started = performance.now();
    session = (await request("/session", { capabilities: { alwaysMatch: { "tauri:options": { application: path.resolve(options.binary ?? "src-tauri/target/release/darkroom") } } } })).sessionId;
    await request(`/session/${session}/timeouts`, { script: 110000 });
    const items = await processes();
    const descendants = new Set([driver.pid]);
    for (let i = 0; i < 4; i++) for (const item of items) if (descendants.has(item.parent)) descendants.add(item.pid);
    const app = items.find((item) => descendants.has(item.pid) && item.name === "darkroom");
    if (!app) throw new Error("Cannot identify the native app process.");
    return {
      started, pid: app.pid,
      evaluate: async (script) => {
        const result = await request(`/session/${session}/execute/async`, { script: `const done=arguments[arguments.length-1];Promise.resolve().then(async()=>(${script})()).then(value=>done({value}),error=>done({failure:String(error)}));`, args: [] });
        if (result.failure) throw new Error(result.failure);
        return result.value;
      },
      close: async () => { await request(`/session/${session}`, undefined, "DELETE").finally(() => driver.kill()); },
    };
  } catch (error) {
    if (session) await request(`/session/${session}`, undefined, "DELETE").catch(() => {});
    driver.kill();
    throw error;
  }
}

const runs = [];
for (let i = 0; i < iterations; i++) {
  const profile = path.join(temporary, `profile-${i}`);
  await mkdir(profile);
  const app = await (options["electron-root"] ? launchElectron(profile) : launchRust(profile));
  try {
    await app.evaluate(`async()=>{for(let i=0;i<3000;i++){if(window.darkroom&&document.querySelector('button'))return;await new Promise(r=>setTimeout(r,10));}throw Error('UI did not load');}`);
    const startupMs = performance.now() - app.started;
    await sleep(1000);
    const idleMemory = await memory(app.pid);
    const library = await app.evaluate(`async()=>{
      const started=performance.now();
      const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Import folder');
      if(!button)throw Error('Import button unavailable');button.click();
      for(let i=0;i<1000&&!document.querySelector('input[aria-label="New catalog name"]');i++)await new Promise(r=>setTimeout(r,10));
      const name=document.querySelector('input[aria-label="New catalog name"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(name,'Benchmark');name.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,20));
      const create=[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='Create');
      if(!create||create.disabled)throw Error('Create button unavailable');create.click();
      for(let i=0;i<10000;i++){if(document.body.innerText.includes('${count.toLocaleString("en-US")} photos')||document.body.innerText.includes('${count} photos'))break;if(i===9999)throw Error(document.body.innerText);await new Promise(r=>setTimeout(r,10));}
      const importMs=performance.now()-started;
      const close=[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='Close');close?.click();
      const bootstrap=await window.darkroom.catalogBootstrap();const session=bootstrap.session;
      const queryTimes=[];let assets=0;
      for(let i=0;i<20;i++){const t=performance.now();const result=await window.darkroom.catalogQuery({...session,expectedRevision:null});queryTimes.push(performance.now()-t);assets=result.assets?.length??result.state?.assets?.length??0;}
      return {importMs,queryTimes,assets};
    }`);
    if (library.assets !== count) throw new Error(`Expected ${count} catalog assets, received ${library.assets}.`);
    await sleep(2000);
    runs.push({ startupMs, idleMemory, ...library, libraryMemory: await memory(app.pid) });
    console.log(JSON.stringify(runs.at(-1)));
  } finally { await app.close(); }
}
const output = { backend: options["electron-root"] ? "Electron baseline" : "Rust/Tauri", measuredAt: new Date().toISOString(), environment: { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0].model, node: process.version, display: process.env.DISPLAY, wayland: process.env.WAYLAND_DISPLAY ?? null }, method: { photos: count, iterations, viewport: "default 1440 x 900 window", startup: "automation launch to desktop bridge and first button; different driver overheads", memory: "sum of process-tree /proc/smaps_rollup PSS; 1 s idle and 2 s after import/query", import: "click Import folder until library count is visible", queries: "20 complete catalog snapshots including IPC; no revision cache", temporary }, runs };
await writeFile(options.output ?? path.join(temporary, "results.json"), JSON.stringify(output, null, 2) + "\n");
