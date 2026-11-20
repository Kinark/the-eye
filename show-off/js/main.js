// the-eye show-off: wires the page together. Each section is its own module; they share one clock (meter.js).
import { cutAll } from "./squircle.js";
import { tilt } from "./spring.js";
import { iris } from "./iris.js";
import { hero, freeze } from "./hero.js";
import { witness, notice } from "./witness.js";
import { puck } from "./puck.js";
import { replay } from "./replay.js";
import { corner } from "./corner.js";

cutAll();
for (const el of document.querySelectorAll("[data-tilt]")) tilt(el);

iris(document.getElementById("iris"));
witness();
hero();
puck();
corner();
replay().catch((e) => { document.getElementById("replay-report").textContent = `The recording did not load: ${e.message}. Is the page served by npm run show-off?`; });

// The install line carries the real path of this checkout, as the server reports it.
const cmd = document.getElementById("cmd-text"), copy = document.getElementById("copy");
fetch("/config.json").then((r) => r.json()).then((c) => { cmd.textContent = `claude mcp add the-eye -- node ${c.repo}/src/index.ts`; }).catch(() => {});
let back = 0;
copy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(cmd.textContent); copy.textContent = "Copied"; notice(`on your clipboard, ${cmd.textContent.length} characters`); }
  catch { copy.textContent = "Select it and copy"; }
  clearTimeout(back);
  back = setTimeout(() => { copy.textContent = "Copy"; }, 1600);
});

// For whoever opens the console: the same button, and the same words, by hand.
window.eye = {
  freeze: (ms = 150) => { freeze(Math.min(Math.max(Number(ms) || 0, 0), 2000)); return "look at the eye"; },
  report: () => `${document.getElementById("verdict").innerText}\n\n${document.getElementById("summary").textContent}`,
};
console.log("%cthe-eye%c is timing this page's frames from inside. Make it miss some: eye.freeze(300), then eye.report().", "font-weight:700", "font-weight:400");
