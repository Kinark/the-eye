#!/usr/bin/env bun
// `bun run show-off`: serves the show-off page. No dependencies, no build step.
// The page runs the-eye's own fitter and corner reader: /lib/*.js is src/*.ts with the types stripped, on request.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const strip = new Bun.Transpiler({ loader: "ts" });
const LIB = new Set(["physics", "still"]); // pure maths, no imports: safe to hand to a browser as is
const CHAPTERS = ["wing", "fingers", "steps", "web", "reply", "session", "measure"]; // the same names as CHAPTERS in src/guide.ts
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function respond(url) {
  const path = decodeURIComponent(new URL(url, "http://x").pathname);
  if (path === "/config.json") {
    // The manual's chapters as they are on disk right now: the page prints what each one costs an agent to read.
    const manual = {};
    for (const name of CHAPTERS) manual[name] = (await readFile(join(repo, "skills", "the-eye", `${name}.md`), "utf8").catch(() => "")).length;
    return [200, TYPES[".json"], JSON.stringify({ repo, bun: Bun.version, manual })];
  }
  const lib = path.match(/^\/lib\/(\w+)\.js$/);
  if (lib && LIB.has(lib[1])) {
    const ts = await readFile(join(repo, "src", `${lib[1]}.ts`), "utf8");
    return [200, TYPES[".js"], strip.transformSync(ts)];
  }
  const file = normalize(join(here, path === "/" ? "index.html" : path));
  if (file !== here && !file.startsWith(here + sep)) return [403, TYPES[".txt"], "outside the site"];
  const type = TYPES[extname(file)];
  if (!type || file.endsWith("serve.mjs") || file.endsWith("extract.mjs")) return [404, TYPES[".txt"], "not found"];
  return [200, type, await readFile(file)];
}

const server = createServer(async (req, res) => {
  let out;
  try { out = await respond(req.url ?? "/"); }
  catch (e) { out = e?.code === "ENOENT" || e?.code === "EISDIR" ? [404, TYPES[".txt"], "not found"] : [500, TYPES[".txt"], String(e?.message ?? e)]; }
  res.writeHead(out[0], { "content-type": out[1], "cache-control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : out[2]);
});

const want = Number(process.env.PORT) || 4173;
let port = want;
server.on("error", (e) => {
  // Someone else has the port: take the next one rather than fail, unless the port was asked for by name.
  if (e.code === "EADDRINUSE" && !process.env.PORT && port < want + 20) server.listen(++port, "127.0.0.1");
  else { console.error(`the-eye show-off: cannot listen on ${port}: ${e.message}`); process.exit(1); }
});
server.on("listening", () => {
  const url = `http://localhost:${port}/`;
  console.log(`the-eye show-off  →  ${url}   (Ctrl+C to stop · SHOW_OFF_OPEN=0 to not open a browser · PORT=n to choose the port)`);
  if (process.env.SHOW_OFF_OPEN !== "0" && process.platform === "darwin") spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true }).unref();
});
server.listen(port, "127.0.0.1");
