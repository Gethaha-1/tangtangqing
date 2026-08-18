import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const target = resolve(root, "public", "ledger");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(resolve(root, "legacy", "ledger.html"), resolve(target, "index.html"));
await cp(resolve(root, "src", "domain.js"), resolve(target, "domain.js"));
await cp(resolve(root, "src", "cloud-sync.js"), resolve(target, "cloud-sync.js"));
await cp(resolve(root, "src", "auth-client.js"), resolve(target, "auth-client.js"));
await cp(resolve(root, "src", "ui-transition.js"), resolve(target, "ui-transition.js"));
