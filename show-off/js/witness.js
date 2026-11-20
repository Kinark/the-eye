// The page as a witness of its visitor. the-eye says what a viewer would have noticed in an app; this says what the
// page noticed about the person in front of it, in the same voice and from the same clock: how far they scrolled and
// whether every frame of it was on time, how long the tab was hidden (the eye was shut, and nothing was judged), that
// they have not moved and it has not blinked. Nothing here is a canned number: every figure is read off the meter.
import { onFrame, recent, frames, freezes } from "./meter.js";
import { Spring, QUICK, PLAYFUL, reduceMotion } from "./spring.js";

/** What the page has seen of this visit. The footer reads it. */
export const seen = { since: performance.now(), scrolled: 0, shut: 0, shutMs: 0, lastShut: null };
/** How open the eyes are: 0 shut, 1 open. Shut until the first judged frame, and while the tab is hidden. */
export const lid = new Spring(PLAYFUL, reduceMotion.matches ? 1 : 0);
/** The thing in motion, when there is one: a function returning its [clientX, clientY]. The eyes follow it. */
export const gaze = { at: null };
/** Fires "open" each time the eyes open. */
export const events = new EventTarget();

const pointer = { x: 0, y: 0, at: -1e9 };
const DEFAULT = "this page, right now", HOLD = 4200;
let show = () => {};

/** Say one line in the bar, where the label is, for a few seconds. `caught` turns it orange. */
export function notice(text, caught = false) { show(text, caught); }

/**
 * Where an eye centred at (cx, cy) should look, as a vector no longer than 1. It follows the thing in motion, else
 * the pointer; three seconds after the pointer last moved it looks straight back at the visitor.
 */
export function lookFrom(cx, cy, now, reach = 420) {
  if (reduceMotion.matches) return [0, 0];
  const p = gaze.at?.() ?? (now - pointer.at < 3000 ? [pointer.x, pointer.y] : null);
  if (!p) return [0, 0];
  const dx = p[0] - cx, dy = p[1] - cy, d = Math.hypot(dx, dy) || 1, pull = Math.min(1, d / reach);
  return [(dx / d) * pull, (dy / d) * pull];
}

