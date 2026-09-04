import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  ledgerAssetPairs,
  prepareLedgerAssets,
} from "./prepare-ledger-assets.mjs";

// This command is the isolated UI-development entry point. It intentionally
// ignores cloud credentials and selects the fixed local-only principal plus
// SQLite before Next.js starts. auth-edge still rejects this principal unless
// the request is development traffic to a loopback hostname.
process.env.TTQ_AUTH_MODE = "local";
process.env.TTQ_DATABASE_MODE = "sqlite";
process.env.TTQ_LOCAL_AUTO_SIGNIN = "1";
process.env.TTQ_INTERNAL_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.NETLIFY = "false";

await prepareLedgerAssets();

const assetsByDirectory = new Map();
for (const pair of ledgerAssetPairs) {
  const directory = dirname(pair[0]);
  const pairs = assetsByDirectory.get(directory) ?? [];
  pairs.push(pair);
  assetsByDirectory.set(directory, pairs);
}
let copyQueue = Promise.resolve();
for (const [directory, pairs] of assetsByDirectory) {
  watch(directory, (_event, filename) => {
    const pair = pairs.find(([source]) => basename(source) === filename);
    if (!pair) return;
    copyQueue = copyQueue
      .then(() => copyFile(pair[0], pair[1]))
      .then(() => console.log(`[dev:local] 已更新 ${basename(pair[1])}`))
      .catch((error) => console.error("[dev:local] 账本资源更新失败", error));
  });
}

process.argv.splice(2, 0, "dev");
await import("next/dist/bin/next");
