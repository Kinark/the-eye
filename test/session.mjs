// A the-eye server kept alive between shell commands, so a session (and two fingers left on the trackpad) can be
// played turn by turn from a terminal or by an agent whose own MCP connection runs older code.
//   bun test/session.mjs serve [dir]            start the server and wait for calls (run it in the background)
//   bun test/session.mjs call <tool> '<json>'   one call: prints the text, saves each image and prints its path
//   bun test/session.mjs stop                   end the open session and the server
// A session with a hand TAKES THE REAL INPUT LOCK (Esc ×6 releases).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [mode, a, b] = process.argv.slice(2);
const dir = process.env.EYE_SESSION_DIR ?? join(tmpdir(), "eye-session");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(dir, { recursive: true });

if (mode === "serve") {
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  const client = new Client({ name: "session", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../src/index.ts", import.meta.url).pathname], env: process.env }));
  writeFileSync(join(dir, "ready"), String(process.pid));
  let idle = Date.now();
  for (;;) {
    const req = readdirSync(dir).filter((f) => f.endsWith(".req.json")).sort()[0];
    if (!req) {
      if (Date.now() - idle > 15 * 60_000) break; // nobody is playing any more
      await sleep(15);
      continue;
    }
    idle = Date.now();
    const id = req.replace(".req.json", "");
    const { tool, args } = JSON.parse(readFileSync(join(dir, req), "utf8"));
    rmSync(join(dir, req));
    if (tool === "__stop") { writeFileSync(join(dir, `${id}.res.json`), JSON.stringify({ text: "stopped" })); break; }
    const t0 = Date.now();
    let res;
    try {
      const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 700_000 });
      const images = [];
      r.content.forEach((c, i) => {
        if (c.type !== "image") return;
        const f = join(dir, `${id}_${i}.${c.mimeType === "image/png" ? "png" : "jpg"}`);
        writeFileSync(f, Buffer.from(c.data, "base64"));
        images.push(f);
      });
      res = { text: (r.isError ? "ERROR: " : "") + r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), images, ms: Date.now() - t0 };
    } catch (e) { res = { text: `CALL FAILED: ${e.message}`, images: [], ms: Date.now() - t0 }; }
    writeFileSync(join(dir, `${id}.tmp`), JSON.stringify(res));
    renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.res.json`));
  }
  try { await client.callTool({ name: "eye_drive", arguments: { end: true } }, undefined, { timeout: 60_000 }); } catch { /* none open */ }
  await client.close();
  rmSync(join(dir, "ready"), { force: true });
  process.exit(0);
}

if (!existsSync(join(dir, "ready"))) { console.log(`no server: bun test/session.mjs serve & (looked in ${dir})`); process.exit(1); }
const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
writeFileSync(join(dir, `${id}.tmp`), JSON.stringify(mode === "stop" ? { tool: "__stop" } : { tool: a, args: JSON.parse(b ?? "{}") }));
renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.req.json`));
const out = join(dir, `${id}.res.json`);
for (const end = Date.now() + 720_000; !existsSync(out) && Date.now() < end; ) await sleep(10);
if (!existsSync(out)) { console.log("no answer"); process.exit(1); }
const r = JSON.parse(readFileSync(out, "utf8"));
console.log(r.text);
for (const f of r.images ?? []) console.log(`[image] ${f}`);
if (r.ms !== undefined) console.log(`(${r.ms}ms)`);
