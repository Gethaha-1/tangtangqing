import { readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const publishDir = resolve(root, ".netlify", "static");
const functionsDir = resolve(root, ".netlify", "functions-internal");

async function requireDirectory(path, label) {
  let value;
  try {
    value = await stat(path);
  } catch {
    throw new Error(`${label} 不存在；请先运行 npm run build:netlify`);
  }
  if (!value.isDirectory()) throw new Error(`${label} 不是目录`);
}

async function rejectSensitiveFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const forbidden = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) =>
      name === ".env" ||
      name.startsWith(".env.") ||
      name === ".ttq-local.env" ||
      name.endsWith(".crt") ||
      name.endsWith(".pem"),
    );
  if (forbidden.length) throw new Error("部署产物包含禁止上传的本机配置或证书文件");
}

await Promise.all([
  requireDirectory(publishDir, "Netlify 静态发布目录"),
  requireDirectory(functionsDir, "Netlify 函数目录"),
]);
await Promise.all([
  rejectSensitiveFiles(publishDir),
  rejectSensitiveFiles(functionsDir),
]);

await writeFile(
  resolve(publishDir, "_redirects"),
  [
    "/_next/image  /.netlify/images?url=:url&w=:width&q=:quality  200",
    "/_ipx/*  /.netlify/images?url=:url&w=:width&q=:quality  200",
    "/_next/image  /.netlify/images  200",
    "",
  ].join("\n"),
  "utf8",
);
await writeFile(
  resolve(publishDir, "_headers"),
  "/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable\n",
  "utf8",
);

console.log("Netlify 手动部署目录已核对：公开静态文件、Node 函数及缓存规则齐全。");
