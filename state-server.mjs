// Tiny localhost-only state server for the jobs dashboard. Serves the generated
// applications/index.html and a /state JSON API backed by job-state.json.
// Never bind anything but 127.0.0.1. Run:  node state-server.mjs
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStore, writeStore, mergeEntry, validatePatch } from "./lib/job-state.mjs";

const PORT = 7777;
const HOST = "127.0.0.1";

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    // Buffer chunks and decode once: a multi-byte character split across two
    // chunks would be mangled by per-chunk toString(). The cap counts bytes.
    const chunks = [];
    let bytes = 0;
    // resolve(null) alongside destroy(): destroy emits neither "end" nor
    // "error", so without it this promise would hang forever.
    req.on("data", (c) => { chunks.push(c); bytes += c.length; if (bytes > 1e6) { req.destroy(); resolve(null); } });
    req.on("error", () => resolve(null));
    req.on("close", () => resolve(null)); // client aborted mid-body
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve(null); } });
  });
}

export function createServer({ statePath, indexPath }) {
  return http.createServer(async (req, res) => {
    // Loopback-only guard: a browser on this machine can be induced to hit
    // 127.0.0.1 from any website (CSRF via no-preflight POST, DNS rebinding
    // with a foreign Host). Reject anything not addressed to loopback.
    const hostname = (req.headers.host || "").replace(/:\d+$/, "");
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      return send(res, 403, { error: "forbidden host" });
    }

    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });

    if (req.method === "GET" && req.url === "/state") return send(res, 200, readStore(statePath));

    if (req.method === "POST" && req.url === "/state") {
      // Require a JSON content-type: cross-origin JSON POSTs then need a CORS
      // preflight, which this server never approves.
      if (!/^application\/json/i.test(req.headers["content-type"] || "")) {
        return send(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object") return send(res, 400, { error: "bad body" });
      let map = readStore(statePath);
      if (body._meta && typeof body._meta === "object") {
        map = { ...map, _meta: { ...map._meta, ...body._meta } };
      } else if (typeof body.url === "string" && /^https?:\/\//.test(body.url) && validatePatch(body.patch)) {
        map = mergeEntry(map, body.url, body.patch);
      } else {
        return send(res, 400, { error: "invalid patch" });
      }
      return send(res, 200, writeStore(statePath, map));
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      try { return send(res, 200, readFileSync(indexPath, "utf8"), "text/html; charset=utf-8"); }
      catch { return send(res, 404, "Dashboard not generated yet. Run: node dashboard.mjs", "text/plain"); }
    }

    send(res, 404, { error: "not found" });
  });
}

// Run directly: start the long-lived server on 127.0.0.1:7777.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const server = createServer({
    statePath: join(dir, "job-state.json"),
    indexPath: join(dir, "applications", "index.html"),
  });
  server.listen(PORT, HOST, () => console.log(`state-server: http://${HOST}:${PORT}/`));
}
