// Websites too: the section where the page says who is watching it. From inside, that is always this page's own
// meter. From outside it is the-eye, and only when it really is: a website session puts src/eye-page.js into the page
// before the page's own scripts run, and that probe leaves window.__eye. The page reads the probe's own books (the
// elements it has named, the ones it is following) and says so. Nothing here is drawn for show: with no probe in the
// page, the line says nobody is watching.
import { onFrame, recent, refreshHz } from "./meter.js";
import { seen, span, notice, events } from "./witness.js";
import { reduceMotion } from "./spring.js";

const $ = (id) => document.getElementById(id);

/** The eye's page probe, if it is in this page: its state and what it has counted. */
function probe() {
  const e = window.__eye;
  if (!e || typeof e.start !== "function") return null;
  return { on: e.off === false, named: e.els?.size ?? 0, following: e.track?.size ?? 0 };
}

function say(box, lines) {
  const key = lines.map((l) => l.join("|")).join("\n");
  if (box.dataset.said === key) return; // the same words: a screen reader hears each state once
  box.dataset.said = key;
  // The figures under the head change four times a second: a screen reader is told the head, once per state.
  const said = $("outside-said");
  if (said.textContent !== lines[0][0]) said.textContent = lines[0][0];
  box.replaceChildren(...lines.map(([text, cls]) => Object.assign(document.createElement("p"), { textContent: text, className: cls ?? "" })));
}

const things = (n) => `${n.toLocaleString("en-US")} thing${n === 1 ? "" : "s"}`;

export function outside() {
  const call = $("self-call"), copy = $("self-copy"), inside = $("inside"), out = $("outside");

  // The call carries the address this page is really served from.
  call.textContent = `eye_drive {\n  url: "${location.host}",\n  wing: 'el:"Send it across" tap settle',\n  end: true\n}`;
  let back = 0;
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(call.textContent); copy.textContent = "Copied"; notice(`on your clipboard, ${call.textContent.length} characters`); }
    catch { copy.textContent = "Select it and copy"; }
    clearTimeout(back);
    back = setTimeout(() => { copy.textContent = "Copy the call"; }, 1600);
  });

  let spoke = 0, was = false, since = 0, prev = 0;
  onFrame((now) => {
    if (now - spoke < 250) return;
    spoke = now;
    const one = recent(1000, now);
    inside.textContent = one.count ? `${one.fps.toFixed(1)} fps of ${refreshHz()}, timed by its own requestAnimationFrame` : "measuring";

    const p = probe(), on = !!p?.on;
    if (on && !was) {
      since = now;
      notice("the-eye is watching this page from outside", true);
      if (!reduceMotion.matches) events.dispatchEvent(new Event("open")); // both pupils go wide for a moment
    }
    if (!on && was) notice(`the-eye let go after ${span(now - since)}`);
    if (on && was) seen.outside += now - prev; // the footer's total: only stretches the probe was on at both ends
    was = on; prev = now;

    if (on) {
      say(out, [
        ["WATCHED FROM OUTSIDE: the-eye's probe is inside this page", "head caught"],
        [`    it has named ${things(p.named)} here and is following ${p.following} that ${p.following === 1 ? "moves" : "move"}`],
        [`    for ${span(now - since)} so far`, "dim"],
      ]);
    } else if (p) {
      say(out, [
        ["THE EYE HAS LET GO: its probe is still in this page, switched off", "head"],
        [seen.outside ? `    it watched for ${span(seen.outside)}` : "    it has not recorded anything here yet"],
        ["    this browser is the eye's own. The next session finds it open", "dim"],
      ]);
    } else {
      say(out, [
        ["NOT WATCHED: nothing but this page is timing this page", "head"],
        ["    the eye's probe is not in here"],
        ["    run the call, and this line is the first thing it changes", "dim"],
      ]);
    }
  });
}
