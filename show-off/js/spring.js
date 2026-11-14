// A damped spring at mass 1, stepped on the page's clock. Change the target mid-flight and it carries on from where
// it is, at the speed it has: nothing here ever restarts.
import { onFrame } from "./meter.js";

export const QUICK = { k: 420, c: 32 };   // direct feedback: hover, press, the pupil
export const PLAYFUL = { k: 180, c: 14 }; // the page caught something: one clear overshoot

export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

const live = new Set();
onFrame((_, dt) => { for (const s of live) s.step(Math.min(dt, 64) / 1000); });

export class Spring {
  constructor({ k, c }, x = 0, onChange = null) { this.k = k; this.c = c; this.x = x; this.v = 0; this.to = x; this.onChange = onChange; }
  /** Head for `to`; `kick` adds speed (units per second) on the way. */
  aim(to, kick = 0) { this.to = to; this.v += kick; live.add(this); return this; }
  /** Be at `x` now, at rest. */
  put(x) { this.x = this.to = x; this.v = 0; live.delete(this); this.onChange?.(x); return this; }
  step(dt) {
    // Semi-implicit Euler in 2ms slices: stable for every stiffness the page uses, whatever the frame took.
    for (let left = dt; left > 0; left -= 0.002) {
      const h = Math.min(left, 0.002);
      this.v += (-this.k * (this.x - this.to) - this.c * this.v) * h;
      this.x += this.v * h;
    }
    if (Math.abs(this.x - this.to) < 1e-3 && Math.abs(this.v) < 1e-2) { this.x = this.to; this.v = 0; live.delete(this); }
    this.onChange?.(this.x);
  }
}

/**
 * Hover and press on a control: it lifts 2% and leans up to 2° toward the pointer, sinks 3% under a press.
 * With reduce motion on it does none of that; the colour change in CSS is the answer.
 */
export function tilt(el) {
  let rx = 0, ry = 0, s = 1;
  const draw = () => { el.style.transform = `perspective(600px) rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg) scale(${s.toFixed(4)})`; };
  const X = new Spring(QUICK, 0, (v) => { rx = v; draw(); }), Y = new Spring(QUICK, 0, (v) => { ry = v; draw(); }), S = new Spring(QUICK, 1, (v) => { s = v; draw(); });
  let over = false, down = false;
  const settle = () => S.aim(down ? 0.97 : over ? 1.02 : 1);
  el.addEventListener("pointerenter", () => { if (reduceMotion.matches || el.disabled) return; over = true; settle(); });
  el.addEventListener("pointermove", (e) => {
    if (!over) return;
    const r = el.getBoundingClientRect();
    Y.aim(2 * (((e.clientX - r.left) / r.width) * 2 - 1));
    X.aim(-2 * (((e.clientY - r.top) / r.height) * 2 - 1));
  });
  el.addEventListener("pointerleave", () => { over = down = false; X.aim(0); Y.aim(0); settle(); });
  el.addEventListener("pointerdown", () => { if (reduceMotion.matches || el.disabled) return; down = true; settle(); });
  el.addEventListener("pointerup", () => { down = false; settle(); });
  // A press from the keyboard has no pointer: it gets the same dip.
  el.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat && !reduceMotion.matches) { down = true; settle(); } });
  el.addEventListener("keyup", () => { down = false; settle(); });
}
