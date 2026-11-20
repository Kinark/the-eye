// the-eye show-off: wires the page together. Each section is its own module; they share one clock (meter.js).
import { cutAll } from "./squircle.js";
import { tilt } from "./spring.js";
import { iris } from "./iris.js";
import { hero, freeze } from "./hero.js";
import { witness, notice } from "./witness.js";
import { puck } from "./puck.js";
import { replay } from "./replay.js";
import { corner } from "./corner.js";
import { outside } from "./outside.js";

cutAll();
for (const el of document.querySelectorAll("[data-tilt]")) tilt(el);

iris(document.getElementById("iris"));
witness();
hero();
puck();
corner();
outside();
replay().catch((e) => { document.getElementById("replay-report").textContent = `The recording did not load: ${e.message}. Is the page served by bun run show-off?`; });

// The install line carries the real path of this checkout, as the server reports it. As a plugin it is two lines, and
// the same wherever the checkout is. The same answer says what each chapter of the manual costs to read, off the disk.
const cmd = document.getElementById("cmd-text"), copy = document.getElementById("copy"), how = document.getElementById("how"), cmdNote = document.getElementById("cmd-note");
const HOW = {
  server: { text: "claude mcp add the-eye -- bun src/index.ts", note: "Runs this checkout. The manual's outline reaches the agent as the server's instructions." },
  plugin: { text: "/plugin marketplace add Kinark/the-eye\n/plugin install the-eye@the-eye", note: "Brings the server and the manual as a skill together, and runs bun install by itself on its first start. Use one or the other, not both: two servers would queue behind each other." },
};
const showHow = () => { const h = HOW[new FormData(how).get("how")]; cmd.textContent = h.text; cmdNote.textContent = h.note; };
how.addEventListener("input", showHow);
how.addEventListener("submit", (e) => e.preventDefault());
fetch("/config.json").then((r) => r.json()).then((c) => {
  HOW.server.text = `claude mcp add the-eye -- bun ${c.repo}/src/index.ts`;
  showHow();
  for (const el of document.querySelectorAll("[data-chapter]")) {
    const n = c.manual?.[el.dataset.chapter];
    if (n) el.textContent = n.toLocaleString("en-US");
  }
}).catch(() => {});
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
