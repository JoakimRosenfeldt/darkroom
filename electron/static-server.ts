import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function resolveRequestPath(outDir: string, requestUrl: string): string | null {
  const url = new URL(requestUrl, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/") {
    return path.join(outDir, "index.html");
  }

  const directPath = path.join(outDir, pathname);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return directPath;
  }

  const htmlPath = path.join(outDir, `${pathname.replace(/^\//, "")}.html`);
  if (fs.existsSync(htmlPath) && fs.statSync(htmlPath).isFile()) {
    return htmlPath;
  }

  const indexPath = path.join(outDir, pathname, "index.html");
  if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
    return indexPath;
  }

  return null;
}

export function startStaticServer(outDir: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }

      const filePath = resolveRequestPath(outDir, req.url);
      if (!filePath) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to start static server"));
        return;
      }
      resolve(address.port);
    });
  });
}

export function getOutDir(appRoot: string): string {
  return path.join(appRoot, "out");
}

export function getAppRoot(): string {
  return path.resolve(__dirname, "..");
}

export function toFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}