export const span = (ms) => {
  const s = ms / 1000;
  return s < 60 ? `${s < 10 ? s.toFixed(1) : Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
};
const count = (n) => Math.round(n).toLocaleString("en-US");

/** The label in the bar rolls: the old line leaves upward, the new one arrives from below, on one spring. */
function ticker(slot, bar) {
  let cur = slot.firstElementChild, old = null, back = 0;
  const roll = new Spring(QUICK, 1, (r) => {
    if (old) old.style.transform = `translateY(${(-r * 120).toFixed(1)}%)`;
    cur.style.transform = r === 1 ? "" : `translateY(${((1 - r) * 120).toFixed(1)}%)`;
    if (r === 1 && old) { old.remove(); old = null; }
  });
  const set = (text, caught) => {
    if (cur.textContent === text) return;
    old?.remove();
    old = cur;
    cur = document.createElement("span");
    cur.textContent = text;
    if (caught) cur.className = "caught";
    slot.append(cur);
    if (reduceMotion.matches) roll.put(1); else { roll.put(0); roll.aim(1); }
  };
  show = (text, caught) => {
    set(text, caught);
    bar.classList.add("noticing");
    clearTimeout(back);
    back = setTimeout(() => { set(DEFAULT, false); bar.classList.remove("noticing"); }, HOLD);
  };
}

/** The mark in the bar is the same eye, small: it follows what moves, tightens when a freeze is caught, and shuts. */
function markEye(svg) {
  const lidEl = svg.querySelector("ellipse"), pupil = svg.querySelector(".mark-pupil"), irisEl = svg.querySelector(".mark-iris");
  const px = new Spring(QUICK, 0), py = new Spring(QUICK, 0), open = new Spring(PLAYFUL, 1);
  let counted = 0, caughtAt = -1e9, was = "", cx = 0, cy = 0;
  const where = () => { const r = svg.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; };
  addEventListener("resize", where);
  where();
  events.addEventListener("open", () => { open.x = 1.25; open.aim(1); });
  onFrame((now) => {
    if (freezes.length > counted) {
      counted = freezes.length; caughtAt = now;
      if (!reduceMotion.matches) { open.x = 0.62; open.aim(1); }
    }
    const [lx, ly] = lookFrom(cx, cy, now, 300);
    if (lx !== px.to) px.aim(lx);
    if (ly !== py.to) py.aim(ly);
    const caught = now - caughtAt < 1400;
    const state = `${px.x.toFixed(3)} ${py.x.toFixed(3)} ${open.x.toFixed(3)} ${lid.x.toFixed(3)} ${caught}`;
    if (state === was) return;
    was = state;
    pupil.setAttribute("transform", `translate(${(px.x * 4.4).toFixed(2)} ${(py.x * 4.4).toFixed(2)})`);
    pupil.setAttribute("r", (4.6 * open.x).toFixed(2));
    lidEl.setAttribute("ry", (11 * Math.max(0, Math.min(1, lid.x))).toFixed(2));
    irisEl.classList.toggle("caught", caught);
  });
}

/** A key drawn on the page goes down when the real one does. */
function keycaps() {
  const caps = [...document.querySelectorAll("kbd[data-key]")].map((el) => {
    const s = new Spring(QUICK, 1, (v) => { el.style.transform = v === 1 ? "" : `scale(${v.toFixed(4)})`; });
    return { el, s, key: el.dataset.key.toLowerCase() };
  });
  const set = (key, down) => {
    for (const c of caps) {
      if (key !== null && c.key !== key) continue;
      c.el.classList.toggle("down", down);
      if (!reduceMotion.matches) c.s.aim(down ? 0.9 : 1);
    }
  };
  addEventListener("keydown", (e) => { if (!e.repeat) set(e.key.toLowerCase(), true); });
  addEventListener("keyup", (e) => set(e.key.toLowerCase(), false));
  addEventListener("blur", () => set(null, false));
}

const ICON = (iris) => `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%23${iris}'/%3E%3Ccircle cx='16' cy='16' r='6.5' fill='%230B0B0C'/%3E%3C/svg%3E`;

export function witness() {
  ticker(document.getElementById("ticker"), document.querySelector(".bar-meter"));
  markEye(document.getElementById("mark-eye"));
  keycaps();

  // ---- the visitor's hand ---------------------------------------------------------------------------------------
  let movedAt = performance.now(), framesThen = 0, stared = false;
  const touched = () => { movedAt = performance.now(); framesThen = frames.n; stared = false; };
  addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.at = performance.now(); touched(); }, { passive: true });
  addEventListener("pointerdown", touched, { passive: true });
  addEventListener("keydown", touched);

  // ---- a scroll, once it has come to rest: how far, how long, and whether every frame of it was on time ----------
  let dist = 0, from = 0, lastY = scrollY, rest = 0;
  addEventListener("scroll", () => {
    const y = scrollY, d = Math.abs(y - lastY), now = performance.now();
    lastY = y;
    if (!dist) from = now;
    dist += d; seen.scrolled += d;
    touched();
    clearTimeout(rest);
    rest = setTimeout(() => {
      const ms = performance.now() - from - 180, went = dist;
      dist = 0;
      if (went < 800 || ms < 150) return; // a nudge, or a jump to an anchor: not a scroll anyone watched
      const { late } = recent(ms + 180);
      notice(`you scrolled ${count(went)}pt in ${span(ms)}, ${late ? `${late} frame${late === 1 ? "" : "s"} late` : "every frame on time"}`, late > 0);
    }, 180);
  }, { passive: true });

  // ---- Esc ×6 is how a person takes their input back from the-eye. Here there is nothing to take back. -----------
  let esc = [];
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.repeat) return;
    const now = performance.now();
    if (esc.length && now - esc[esc.length - 1] > 1000) esc = []; // the real rule: each within 1s of the one before
    esc.push(now);
    if (esc.length === 3) notice("Esc ×3. Three more and a held lock lets go");
    if (esc.length >= 6) { esc = []; notice("Esc ×6: released. Nothing was locked here"); }
  });

  // ---- the tab, hidden: the browser draws nothing, so the eye is shut and says for how long ----------------------
  const title = document.title, icon = document.getElementById("icon");
  let hiddenAt = 0, calm = 0;
  document.addEventListener("visibilitychange", () => {
    const now = performance.now();
    if (document.hidden) {
      hiddenAt = now;
      if (!reduceMotion.matches) lid.put(0);
      document.title = "the-eye: shut while you are away";
      return;
    }
    document.title = title;
    touched();
    if (!hiddenAt) return;
    const ms = now - hiddenAt;
    hiddenAt = 0;
    if (!reduceMotion.matches) { lid.aim(1); events.dispatchEvent(new Event("open")); }
    if (ms < 1000) return;
    seen.shut++; seen.shutMs += ms; seen.lastShut = { at: now, ms };
    notice(`the eye was shut for ${span(ms)}`, true);
  });

  let opened = reduceMotion.matches, counted = 0, checked = 0;
  onFrame((now) => {
    // The page's first 0.8s is not judged. The eye opens on the first frame that is.
    if (!opened && frames.n > 0) { opened = true; lid.aim(1); events.dispatchEvent(new Event("open")); }

    // A freeze, wherever on the page the visitor is: the bar says so, and so does the tab.
    if (freezes.length > counted) {
      counted = freezes.length;
      const ms = Math.round(freezes[counted - 1].ms);
      notice(`caught: no frame for ${ms}ms`, true);
      icon.href = ICON("FF8C1A");
      document.title = `froze ${ms}ms · the-eye`;
      clearTimeout(calm);
      calm = setTimeout(() => { icon.href = ICON("808080"); if (!document.hidden) document.title = title; }, 8000);
    }

    // Twenty seconds without a move from the visitor. Rest is not a freeze, and the eye has not blinked.
    if (now - checked < 500) return;
    checked = now;
    if (!stared && now - movedAt > 20000) {
      stared = true;
      notice(`still for 20s: ${count(frames.n - framesThen)} frames, and it has not blinked`);
    }
  });
}
