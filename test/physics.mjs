// bun test/physics.mjs — the motion fitter against the platform's own curves.
// Builds test/fixtures/truth.swift (SwiftUI's Spring and UnitCurve, sampled at 120Hz) and checks that fitMotion names
// what moved each one and recovers its numbers, from frames degraded the way a screen capture degrades them:
// whole-point positions, an unknown start phase, dropped frames, and a 60Hz display.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitMotion, formatFit } from "../src/physics.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const exe = join(mkdtempSync(join(tmpdir(), "eye-truth-")), "truth");
const b = spawnSync("swiftc", ["-O", join(ROOT, "test", "fixtures", "truth.swift"), "-o", exe], { encoding: "utf8" });
if (b.status !== 0) { console.error(b.stderr); process.exit(2); }
const truth = JSON.parse(spawnSync(exe, [], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout);
const verbose = process.argv.includes("-v");

let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
/** What a capture would hand over: frames from the first visible change to the last, positions snapped to `q` points. */
function degrade(samples, { q, every = 1, drop = 0, phase = 0 }) {
  const snap = (x) => Math.round(x / q) * q;
  const rest = snap(samples[0][1]);
  let fr = samples.filter((_, i) => i % every === phase % every).map(([t, x]) => ({ t, x: snap(x) })).filter(() => rnd() >= drop);
  const first = fr.findIndex((s) => s.x !== rest);
  let last = fr.length - 1;
  while (last > 0 && fr[last].x === fr[last - 1].x) last--;
  fr = fr.slice(first, last + 1);
  return [{ t: fr[0].t - every / 120, x: rest }, ...fr];
}
const CONDITIONS = [
  ["clean 120Hz, 0.5pt", { q: 0.5 }, 1 / 120],
  ["120Hz, 1pt, 8% dropped", { q: 1, drop: 0.08 }, 1 / 120],
  ["60Hz, 1pt, off phase", { q: 1, every: 2, phase: 1 }, 1 / 60],
];

let failed = 0, checks = 0;
const want = (what, ok, detail = "") => { checks++; if (!ok) { failed++; console.log(`FAIL ${what} ${detail}`); } else if (verbose) console.log(`ok   ${what} ${detail}`); };
const kinds = (f) => [f.model?.kind, f.also?.kind].filter(Boolean);
const pick = (f, kind) => (f.model?.kind === kind ? f.model : f.also?.kind === kind ? f.also : null);

for (const [label, how, period] of CONDITIONS) {
  for (const c of truth) {
    const f = fitMotion(degrade(c.samples, how), period);
    const tag = `[${label}] ${c.name}`;
    if (verbose) console.log(`\n${tag}\n  ${f ? formatFit(f).join("\n  ") : "null"}`);
    if (!f) { want(`${tag}: produced a fit`, false); continue; }
    const tight = how.q <= 0.5;
    if (c.kind === "spring") {
      // Without overshoot a spring and an ease-out are the same picture: naming the spring first or second is fair.
      const rings = c.zeta < 0.9;
      want(`${tag}: is a spring`, rings ? f.model?.kind === "spring" : kinds(f).includes("spring"), `(got ${kinds(f).join(" / ")})`);
      const s = pick(f, "spring");
      if (!s) continue;
      const tz = tight ? 0.04 : 0.08, td = tight ? 0.06 : 0.12;
      want(`${tag}: damping ratio ${c.zeta.toFixed(2)}`, Math.abs(s.zeta - c.zeta) <= tz * Math.max(1, c.zeta), `(got ${s.zeta.toFixed(3)})`);
      want(`${tag}: response ${c.duration}s`, Math.abs(s.duration - c.duration) <= td * c.duration, `(got ${s.duration.toFixed(3)})`);
      if (c.v0) want(`${tag}: launched moving`, Math.abs(s.v0 - c.v0) <= 1.5, `(got ${s.v0.toFixed(2)})`);
      else want(`${tag}: started from rest`, Math.abs(s.v0) < 0.5, `(got ${s.v0.toFixed(2)})`);
    } else if (c.kind === "curve") {
      want(`${tag}: is a timing curve`, f.model?.kind === "curve", `(got ${kinds(f).join(" / ")})`);
      const m = pick(f, "curve");
      if (!m) continue;
      want(`${tag}: duration ${c.duration}s`, Math.abs(m.duration - c.duration) <= (tight ? 0.05 : 0.1) * c.duration + period, `(got ${m.duration.toFixed(3)})`);
      const named = { easeInOut: /ease-in-out|easeInOut/, easeOut: /ease-out|easeOut/, easeIn: /ease-in\b|easeIn\b/, linear: /linear/, "css-ease": /CSS ease|default/ }[c.name];
      if (named) want(`${tag}: named ${c.name}`, named.test(m.preset ?? ""), `(got ${m.preset})`);
      else want(`${tag}: a custom curve is not given a preset's name`, !m.preset, `(got ${m.preset})`);
    } else {
      want(`${tag}: is a per-frame lerp`, kinds(f).includes("lerp"), `(got ${kinds(f).join(" / ")})`);
      const m = pick(f, "lerp");
      if (m) want(`${tag}: rate ${c.per_frame}/frame at 120Hz`, Math.abs((1 - Math.exp(-m.rate / 120)) - c.per_frame) <= 0.02, `(got ${(1 - Math.exp(-m.rate / 120)).toFixed(3)})`);
    }
  }
}

// Things that are not one animation must not be given a name.
{
  const hand = [{ t: -1 / 120, x: 20 }];
  for (let i = 0; i < 90; i++) { const t = i / 120; hand.push({ t, x: Math.round(20 + 150 * t / 0.75 + 60 * Math.sin(9 * t) + (i > 45 ? 90 : 0)) }); }
  const f = fitMotion(hand, 1 / 120);
  if (verbose) console.log(`\nhand-driven\n  ${f ? formatFit(f).join("\n  ") : "null"}`);
  want("a hand-driven, retargeted motion is not named", !!f && f.model === null);
  want("six frames are too few to fit", fitMotion(hand.slice(0, 6), 1 / 120) === null);
  want("a 2pt twitch is not a motion", fitMotion(hand.map((s, i) => ({ t: s.t, x: 20 + (i % 3) })), 1 / 120) === null);
}
{
  // A lerp stepped once per callback while every fourth frame takes two refreshes: it falls behind the clock.
  const S = [{ t: 0, x: 20 }];
  let t = 1 / 120, x = 20;
  for (let i = 0; i < 60; i++) { x += (380 - x) * 0.12; S.push({ t, x }); t += (i % 4 === 3 ? 2 : 1) / 120; }
  const f = fitMotion(S, 1 / 120, { res: 0.05 });
  want("a lerp that drops frames is still a lerp", f?.model?.kind === "lerp");
  want(`…stepped by frame, not by the clock (factor ${f?.model?.per_frame?.toFixed(3)})`, f?.model?.by_frame === true && Math.abs(f.model.per_frame - 0.12) < 0.01);
  const S2 = S.map((p, i) => ({ t: i / 120, x: p.x }));
  want("an evenly paced lerp is not flagged", fitMotion(S2, 1 / 120, { res: 0.05 })?.model?.by_frame === undefined);
  // A fit may be told the measurement runs half a frame late (a box spanning two frames).
  const late = S2.map((p) => ({ t: p.t, x: p.x })).slice(0, 50);
  want("a late-running measurement still fits", fitMotion(late, 1 / 120, { res: 0.05, minLead: -1 / 240 })?.model?.kind === "lerp");
}
{
  // Dropped and bouncing: gravity and a floor, simulated the way a game loop would (not with the fitter's own formula).
  for (const [e, land] of [[0.6, 0.3], [0.5, 0.22], [0.75, 0.35]]) {
    const g = 2 / (land * land), dt = 1 / 2400;
    const raw = [];
    let u = 0, v = 0;
    for (let i = 0; i <= 2400 * 3; i++) {
      if (i % 20 === 0) raw.push([i * dt, 20 + 300 * u]);
      v += g * dt; u += v * dt;
      if (u >= 1 && v > 0) { u = 1 - (u - 1) * e; v = -v * e; if (Math.abs(v) < 0.05) { u = 1; v = 0; } }
    }
    for (const [label, how, period] of CONDITIONS) {
      const f = fitMotion(degrade(raw, how), period);
      const m = f?.model?.kind === "bounce" ? f.model : null;
      const tag = `bounce e ${e}, lands at ${land}s [${label}]`;
      want(`${tag}: is a bounce`, !!m, `(got ${f ? kinds(f).join(" / ") || "nothing" : "null"})`);
      want(`${tag}: restitution ${m?.restitution.toFixed(2)}`, !!m && Math.abs(m.restitution - e) < 0.06);
      want(`${tag}: lands after ${m?.first_hit_ms.toFixed(0)}ms`, !!m && Math.abs(m.first_hit_ms - 1000 * land) < 25);
      want(`${tag}: gravity ${m ? (m.gravity * 300).toFixed(0) : "?"}pt/s²`, !!m && Math.abs(m.gravity / g - 1) < 0.15);
      want(`${tag}: no overshoot reported`, !!f && f.overshoot_pct < 1.5);
      if (m && verbose) console.log("     " + formatFit(f).join("\n     "));
    }
  }
}
// A spring whose middle was never shown (the app's main thread was blocked for 100ms): half the way goes in one frame.
// Whatever curve can be threaded through the rest, no engine may be named.
{
  const w = (2 * Math.PI) / 0.5, z = 0.8, wd = w * Math.sqrt(1 - z * z);
  const at = (t) => 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
  const s = [{ t: 0, x: 0 }];
  for (let i = 1; i <= 120; i++) { const t = i / 120; if (t > 0.05 && t < 0.15) continue; s.push({ t, x: Math.round(400 * at(t)) }); }
  const f = fitMotion(s, 1 / 120);
  want("a motion that leapt names no engine", !!f && f.model === null, JSON.stringify(f?.model));
  want("and says how far it leapt", /% of the way went in a single frame/.test(f?.caveat ?? ""), f?.caveat);
  const whole = [{ t: 0, x: 0 }];
  for (let i = 1; i <= 120; i++) whole.push({ t: i / 120, x: Math.round(400 * at(i / 120)) });
  want("the same spring shown whole is still a spring", fitMotion(whole, 1 / 120)?.model?.kind === "spring");
}

console.log(failed ? `\n${failed} of ${checks} FAILED` : `\nall ${checks} checks pass`);
process.exit(failed ? 1 : 0);
