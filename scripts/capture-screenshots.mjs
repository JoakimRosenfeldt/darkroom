import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUTPUT_DIR =
  process.env.SCREENSHOT_DIR ?? "/opt/cursor/artifacts/screenshots";

const DEMO_FILES = [
  "mountain-dawn.jpg",
  "coastal-light.jpg",
  "forest-path.jpg",
  "city-night.jpg",
  "desert-glow.jpg",
  "lake-reflection.jpg",
];

async function waitForServer(url, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server not ready at ${url}`);
}

async function mockDirectoryPicker(page) {
  await page.addInitScript((files) => {
    const demoFiles = files;

    function createFileHandle(name) {
      return {
        kind: "file",
        name,
        async getFile() {
          const response = await fetch(`/demo/${name}`);
          const blob = await response.blob();
          return new File([blob], name, {
            type: blob.type || "image/jpeg",
            lastModified: Date.now() - demoFiles.indexOf(name) * 60_000,
          });
        },
      };
    }

    window.showDirectoryPicker = async () => {
      const handles = demoFiles.map((name) => createFileHandle(name));
      return {
        name: "Summer Trip 2025",
        async *values() {
          for (const handle of handles) {
            yield handle;
          }
        },
        async *entries() {
          for (const handle of handles) {
            yield [handle.name, handle];
          }
        },
        async *keys() {
          for (const handle of handles) {
            yield handle.name;
          }
        },
        async queryPermission() {
          return "granted";
        },
        async requestPermission() {
          return "granted";
        },
      };
    };
  }, DEMO_FILES);
}

async function capture(page, name) {
  const filePath = path.join(OUTPUT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`Saved ${filePath}`);
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await waitForServer(BASE_URL);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  await mockDirectoryPicker(page);

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await capture(page, "01-home-empty");

  await page.getByRole("button", { name: "Import" }).click();
  await page.waitForFunction(
    () => document.body.textContent?.includes("6 photos"),
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(3000);
  await capture(page, "02-library-grid");

  await page.locator('a[href^="/photo?id="]').first().click();
  await page.waitForSelector("text=Decoding image...", { state: "hidden", timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await capture(page, "03-photo-detail");

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
