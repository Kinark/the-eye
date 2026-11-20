// The hero: the button that freezes the page, the verdict in the-eye's own voice, the readout in the bar and the
// running total in the footer. All of it is read from the meter; nothing here is a canned number.
import { onFrame, recent, refreshHz, freezes, totals, declareBlock } from "./meter.js";
import { seen, span } from "./witness.js";

const $ = (id) => document.getElementById(id);
const born = performance.now();

/** Hold the main thread for `ms`. This is the real thing: no frame can be drawn until it returns. */
export function freeze(ms) {
  const from = performance.now();
  declareBlock(from, from + ms, "freeze()");
  while (performance.now() - from < ms) { /* busy on purpose */ }
}

function say(box, lines) {
  const key = lines.map((l) => l.join("|")).join("\n");
  if (box.dataset.said === key) return; // the same words: leave them, so a screen reader hears each verdict once
  box.dataset.said = key;
  box.replaceChildren(...lines.map(([text, cls]) => { const p = document.createElement("p"); p.textContent = text; if (cls) p.className = cls; return p; }));
}

export function hero() {
  const btn = $("freeze"), range = $("freeze-range"), msEl = $("freeze-ms"), verdict = $("verdict");
  const meter = $("meter"), bar = meter.closest(".bar-meter"), summary = $("summary");

  range.addEventListener("input", () => { msEl.textContent = range.value; });
  btn.addEventListener("click", () => freeze(Number(range.value)));
  addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "f" || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const tag = e.target?.tagName;
    if (tag === "SELECT" || tag === "TEXTAREA" || (tag === "INPUT" && e.target.type !== "range")) return;
    freeze(Number(range.value));
  });

  let spoke = 0;
  const wait = document.createElement("span");
  wait.className = "wide";
  onFrame((now) => {
    if (now - spoke < 250) return;
    spoke = now;
    const hz = refreshHz(), one = recent(1000, now), two = recent(2000, now);

    wait.textContent = `, longest wait ${one.longest.toFixed(1)}ms`; // dropped on a phone-width bar, where it cannot fit
    meter.replaceChildren(`${one.fps.toFixed(1)} fps of ${hz}`, wait);
    bar.classList.toggle("late", one.late > 0);

    const f = freezes[freezes.length - 1], shut = seen.lastShut;
    if (shut && now - shut.at < 8000 && !(f && f.at > shut.at)) {
      say(verdict, [
        [`THE EYE WAS SHUT for ${span(shut.ms)}`, "head caught"],
        [`    why: this tab was hidden, and a hidden tab draws nothing`],
        [`    none of it was judged, and it does not count as a freeze`, "dim"],
      ]);
    } else if (f && now - f.at < 8000) {
      const at = ((f.at - f.ms - born) / 1000).toFixed(2);
      say(verdict, [
        [`FROZE: this page drew nothing for ${Math.round(f.ms)}ms at ${at}s`, "head caught"],
        [f.why
          ? `    why: its main thread was blocked ${Math.round(f.why.ms)}ms in ${f.why.name}, the button you pressed`
          : `    why: something held the main thread, and it was not this page's button`],
        [`    seen from inside: ${Math.round(f.ms / (1000 / hz))} refreshes of a ${hz}Hz display went by with no new frame`, "dim"],
      ]);
    } else if (two.count > 30) {
      say(verdict, [
        [two.late
          ? `LOOKED MOSTLY SMOOTH: ${two.late} late frame${two.late === 1 ? "" : "s"} in the last 2 seconds`
          : `LOOKED SMOOTH: every frame on time for the last 2 seconds`, "head"],
        [`    ${Math.round(two.fps)} fps of ${hz} while you watch`],
        [`    it has not frozen since ${freezes.length ? "the last time you made it" : "you arrived"}`, "dim"],
      ]);
    }

    const n = freezes.length, worst = totals.worst;
    summary.textContent = `${totals.frames.toLocaleString("en-US")} frames drawn. The longest wait between two was ${worst < 100 ? worst.toFixed(1) : Math.round(worst)}ms. `
      + (n === 0 ? "It never froze." : `It froze ${n === 1 ? "once" : `${n} times`}, and was caught ${n === 1 ? "" : "every time"}.`.replace(" .", "."))
      + ` You watched for ${span(now - seen.since - seen.shutMs)}`
      + (seen.scrolled >= 1 ? ` and scrolled ${Math.round(seen.scrolled).toLocaleString("en-US")}pt.` : ".")
      + (seen.shut ? ` The eye was shut ${seen.shut === 1 ? "once" : `${seen.shut} times`}, ${span(seen.shutMs)} in all, and judged none of it.` : "");
  });
}
