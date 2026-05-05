import { mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const siteDir = path.join(repoRoot, "site");

const copyWebFile = async (filename) => {
  const sourcePath = path.join(repoRoot, "web", filename);
  const targetPath = path.join(siteDir, filename);
  let content = await readFile(sourcePath, "utf8");
  content = content.replaceAll("../dist/browser.js", "./dist/browser.js");
  await writeFile(targetPath, content, "utf8");
};

await rm(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });

await cp(path.join(repoRoot, "dist"), path.join(siteDir, "dist"), {
  recursive: true
});

await copyWebFile("index.html");
await copyWebFile("app.js");
await copyWebFile("styles.css");
await copyWebFile("solver-worker.js");
await writeFile(path.join(siteDir, ".nojekyll"), "", "utf8");

process.stdout.write(`Prepared GitHub Pages site in ${siteDir}\n`);
