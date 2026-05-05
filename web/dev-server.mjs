import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const requested = urlPath === "/" ? "/web/index.html" : urlPath;
  const filePath = path.join(root, requested);

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  let finalPath = filePath;
  if (fs.existsSync(finalPath) && fs.statSync(finalPath).isDirectory()) {
    finalPath = path.join(finalPath, "index.html");
  }

  if (!fs.existsSync(finalPath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(finalPath).toLowerCase();
  res.writeHead(200, { "Content-Type": mimeTypes[ext] ?? "application/octet-stream" });
  fs.createReadStream(finalPath).pipe(res);
});

server.listen(4173, "127.0.0.1", () => {
  console.log("Server running at http://127.0.0.1:4173/web/");
});
