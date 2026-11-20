// node test/notice.mjs — the perception layer on synthetic recordings (no screen, no input). Each case writes a
// frames.csv the way eye-capture would and checks what a viewer is told they would have noticed.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, loadRun } from "../src/analyze.ts";
import { formatSeen, notice } from "../src/notice.ts";

const HZ = 120, P = 1 / HZ;
let failed = 0;

/** frames: [{dt (refreshes since the previous new image), w, luma?, frac?}] → a run dir. */
function run(name, frames, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), `eye-notice-${name}-`));
  const L = ["t,status,interval_ms,diff,changed_frac,mean_luma,bbox_x0,bbox_y0,bbox_x1,bbox_y1,bbox_w,bbox_h,anch_w,anch_h,anch_cx"];
  let t = 0;
  // A capture always opens with one image of the region as it stands (extra.noImage: a recording that got none).
  if (!extra.noImage) L.push("0.00000,c,0.000,0.000,0.00000,100,0,0,0,0,0,0,0,0,0");
  for (let i = 0; i < 30; i++) { t += P; L.push(`${t.toFixed(5)},i,,,,,,,,,,,,,`); } // a still lead-in
  for (const f of frames) {
    t += (f.dt ?? 1) * P;
    L.push(`${t.toFixed(5)},c,${((f.dt ?? 1) * P * 1000).toFixed(3)},1,${f.frac ?? 0.05},${f.luma ?? 100},0,0,${f.w},40,${f.w},40,0,0,0`);
    if (f.rest) for (let i = 0; i < f.rest; i++) { t += P; L.push(`${t.toFixed(5)},i,,,,,,,,,,,,,`); }
  }
  for (let i = 0; i < 40; i++) { t += P; L.push(`${t.toFixed(5)},i,,,,,,,,,,,,,`); }
  writeFileSync(join(dir, "frames.csv"), L.join("\n") + "\n");
  writeFileSync(join(dir, "frames.csv.meta.json"), JSON.stringify({ refresh_hz: HZ, t0_mach: 1000, t0_wall: 5000, ...(extra.meta ?? {}) }));
  for (const [f, body] of Object.entries(extra)) if (typeof body === "string") writeFileSync(join(dir, f), body);
  const { rows, meta } = loadRun(join(dir, "frames.csv"));
  return notice(rows, meta, analyze(rows, meta), { dir });
}
function check(name, s, grade, ...needles) {
  const out = formatSeen(s);
  const miss = needles.filter((n) => (n.startsWith("!") ? out.includes(n.slice(1)) : !out.includes(n)));
  const ok = s.grade === grade && !miss.length;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${s.grade}${ok ? "" : ` (wanted ${grade}; ${miss.map((m) => (m.startsWith("!") ? `unexpected "${m.slice(1)}"` : `missing "${m}"`)).join(", ")})`}`);
  console.log(out.split("\n").map((l) => `       ${l}`).join("\n"));
}
/** An ease-out opening 0→400pt over n frames. */
const ease = (n, to = 400) => Array.from({ length: n }, (_, i) => ({ w: +(to * (1 - Math.pow(1 - (i + 1) / n, 3))).toFixed(1) }));

check("smooth", run("smooth", ease(60)), "smooth", "LOOKED SMOOTH", "width 0pt→400pt", "!FROZE");

const frozen = ease(60); frozen[20].dt = 8;
check("freeze", run("freeze", frozen), "rough", "FROZE 66.7ms (8 refreshes", "!why:");

const hung = ease(60); hung[30].dt = 30;
check("hang + cause", run("hang", hung, { "stalls.json": JSON.stringify({ name: "Demo", pid: 1, from: 990, to: 1100, threshold_ms: 10.4, stacks: true,
  stalls: [{ t: 1000 + 30 * P + 30 * P + 0.004, ms: 240, n: 20, app: [["Model.reload()", 18]], leaf: [["usleep [libsystem_c.dylib]", 20]], stack: ["usleep [libsystem_c.dylib]", "Model.reload()", "ContentView.body.getter"] }] }) }),
  "broken", "HUNG 250ms", "why: main thread was blocked 240ms", "app: Model.reload() 90%");

check("freeze, main thread free", run("offmain", frozen, { "stalls.json": JSON.stringify({ name: "Demo", pid: 1, from: 990, to: 1100, threshold_ms: 10.4, stacks: true, stalls: [] }) }),
  "rough", "main thread was free the whole time");

check("steady 60 on 120", run("half", ease(40).map((f) => ({ ...f, dt: 2 }))), "minor", "steady 60 fps", "!FROZE", "!JUDDER");

const judder = ease(60).map((f, i) => ({ ...f, dt: i % 3 === 0 ? 2 : 1 }));
check("judder", run("judder", judder), "rough", "JUDDER", "!FROZE");

const flash = ease(60); flash[25].luma = 160;
check("flash", run("flash", flash), "rough", "FLASH: the region went brighter for 1 frame");

const spring = [...ease(40, 430), ...Array.from({ length: 20 }, (_, i) => ({ w: +(430 - 30 * ((i + 1) / 20)).toFixed(1) }))];
check("spring overshoot", run("spring", spring), "smooth", "overshot by 30pt and settled");

check("pop", run("pop", [{ w: 300, frac: 0.4, rest: 60 }]), "smooth", "NO ANIMATION", "pop: 40% of the region changed");

const t0 = 5000 + 30 * P; // the motion starts on the first frame after the lead-in
check("answers a click", run("click", ease(60), { "actions.jsonl": JSON.stringify({ wall0: t0 - 0.03, wall1: t0, op: "click", ok: true }) + "\n" }),
  "smooth", "answered: 38.3ms click");
check("lags after a click", run("lag", ease(60), { "actions.jsonl": JSON.stringify({ wall0: t0 - 0.4, wall1: t0 - 0.39, op: "click", ok: true }) + "\n" }),
  "rough", "LAGGED first visible change 408ms after click");

// The capture hands over "new" images identical to the last one in the middle of a hang: still one freeze.
const hidden = ease(60);
hidden.splice(30, 0, { w: hidden[29].w, frac: 0, dt: 6 }, { w: hidden[29].w, frac: 0, dt: 7 });
hidden[32].dt = 5;
check("freeze hidden behind identical frames", run("hidden", hidden), "broken", "HUNG 150ms (18 refreshes");

check("nothing", run("still", []), "still", "NOTHING MOVED", "!pixel answered");

// Was the eye open? Steps on the recording's clock: wall = 5000 + t.
const steps = (...at) => at.map((t) => JSON.stringify({ wall0: 5000 + t, wall1: 5000 + t + 0.05, op: "click", x: 10, y: 10, ok: true })).join("\n") + "\n";
check("pressed, and nothing answered", run("deaf", [], { "actions.jsonl": steps(0.1, 0.3) }), "still", "NOTHING MOVED", "2 press / scroll steps were sent and not one pixel answered");
check("no image at all is not a still screen", run("noimage", [], { noImage: true, "actions.jsonl": steps(0.1) }), "blind", "SAW NOTHING", "!NOTHING MOVED");
check("the stream dropped and was reopened", run("blink", ease(40), { meta: { stream_error: "connection interrupted", blind: [{ from: 0.3, to: 0.5, why: "connection interrupted" }] }, "actions.jsonl": steps(0.1, 0.4) }),
  "blind", "NOT SEEN IN FULL", "THE EYE WAS SHUT for 200ms from 0.30s", "1 step ran in it unseen (click)", "!HUNG", "!FROZE");
check("the stream died for good, the steps went on (old recordings)", run("dead", ease(40), { meta: { stream_error: "connection interrupted" }, "actions.jsonl": steps(0.1, 3, 5, 9) }),
  "blind", "NOT SEEN IN FULL", "3 steps ran unseen", "THE EYE WAS SHUT for 8.");
check("a quiet stretch on a healthy stream is not blindness", run("quiet", [...ease(20), { dt: 240, w: 400, frac: 0.0001 }], { "actions.jsonl": steps(0.24) }), "smooth", "!EYE WAS SHUT", "!NOT SEEN");

console.log(failed ? `\n${failed} FAILED` : "\nall perception cases pass");
process.exit(failed ? 1 : 0);
