// bun test/nootch-see.mjs ['<process>'] — the whole reflex layer against the real thing, in one session on NOOTCH!:
// the probe goes in by itself, the hand hovers the notch, opens the Nook, the Nook is looked at standing still, and it
// closes. Prints everything the-eye says unasked: what the screen showed (moved by, what a viewer would notice), what
// the open Nook reads like at rest (text sizes, contrast, alignment, corner shape), and from inside the app what each
// layer did and what its code declared. Asserts nothing.
// TAKES THE REAL INPUT LOCK for the hover / open / close (Esc ×6 releases).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [proc = "NOOTCH!-Dev"] = process.argv.slice(2);
const client = new Client({ name: "nootch-see", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../src/index.ts", import.meta.url).pathname], env: process.env }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const imgs = r.content.filter((c) => c.type === "image").length;
  return (r.isError ? "ERROR: " : "") + r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") + (imgs ? `\n[${imgs} frame${imgs === 1 ? "" : "s"} came with it]` : "");
};
const log = (h, s) => console.log(`\n== ${h}\n${s}`);

const status = await call("eye_status");
const d = JSON.parse(status.split("\n")[0]).displays.find((x) => x.main).points;
const cx = d.w / 2; // the notch sits at the top centre of the built-in display
// The notch window is small until the Nook opens: the session watches the strip the Nook opens into.
const rect = { x: Math.round(cx - 400), y: 0, w: 800, h: 320 };
let open = false;
try {
  const hover = await call("eye_drive", { app: proc, rect, label: "nootch-see", probe: { watch: ["PublicGlassHostView", "DropAreaView"] }, steps: [
    { op: "move", x: cx, y: 500, ms: 100 }, { op: "wait", ms: 300 }, { op: "move", x: cx, y: 14, ms: 250 },
    { op: "move", x: cx + 8, y: 16, ms: 120 }, { op: "move", x: cx, y: 14, ms: 120 }, { op: "wait", ms: 1400 },
  ] });
  log("open the session, hover", hover);
  open = !hover.startsWith("ERROR");
  if (open) {
    log("open the Nook", await call("eye_drive", { steps: [{ op: "click", x: cx, y: 14 }, { op: "wait", ms: 1800 }] }));
    log("at rest, open", await call("eye_snapshot", { rect, measure: true }));
    log("close, and the report", await call("eye_drive", { steps: [{ op: "move", x: cx, y: 620, ms: 300 }, { op: "wait", ms: 1800 }], end: true }));
    open = false;
  }
} catch (e) {
  log("FAILED", e.message);
} finally {
  if (open) log("end", await call("eye_drive", { end: true }));
  await client.close();
}
