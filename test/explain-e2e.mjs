// End-to-end: capture + Instruments + cursor/AX + labeled eye_act phases → eye_report.
// usage: node test/explain-e2e.mjs <process-name> [label]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const proc = process.argv[2] ?? "NOOTCH!";
const label = process.argv[3] ?? "explain-e2e";
const client = new Client({ name: "e2e", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const call = async (name, a = {}) => (await client.callTool({ name, arguments: a }, undefined, { timeout: 300_000 })).content.map((c) => c.text).join("\n");
const cx = 756, zone = [{ x: cx - 140, y: 0, w: 280, h: 70 }];
const act = async (lbl, steps) => {
  const r = await call("eye_act", { label: lbl, steps, scroll_zones: zone });
  const stop = r.match(/STOPPED — (.*)/);
  console.log(`${lbl}: ${stop ? "STOPPED " + stop[1] : "ok"}`);
  if (stop) throw new Error(stop[1]);
  return r;
};
console.log(await call("eye_lock", { seconds: 120 }));
await call("eye_act", { steps: [{ op: "move", x: cx, y: 420, ms: 200 }, { op: "wait", ms: 1500 }] });
console.log(await call("eye_record", { rect: { x: 356, y: 0, w: 800, h: 300 }, label, max_seconds: 120, profile: { process: proc }, ax_hz: Number(process.env.AX_HZ ?? 4) }));
try {
  await act("settle", [{ op: "wait", ms: 600 }, { op: "assert", expr: "!a || a.h < 30" }]);
  for (let round = 1; round <= 2; round++) {
    await act("click-open", [{ op: "move", x: cx, y: 12, ms: 350 }, { op: "wait", ms: 200 }, { op: "click" },
      { op: "wait_until", expr: "a && a.w > 250 && a.h > 70", timeout_ms: 2000 }, { op: "wait", ms: 500 }]);
    const g = "a && a.w > 250";
    await act("hover-sweep", [{ op: "move", x: 440, y: 40, ms: 400, guard: g }, { op: "move", x: 1070, y: 40, ms: 1200, guard: g },
      { op: "move", x: 1040, y: 56, ms: 250, guard: g }, { op: "move", x: 440, y: 56, ms: 1200, guard: g }]);
    const sc = [];
    for (const x of [580, 640, 700, 760]) sc.push({ op: "move", x, y: 56, ms: 120, guard: g }, { op: "scroll", dy: round % 2 ? 6 : -6, events: 20, guard: g }, { op: "wait", ms: 200 });
    await act("notes-scrolls", sc);
    await act("unhover-close", [{ op: "move", x: cx, y: 290, ms: 300 }, { op: "wait_until", expr: "!a || a.h < 45", timeout_ms: 2500 }, { op: "wait", ms: 500 }]);
    await act("scrub-open", [{ op: "move", x: cx, y: 14, ms: 300 }, { op: "wait", ms: 400 }, { op: "scroll", dy: 5, events: 80 },
      { op: "wait_until", expr: "a && a.w > 250 && a.h > 70", timeout_ms: 2000 }, { op: "wait", ms: 500 }]);
    await act("scrub-close", [{ op: "scroll", dy: -5, events: 80 }, { op: "wait", ms: 400 }, { op: "move", x: cx, y: 420, ms: 300 },
      { op: "wait_until", expr: "!a || a.h < 45", timeout_ms: 2500 }, { op: "wait", ms: 500 }]);
  }
} catch (e) { console.log("probe stopped:", e.message); }
console.log(await call("eye_lock", { release: true }));
const rep = await call("eye_stop");
console.log(rep.split("\n").filter((l) => /WHILE|profile|csv:/.test(l)).join("\n"));
const csv = rep.match(/csv: (.*)/)?.[1];
console.log("\n" + await call("eye_report", { csv, view: "explain", top: 8 }));
await client.close();
