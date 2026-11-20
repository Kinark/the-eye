// bun test/web.mjs — the website path end to end in a headless browser of its own (no screen, no input, no lock):
// open a fixture page, record with the page probe, press things through the DevTools protocol, and check that the
// report names the script that blocked, the CSS transition as declared, what the console said and the layout shift.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.THE_EYE_HEADLESS = "1";
process.env.THE_EYE_BROWSER_DIR = mkdtempSync(join(tmpdir(), "eye-web-browser-"));
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = await import("../src/web.ts");
web.setWebRoot(ROOT);

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     ${String(detail).slice(0, 1500).replace(/\n/g, "\n     ")}`}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Served over http like a dev server (a file:// page is an opaque origin: its scripts go unattributed in long frames).
const { createServer } = await import("node:http");
const server = createServer((req, res) => {
  if (req.url !== "/") { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html" }); res.end(readFileSync(join(ROOT, "test", "fixtures", "page.html")));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

async function click(q) {
  const r = await web.pageTool({ op: "js", js: `(() => { const f = __eye.find(${JSON.stringify(q)}); return f.ok ? [f.x, f.y] : f.why; })()` });
  if (!r.ok || !Array.isArray(r.value)) throw new Error(`cannot click ${q}: ${r.ok ? r.value : r.error}`);
  const [x, y] = r.value, c = web.pageCdp();
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

try {
  const t0 = Date.now();
  const o = await web.openPage({ url });
  check("opens the page in a browser of its own", o.ok && o.pid > 0, JSON.stringify(o));
  if (!o.ok) throw new Error(o.error);
  console.log(`     ${o.name} pid ${o.pid} gpu ${o.gpuPid} in ${Date.now() - t0}ms`);
  const bad = await web.openPage({ url: "http://127.0.0.1:59999/nothing" });
  check("a dev server that is not running is said plainly", !bad.ok && /did not load.*CONNECTION_REFUSED.*dev server/.test(bad.error), JSON.stringify(bad));
  await web.openPage({ url });
  const s = await web.startPageProbe({ label: "web-test", watch: ["#box"] });
  check("page probe starts", s.ok, JSON.stringify(s));

  const f = await web.pageFind({ q: "Move the box" });
  check("finds a button by what it is called", f.ok && /button #move/.test(f.label), JSON.stringify(f));
  const off = await web.pageFind({ q: "Disabled one", timeout_ms: 300 });
  check("a disabled button is not pressable, and says so", !off.ok && /disabled/.test(off.error), JSON.stringify(off));
  const none = await web.pageFind({ q: "#nope", timeout_ms: 200 });
  check("nothing matching is said plainly", !none.ok && /nothing on the page matches/.test(none.error), JSON.stringify(none));
  await web.pageTool({ op: "js", js: `document.getElementById("cover").style.display = "block"` });
  const cov = await web.pageFind({ q: "#move", timeout_ms: 200 });
  check("a covered button is not pressable, and names what covers it", !cov.ok && /covered by #cover/.test(cov.error), JSON.stringify(cov));
  await web.pageTool({ op: "js", js: `document.getElementById("cover").style.display = "none"` });

  await sleep(1500); // the late banner lands (a layout shift without input)
  await click("#move");
  await sleep(600);
  await click("#block");
  await sleep(400);
  await click("#boom");
  const ty = await web.pageTool({ op: "type", text: "Ada L.", on: "Your name" });
  check("types into a field found by its label", ty.ok && /into #name/.test(ty.note), JSON.stringify(ty));
  const val = await web.pageTool({ op: "js", js: `document.getElementById("name").value` });
  check("the field holds what was typed", val.ok && val.value === "Ada L.", JSON.stringify(val));
  await web.pageTool({ op: "key", key: "Meta+a" });
  await web.pageTool({ op: "key", key: "Backspace" });
  const val2 = await web.pageTool({ op: "js", js: `document.getElementById("name").value` });
  check("Meta+a then Backspace clears it", val2.ok && val2.value === "", JSON.stringify(val2));
  await sleep(700);

  const live = web.pageLive();
  check("live view has frames and elements", live && live.ticks > 10 && live.layers_tracked > 0 && live.stalls >= 1, JSON.stringify(live)?.slice(0, 400));
  const said = web.pageSaid();
  check("the page said the console error and the exception", /console\.error: fixture went wrong/.test(said) && /uncaught Error: fixture exploded/.test(said), said);
  check("…and the slow answer and the layout shift", /slow answer to (click|pointerup|pointerdown) on button#block|slow answer to \w+ on #block/.test(said) && /layout shift/.test(said), said);
  check("said once: the next call has only what is new", web.pageSaid() === "", "");
  const tree = await web.pageTree();
  check("the tree lists buttons with names and states", /button #move "Move the box"/.test(tree) && /button #off "Disabled one" .*\(disabled\)/.test(tree) && /textbox #name "Your name"/.test(tree), tree);

  const dir = mkdtempSync(join(tmpdir(), "eye-web-run-"));
  const st = web.pageStalls(dir);
  check("stalls name blockMainThread with its line", st && st.stalls.some((x) => x.ms >= 190 && x.lines?.some((l) => /blockMainThread 127\.0\.0\.1:\d+:25/.test(l))), JSON.stringify(st)?.slice(0, 800));
  const report = await web.stopPageProbe(() => dir, { top: 5 });
  check("report: the declared CSS transition, ease-out 0.3s", /CSS transition on transform.*0\.3s ease-out = cubic-bezier\(0, 0, 0\.58, 1\)/.test(report), report);
  check("report: on the compositor", /on the compositor/.test(report), report);
  check("report: the long frame and its script", /long animation frames over 50ms\): [1-9]/.test(report) && /blockMainThread 127\.0\.0\.1:\d+:25 ran 2\d\dms/.test(report), report);
  check("report: what the page said, slow input, layout shift", /THE PAGE ITSELF/.test(report) && /fixture exploded/.test(report) && /slow answers to input/.test(report) && /layout shifts not caused by input: [1-9].*\n.*#banner|layout shifts not caused by input: [1-9][\s\S]*(#banner|button|#box)/.test(report), report);
  const nd = readFileSync(join(dir, "probe.ndjson"), "utf8");
  check("probe.ndjson in EyeProbe's format", /^\{"k":"S".*"stall_ms":50.*"web":true/.test(nd) && /"k":"H"/.test(nd) && /"k":"A".*"tf":\[0,0,0\.58,1\]/.test(nd), nd.slice(0, 300));
  if (process.env.VERBOSE) console.log(report);
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  console.log(await web.quitBrowser());
  server.close();
}
console.log(failed ? `${failed} FAILED` : "all ok");
process.exit(failed ? 1 : 0);
