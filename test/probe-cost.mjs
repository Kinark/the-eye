// node test/probe-cost.mjs ['<process>'] — what the probe costs the app under test: the same open / close of the Nook
// in four sessions (no probe · the probe watching a few layers · the probe walking every layer · no probe again),
// first lines of each report side by side. Compare the fps and the frame gaps between the modes.
// TAKES THE REAL INPUT LOCK for each session (Esc ×6 releases).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [proc = "NOOTCH!-Dev"] = process.argv.slice(2);
const client = new Client({ name: "probe-cost", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return (r.isError ? "ERROR: " : "") + r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
const log = (h, s) => console.log(`== ${h}\n${s}`);
const watch = ["PublicGlassHostView", "NSGlassEffectView", "CABackdropLayer", "DropAreaView"];
const probe = { none: false, focus: { watch }, full: { watch, full_walk: true } };

try {
  for (const mode of ["none", "focus", "full", "none"]) {
    const r = await call("eye_drive", { app: proc, rect: { x: 400, y: 0, w: 712, h: 240 }, label: `cost-${mode}`, probe: probe[mode], frames: false, events: false, end: true, steps: [
      { op: "move", x: 756, y: 14, ms: 250 }, { op: "wait", ms: 500 }, { op: "click" }, { op: "wait", ms: 1500 },
      { op: "move", x: 756, y: 600, ms: 250 }, { op: "wait", ms: 1500 },
    ] });
    const at = r.indexOf("WHAT IT LOOKED LIKE"), inside = r.indexOf("FROM INSIDE THE APP");
    log(`mode ${mode}`, at < 0 ? r : r.slice(at).split("\n").slice(0, 8).join("\n"));
    if (inside >= 0) log(`mode ${mode}, from inside`, r.slice(inside).split("\n").slice(0, 8).join("\n"));
  }
} catch (e) {
  log("FAILED", e.message);
} finally {
  await client.close();
}
