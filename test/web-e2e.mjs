// node test/web-e2e.mjs — a website through the real session: eye_drive {url} opens test/fixtures/page.html (served over
// http like a dev server) in the eye's own browser, the real hand presses things found IN THE PAGE (el:"…" tap), types
// into a field, and the reply must carry what the page did and said: the CSS transition as declared and as it ran, the
// script that blocked the main thread by name, the console error and the exception, the typed value.
// TAKES THE REAL INPUT LOCK for a few seconds (countdown, orange overlay; Esc ×6 releases).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const server = createServer((req, res) => {
  if (req.url !== "/") { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html" }); res.end(readFileSync(join(ROOT, "test", "fixtures", "page.html")));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const client = new Client({ name: "web-e2e", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(ROOT, "src", "index.ts")] }));
const call = async (name, args) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const t = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)}${r.isError ? "  [ERROR]" : ""} (${Date.now() - t0}ms)\n${t}`);
  return { t, err: !!r.isError };
};
let failed = 0;
const want = (what, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

try {
  const a = await call("eye_drive", { url, viewport: { w: 900, h: 600 }, label: "web-e2e",
    wing: 'el:"Move the box" tap settle el:"Block" tap settle el:"Break" tap rest 200',
    steps: [{ op: "type", text: "Ada", on: "Your name" }, { op: "assert", js: "document.getElementById('name').value === 'Ada'" },
      { op: "wait_until", js: "document.getElementById('box').classList.contains('moved')", timeout_ms: 500 }],
    end: true });
  want("the session opened on the page and ran", !a.err && /SESSION ENDED/.test(a.t));
  want("the real hand pressed the button found in the page", /button #move "Move the box"/.test(a.t));
  want("the typed value is there (assert js held)", !/not satisfied/.test(a.t) && /typed 3 characters into #name/.test(a.t));
  want("FROM INSIDE THE PAGE: the CSS transition as declared", /FROM INSIDE THE PAGE[\s\S]*CSS transition on transform[\s\S]*0\.3s ease-out/.test(a.t));
  want("…and it ran as declared", /✓ it ran as declared/.test(a.t));
  want("the block is named: blockMainThread", /blockMainThread 127\.0\.0\.1:\d+:25 ran 2\d\dms/.test(a.t));
  want("the page said the error and the exception", /console\.error: fixture went wrong/.test(a.t) && /uncaught Error: fixture exploded/.test(a.t));
  want("the viewer saw the freeze and why", /why:|main thread was blocked/.test(a.t));
} catch (e) {
  want(`no exception: ${e.stack}`, false);
} finally {
  await call("eye_drive", { url, quit: true }).catch(() => {});
  await client.close();
  server.close();
}
console.log(failed ? `${failed} FAILED` : "all ok");
process.exit(failed ? 1 : 0);
