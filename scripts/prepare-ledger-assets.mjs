import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const target = resolve(root, "public", "ledger");

export const ledgerAssetPairs = [
  [resolve(root, "legacy", "ledger.html"), resolve(target, "index.html")],
  [resolve(root, "src", "domain.js"), resolve(target, "domain.js")],
  [resolve(root, "src", "cloud-sync.js"), resolve(target, "cloud-sync.js")],
  [resolve(root, "src", "auth-client.js"), resolve(target, "auth-client.js")],
  [resolve(root, "src", "ui-transition.js"), resolve(target, "ui-transition.js")],
  [resolve(root, "src", "draft-store.js"), resolve(target, "draft-store.js")],
  [resolve(root, "src", "recovery-client.js"), resolve(target, "recovery-client.js")],
  [resolve(root, "src", "location-client.js"), resolve(target, "location-client.js")],
];

export async function prepareLedgerAssets() {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await Promise.all(
    ledgerAssetPairs.map(([source, destination]) => cp(source, destination)),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareLedgerAssets();
}
