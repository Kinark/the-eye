// node test/probe-cost.mjs '<process>' — A/B the probe's cost on the target: open + close the Nook three times
// (no probe / focus probe / full-walk probe) under one capture each, and compare on-screen fps.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [proc = "NOOTCH! AppStore"] = process.argv.slice(2);
const client = new Client({ name: "probe-cost", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return (r.isError ? "ERROR: " : "") + r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
const log = (h, s) => console.log(`== ${h}\n${s}`);
const watch = ["PublicGlassHostView", "NSGlassEffectView", "CABackdropLayer", "DropAreaView"];

try {
  log("attach", await call("eye_probe_attach", { process: proc }));
  log("lock", await call("eye_lock_input", { seconds: 120, strict: true }));
  for (const mode of ["none", "focus", "full", "none"]) {
    log(`mode ${mode} capture`, await call("eye_start", { rect: { x: 400, y: 0, w: 712, h: 240 }, label: `cost-${mode}`, max_seconds: 30, cursor: false }));
    if (mode !== "none") log("probe", await call("eye_probe_start", { process: proc, label: mode, max_seconds: 30, watch, full_walk: mode === "full" }));
    log("open", await call("eye_act", { target_process: proc, label: "open", steps: [
      { op: "move", x: 756, y: 14, ms: 250 }, { op: "wait", ms: 500 }, { op: "click" }, { op: "wait", ms: 1500 },
    ] }));
    log("close", await call("eye_act", { target_process: proc, label: "close", steps: [
      { op: "move", x: 756, y: 600, ms: 250 }, { op: "wait", ms: 1500 },
    ] }));
    const cap = await call("eye_stop");
    log(`mode ${mode} capture report`, cap.split("\n").slice(0, 8).join("\n"));
    if (mode !== "none") log(`mode ${mode} probe report`, (await call("eye_probe_stop", { top: 4 })).split("\n").slice(0, 8).join("\n"));
  }
} catch (e) {
  log("FAILED", e.message);
} finally {
  log("unlock", await call("eye_unlock"));
  await client.close();
}
