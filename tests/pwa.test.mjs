import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import manifest from "../app/manifest.ts";

const root = process.cwd();

async function pngDimensions(relativePath) {
  const bytes = await readFile(join(root, relativePath));
  assert.deepEqual(
    Array.from(bytes.subarray(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${relativePath} must be a PNG`,
  );
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

test("mobile install manifest launches the protected ledger with valid icons", async () => {
  const value = manifest();
  assert.equal(value.id, "/ledger");
  assert.equal(value.start_url, "/ledger");
  assert.equal(value.scope, "/");
  assert.equal(value.display, "standalone");
  assert.equal(value.prefer_related_applications, false);

  const icons = value.icons ?? [];
  assert.ok(icons.some((icon) => icon.sizes === "192x192" && icon.type === "image/png"));
  assert.ok(icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "any"));
  assert.ok(icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));
  assert.deepEqual(await pngDimensions("public/icons/ttq-192.png"), {
    width: 192,
    height: 192,
  });
  assert.deepEqual(await pngDimensions("public/icons/ttq-512.png"), {
    width: 512,
    height: 512,
  });
  assert.deepEqual(await pngDimensions("public/icons/ttq-180.png"), {
    width: 180,
    height: 180,
  });
});

test("the standalone ledger exposes install metadata without caching auth data", async () => {
  const html = await readFile(join(root, "legacy/ledger.html"), "utf8");
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" sizes="180x180"/);
  assert.match(html, /data-go="install" role="button" tabindex="0"/);
  assert.match(html, /beforeinstallprompt/);
  assert.doesNotMatch(html, /serviceWorker\.register/);
});
