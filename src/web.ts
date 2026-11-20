// Websites: a dedicated Chromium-family browser, driven over the DevTools protocol (CDP, the runtime's own WebSocket), with
// renderer accessibility forced on so the Swift hand, the AX tree and the window capture work on web content as they
// do on any app. Inside each document of the session's tab runs src/eye-page.js, the web twin of EyeProbe: every
// animation frame's element geometry, the CSS / Web Animations the page declared, long animation frames with the
// scripts that ran in them, slow answers to input and layout shifts. At the end it becomes a probe.ndjson in
// EyeProbe's own format on the capture's clock, so probe.ts / notice.ts read a website exactly like an app.
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen } from "bun:ffi";
import { analyzeProbe, cssBezier } from "./probe.ts";
import type { Stall, Stalls } from "./notice.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let root = "";
export function setWebRoot(r: string) { root = r; }
const CACHE = join(homedir(), "Library", "Caches", "the-eye");

// ---- the browser

type Found = { exe: string; name: string };
const BROWSERS: [string, string][] = [
  ["Google Chrome for Testing.app", "Google Chrome for Testing"], ["Chromium.app", "Chromium"], ["Google Chrome.app", "Google Chrome"],
  ["Brave Browser.app", "Brave Browser"], ["Microsoft Edge.app", "Microsoft Edge"], ["Google Chrome Canary.app", "Google Chrome Canary"],
];
function exeOf(path: string): Found | null {
  if (path.endsWith(".app") || path.endsWith(".app/")) {
    const app = path.replace(/\/$/, ""), name = basename(app, ".app");
    try {
      const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
      const m = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
      const exe = join(app, "Contents", "MacOS", m ? m[1] : name);
      return existsSync(exe) ? { exe, name } : null;
    } catch { return null; }
  }
  return existsSync(path) ? { exe: path, name: basename(path) } : null;
}
/** THE_EYE_BROWSER (an .app or its binary), else the first Chromium-family browser installed; `want` picks by name. */
export function findBrowser(want?: string): Found | { error: string } {
  const pick = want || process.env.THE_EYE_BROWSER;
  if (pick && pick.includes("/")) return exeOf(pick) ?? { error: `no browser at ${pick}` };
  const dirs = ["/Applications", join(homedir(), "Applications")];
  for (const [app] of BROWSERS) {
    if (pick && !app.toLowerCase().includes(pick.toLowerCase())) continue;
    for (const d of dirs) { const f = exeOf(join(d, app)); if (f) return f; }
  }
  return { error: pick ? `no installed browser matches "${pick}" (looked for ${BROWSERS.map(([a]) => a.replace(".app", "")).join(", ")})`
    : `no Chromium-family browser installed: install Google Chrome, Chromium, Brave or Edge, or set THE_EYE_BROWSER to one (Safari and Firefox have no DevTools protocol the eye can drive)` };
}
const profileOf = (name: string) => join(process.env.THE_EYE_BROWSER_DIR || join(CACHE, "browser"), name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));

function sh(cmd: string, args: string[], ms = 3000): Promise<string> {
  return new Promise((res) => execFile(cmd, args, { timeout: ms, maxBuffer: 16 << 20 }, (_e, out) => res(String(out ?? ""))));
}
async function getJson(url: string, ms = 1500): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
/** The browser process for a profile (no --type=), and its GPU process: the one that hands frames to the window server. */
async function pidsOf(profile: string): Promise<{ pid: number; gpu?: number }> {
  const rows = (await sh("ps", ["-axww", "-o", "pid=,ppid=,args="])).split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean) as RegExpMatchArray[];
  const main = rows.find((m) => m[3].includes(`--user-data-dir=${profile}`) && !m[3].includes("--type="));
  if (!main) return { pid: 0 };
  const gpu = rows.find((m) => m[2] === main[1] && m[3].includes("--type=gpu-process"));
  return { pid: Number(main[1]), gpu: gpu ? Number(gpu[1]) : undefined };
}

type Browser = { exe: string; name: string; profile: string; port: number; pid: number; gpu?: number; cdp: Cdp; headless: boolean };
let browser: Browser | null = null;

async function ensureBrowser(want?: string, launch = true): Promise<{ ok: true; b: Browser; launched: boolean } | { ok: false; error: string }> {
  if (browser && !browser.cdp.closed && (!want || browser.name.toLowerCase().includes(want.toLowerCase()) || want.includes("/"))) return { ok: true, b: browser, launched: false };
  const f = findBrowser(want);
  if ("error" in f) return { ok: false, error: f.error };
  const profile = profileOf(f.name), portFile = join(profile, "DevToolsActivePort");
  const headless = process.env.THE_EYE_HEADLESS === "1";
  const attach = async (): Promise<Browser | null> => {
    try {
      const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
      if (!port) return null;
      const v = await getJson(`http://127.0.0.1:${port}/json/version`);
      const cdp = await Cdp.open(v.webSocketDebuggerUrl);
      const p = await pidsOf(profile);
      return { exe: f.exe, name: f.name, profile, port, pid: p.pid, gpu: p.gpu, cdp, headless };
    } catch { return null; }
  };
  // One already running on this profile (an earlier session, or this server restarted): use it as it is.
  const again = existsSync(portFile) ? await attach() : null;
  if (again && again.pid) { browser = again; return { ok: true, b: again, launched: false }; }
  if (!launch) return { ok: false, error: `${f.name} is not running on the eye's profile` };
  mkdirSync(profile, { recursive: true });
  rmSync(portFile, { force: true });
  const args = [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--force-renderer-accessibility", "--no-first-run", "--no-default-browser-check",
    // A page being measured must not be throttled for being behind another window or in the background.
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion,Translate", "--hide-crash-restore-bubble", "--password-store=basic", "--use-mock-keychain",
    ...(headless ? ["--headless=new", "--window-size=1280,800"] : []), "about:blank",
  ];
  try {
    const child = spawn(f.exe, args, { detached: true, stdio: "ignore", env: { ...process.env, GOOGLE_API_KEY: "no", GOOGLE_DEFAULT_CLIENT_ID: "no", GOOGLE_DEFAULT_CLIENT_SECRET: "no" } });
    child.on("error", () => { /* reported below as "did not start" */ });
    child.unref();
  } catch (e: any) { return { ok: false, error: `could not start ${f.name}: ${e.message}` }; }
  for (const until = Date.now() + 20000; Date.now() < until; await sleep(150)) {
    if (!existsSync(portFile)) continue;
    const b = await attach();
    if (b && b.pid) { browser = b; return { ok: true, b, launched: true }; }
  }
  return { ok: false, error: `${f.name} did not open its DevTools port within 20s (profile ${profile}); is another copy stuck on that profile?` };
}

// ---- CDP

class Cdp {
  ws: any; seq = 0; closed = false;
  pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }>();
  handlers = new Map<string, ((p: any) => void)[]>();
  closers: (() => void)[] = [];
  static open(url: string, ms = 5000): Promise<Cdp> {
    return new Promise((res, rej) => {
      const c = new Cdp(), WS = (globalThis as any).WebSocket;
      if (!WS) { rej(new Error("this runtime has no global WebSocket")); return; }
      const ws = new WS(url);
      c.ws = ws;
      const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } rej(new Error(`DevTools connection to ${url} timed out`)); }, ms);
      ws.onopen = () => { clearTimeout(timer); res(c); };
      ws.onerror = () => { clearTimeout(timer); rej(new Error(`DevTools refused the connection to ${url}`)); };
      ws.onclose = () => {
        c.closed = true;
        for (const p of c.pending.values()) { clearTimeout(p.timer); p.rej(new Error("the browser closed the DevTools connection")); }
        c.pending.clear();
        for (const f of c.closers) f();
      };
      ws.onmessage = (ev: any) => {
        let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.id !== undefined) {
          const p = c.pending.get(m.id);
          if (!p) return;
          c.pending.delete(m.id); clearTimeout(p.timer);
          if (m.error) p.rej(new Error(`${m.error.message}${m.error.data ? ` (${m.error.data})` : ""}`)); else p.res(m.result);
        } else if (m.method) for (const f of c.handlers.get(m.method) ?? []) { try { f(m.params); } catch { /* a handler's bug is not the page's */ } }
      };
    });
  }
  send(method: string, params: any = {}, ms = 5000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("the browser closed the DevTools connection"));
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} got no answer in ${ms}ms (the page's main thread is busy, or a dialog is open)`)); }, ms);
      this.pending.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(ev: string, f: (p: any) => void) { if (!this.handlers.has(ev)) this.handlers.set(ev, []); this.handlers.get(ev)!.push(f); }
  close() { try { this.ws.close(); } catch { /* */ } }
}

// ---- the page

type Said = { t: number; line: string; n: number };
type Page = { cdp: Cdp; targetId: string; scriptId?: string; said: Said[]; saidAt: number; url: string; loads: (() => void)[] };
let page: Page | null = null;
let VERSION = "";
function pageScript(record: boolean): string {
  const src = readFileSync(join(root || join(dirname(fileURLToPath(import.meta.url)), ".."), "src", "eye-page.js"), "utf8");
  if (!VERSION) VERSION = `${src.length.toString(36)}-${Date.now().toString(36)}`;
  return src.replace("__EYE_VERSION__", VERSION).replace("__EYE_RECORD__", record ? "1" : "0");
}
async function register(p: Page, record: boolean) {
  if (p.scriptId) await p.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: p.scriptId }).catch(() => {});
  const src = pageScript(record);
  p.scriptId = (await p.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: src })).identifier;
  await p.cdp.send("Runtime.evaluate", { expression: src }, 3000).catch(() => {});
}
/** Run an expression in the page; its value, or the error it threw. */
async function evaluate(expr: string, ms = 3000, awaitPromise = false): Promise<{ ok: true; value: any } | { ok: false; error: string }> {
  if (!page || page.cdp.closed) return { ok: false, error: "no page open (eye_drive {url} opens one)" };
  try {
    const r = await page.cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise, timeout: ms, userGesture: true }, ms + 1000);
    if (r.exceptionDetails) return { ok: false, error: `the page threw: ${r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text}` };
    return { ok: true, value: r.result?.value };
  } catch (e: any) { return { ok: false, error: e.message }; }
}
/** The page probe's API, re-installed first if the document lost it (a navigation the new-document script missed). */
async function eye(call: string, ms = 3000) {
  const r = await evaluate(`window.__eye ? window.__eye.${call} : "__noeye"`, ms);
  if (r.ok && r.value === "__noeye" && page) {
    await page.cdp.send("Runtime.evaluate", { expression: pageScript(!!probe) }, 3000).catch(() => {});
    return evaluate(`window.__eye ? window.__eye.${call} : null`, ms);
  }
  return r;
}

function say(line: string) {
  if (!page) return;
  const last = page.said[page.said.length - 1];
  if (last && last.line === line) { last.n++; return; }
  page.said.push({ t: Date.now(), line, n: 1 });
  if (page.said.length > 500) page.said.splice(0, 100);
}
const where = (u?: string, line?: number) => (u ? ` (${u.replace(/^.*\//, "").slice(0, 60) || u}${line !== undefined ? `:${line + 1}` : ""})` : "");
function listen(p: Page) {
  const c = p.cdp;
  c.on("Runtime.consoleAPICalled", (e) => {
    if (!["error", "warning", "assert"].includes(e.type)) return;
    const text = (e.args ?? []).map((a: any) => a.value !== undefined ? String(a.value) : a.description ?? a.type).join(" ").slice(0, 300);
    const f = e.stackTrace?.callFrames?.[0];
    say(`console.${e.type === "warning" ? "warn" : e.type}: ${text}${f ? where(f.url, f.lineNumber) : ""}`);
  });
  c.on("Runtime.exceptionThrown", (e) => {
    const d = e.exceptionDetails;
    say(`uncaught ${(d.exception?.description ?? d.text ?? "exception").split("\n")[0].slice(0, 300)}${where(d.url, d.lineNumber)}`);
  });
  c.on("Log.entryAdded", (e) => {
    const x = e.entry;
    if (!["error", "warning"].includes(x.level) || x.source === "console-api") return;
    say(`${x.source} ${x.level}: ${String(x.text).slice(0, 300)}${x.url && !String(x.text).includes(x.url) ? ` — ${x.url.slice(0, 120)}` : ""}`);
  });
  c.on("Page.javascriptDialogOpening", (e) => say(`a ${e.type} dialog is open and blocks the page until answered: "${String(e.message).slice(0, 120)}"`));
  c.on("Page.frameNavigated", (e) => { if (!e.frame.parentId) { p.url = e.frame.url; say(`navigated to ${e.frame.url}`); } });
  c.on("Page.loadEventFired", () => { for (const f of p.loads.splice(0)) f(); });
  c.on("Inspector.targetCrashed", () => say("THE PAGE CRASHED (renderer gone): reload it"));
  c.closers.push(() => { if (page === p) { say("the tab was closed"); page = null; } });
}
function waitLoad(p: Page, ms: number): Promise<boolean> {
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    p.loads.push(() => { clearTimeout(t); res(true); });
  });
}
async function navigate(p: Page, url: string, reload = false): Promise<string> {
  const loaded = waitLoad(p, 20000);
  if (reload) await p.cdp.send("Page.reload", {});
  else {
    const r = await p.cdp.send("Page.navigate", { url }, 20000);
    if (r.errorText) { p.url = ""; return `${url} did not load: ${r.errorText}${/CONNECTION_REFUSED/.test(r.errorText) ? " (is the dev server running?)" : ""}`; } // the tab shows an error page now
    if (!r.loaderId) return ""; // same document (a #hash): nothing loads
  }
  return (await loaded) ? "" : `${url || "the page"} is still loading after 20s (its load event never fired); carrying on with it as it is`;
}

export type OpenResult = { ok: true; pid: number; name: string; gpuPid?: number; launched: boolean; note: string } | { ok: false; error: string };
/** One tab in one window of the eye's own browser, showing `url`, the page probe in it. */
export async function openPage(o: { url: string; viewport?: { w: number; h: number }; reload?: boolean; browser?: string }): Promise<OpenResult> {
  const got = await ensureBrowser(o.browser);
  if (!got.ok) return got;
  const b = got.b;
  const url = /^[a-z][a-z0-9+.-]*:/i.test(o.url) ? o.url : /^(localhost|127\.|\[::1\]|[\w-]+:\d+)/.test(o.url) ? `http://${o.url}` : o.url.startsWith("/") ? `file://${o.url}` : `https://${o.url}`;
  const notes: string[] = [];
  try {
    let targets: any[] = (await b.cdp.send("Target.getTargets")).targetInfos.filter((t: any) => t.type === "page");
    let keep = (page && !page.cdp.closed && targets.find((t) => t.targetId === page!.targetId)) || targets.find((t) => t.url === url) || targets[0];
    for (const t of targets) if (t !== keep) await b.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    if (!keep) keep = { targetId: (await b.cdp.send("Target.createTarget", { url: "about:blank", newWindow: true })).targetId, url: "about:blank" };
    if (!page || page.targetId !== keep.targetId || page.cdp.closed) {
      if (page) page.cdp.close();
      const cdp = await Cdp.open(`ws://127.0.0.1:${b.port}/devtools/page/${keep.targetId}`);
      page = { cdp, targetId: keep.targetId, said: [], saidAt: 0, url: keep.url, loads: [] };
      listen(page);
      await Promise.all(["Page.enable", "Runtime.enable", "Log.enable", "Inspector.enable"].map((m) => cdp.send(m)));
      await register(page, !!probe);
    }
    const p = page;
    if (o.reload || p.url !== url) { const n = await navigate(p, url, !!o.reload && p.url === url); if (n) { if (/did not load/.test(n)) return { ok: false, error: n }; notes.push(n); } }
    if (o.viewport && !b.headless) {
      const v = await eye("view()");
      const { windowId } = await b.cdp.send("Browser.getWindowForTarget", { targetId: p.targetId });
      await b.cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => {});
      if (v.ok && v.value) {
        const w = o.viewport.w + (v.value.ow - v.value.iw), h = o.viewport.h + (v.value.oh - v.value.ih);
        await b.cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: Math.round(w), height: Math.round(h) } });
        await sleep(150);
        const v2 = await eye("view()");
        if (v2.ok && v2.value && (v2.value.iw !== o.viewport.w || v2.value.ih !== o.viewport.h)) notes.push(`viewport is ${v2.value.iw}×${v2.value.ih} (asked ${o.viewport.w}×${o.viewport.h}: the screen is smaller, or the browser keeps a minimum)`);
      }
    }
    await p.cdp.send("Page.bringToFront").catch(() => {});
    const v = await eye("view()");
    if (v.ok && v.value?.ready === "loading") notes.push("the page is still loading");
    const pids = await pidsOf(b.profile);
    if (pids.pid) { b.pid = pids.pid; b.gpu = pids.gpu; }
    return { ok: true, pid: b.pid, name: b.name, gpuPid: b.gpu, launched: got.launched, note: notes.join("; ") };
  } catch (e: any) { return { ok: false, error: `${b.name}: ${e.message}` }; }
}
export const pageOpen = () => !!page && !page.cdp.closed;
export const pageActive = () => !!probe && pageOpen();
export function pageCdp(): Cdp | null { return page?.cdp ?? null; } // tests drive input through this

/** Stop listening (the probe already stopped); the tab and the browser stay up for the next session. */
export function closePage() {
  if (probe) { clearInterval(probe.timer); probe = null; }
  if (page) { const p = page; page = null; p.cdp.close(); }
}
export async function quitBrowser(): Promise<string> {
  closePage();
  if (!browser) { const r = await ensureBrowser(undefined, false); if (!r.ok) return ""; } // one an earlier server started
  const b = browser!; browser = null;
  await b.cdp.send("Browser.close", {}, 3000).catch(() => {});
  for (let i = 0; i < 30 && (await pidsOf(b.profile)).pid; i++) await sleep(100);
  return `${b.name} quit`;
}

// ---- where a CSS pixel is on screen

type View = { url: string; title: string; ready: string; iw: number; ih: number; ow: number; oh: number; sx: number; sy: number; origin: number[] | null; scale: number; vx: number; vy: number; dpr: number; scrollX: number; scrollY: number; focus: string; sh: number; sw: number };
let lastView: View | null = null;
/** CSS px in the layout viewport → global screen points. A real pointer event calibrates it exactly; until one, the content is assumed to sit under the toolbar, centred. */
function toScreen(v: View, x: number, y: number): [number, number] {
  const cx = v.origin ? v.origin[0] - v.sx : (v.ow - v.iw) / 2, cy = v.origin ? v.origin[1] - v.sy : v.oh - v.ih;
  return [v.sx + cx + (x - v.vx) * v.scale, v.sy + cy + (y - v.vy) * v.scale];
}
const rectToScreen = (v: View, r: number[]): number[] => { const [x, y] = toScreen(v, r[0], r[1]); return [x, y, r[2] * v.scale, r[3] * v.scale]; };

export async function pageFind(o: { q: string; timeout_ms?: number }): Promise<{ ok: true; x: number; y: number; rect: number[]; label: string } | { ok: false; error: string }> {
  const until = Date.now() + (o.timeout_ms ?? 5000);
  let why = "", prev: number[] | null = null;
  for (;;) {
    const r = await eye(`find(${JSON.stringify(o.q)}, true)`);
    const v = await eye("view()");
    if (!r.ok) why = r.error;
    else if (!r.value) why = "the page probe is not in this document";
    else if (!r.value.ok) why = r.value.why;
    else if (r.value.disabled) why = `${r.value.label} is disabled`;
    else if (r.value.covered) why = `${r.value.label} is covered by ${r.value.covered} at its centre`;
    else if (r.value.scrolled || !prev || r.value.rect.some((x: number, i: number) => Math.abs(x - prev![i]) > 0.5)) { why = `${r.value.label} is still moving`; prev = r.value.rect; }
    else if (v.ok && v.value) {
      lastView = v.value;
      const [x, y] = toScreen(v.value, r.value.x, r.value.y);
      return { ok: true, x, y, rect: rectToScreen(v.value, r.value.rect), label: `${r.value.label}${r.value.matches > 1 ? ` (first visible of ${r.value.matches})` : ""}` };
    }
    if (!r.ok || !r.value?.ok || r.value.disabled || r.value.covered) prev = null;
    if (Date.now() > until) return { ok: false, error: `${why} (waited ${o.timeout_ms ?? 5000}ms)` };
    await sleep(50);
  }
}

// ---- input the page gets straight from the browser: typing, keys, navigation, script

const KEYS: Record<string, [string, number, string?]> = {
  enter: ["Enter", 13, "\r"], return: ["Enter", 13, "\r"], tab: ["Tab", 9], escape: ["Escape", 27], esc: ["Escape", 27], backspace: ["Backspace", 8], delete: ["Delete", 46],
  arrowup: ["ArrowUp", 38], arrowdown: ["ArrowDown", 40], arrowleft: ["ArrowLeft", 37], arrowright: ["ArrowRight", 39], up: ["ArrowUp", 38], down: ["ArrowDown", 40], left: ["ArrowLeft", 37], right: ["ArrowRight", 39],
  home: ["Home", 36], end: ["End", 35], pageup: ["PageUp", 33], pagedown: ["PageDown", 34], space: [" ", 32, " "],
};
const MODS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const MAC_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };
function keyEvent(k: string, mods = 0): any | null {
  const named = KEYS[k.toLowerCase()];
  if (named) return { key: named[0], code: named[0] === " " ? "Space" : named[0], windowsVirtualKeyCode: named[1], text: mods & ~8 ? undefined : named[2] };
  if ([...k].length !== 1) return null;
  const up = k.toUpperCase();
  const code = /[a-z]/i.test(k) ? `Key${up}` : /\d/.test(k) ? `Digit${k}` : undefined;
  const text = mods & ~8 ? undefined : mods & 8 ? up : k;
  return { key: mods & 8 ? up : k, code, windowsVirtualKeyCode: /[a-z\d]/i.test(k) ? up.charCodeAt(0) : undefined, text };
}
async function press(c: Cdp, ev: any, mods: number, commands?: string[]) {
  await c.send("Input.dispatchKeyEvent", { type: ev.text ? "keyDown" : "rawKeyDown", modifiers: mods, ...ev, unmodifiedText: ev.text, commands });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: mods, key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.windowsVirtualKeyCode });
}

export type WebStep = { op: string; text?: string; key?: string; url?: string; js?: string; on?: string; interval_ms?: number; timeout_ms?: number };
export async function pageTool(s: WebStep): Promise<{ ok: true; note: string; value?: any } | { ok: false; error: string }> {
  if (!page || page.cdp.closed) return { ok: false, error: "no page open: eye_drive {url} opens one" };
  const c = page.cdp;
  try {
    if (s.op === "type") {
      if (s.text === undefined) return { ok: false, error: "type needs text" };
      if (s.on !== undefined) { const r = await eye(`focusOn(${JSON.stringify(s.on)})`); if (!r.ok) return r; if (r.value) return { ok: false, error: r.value }; }
      for (const ch of s.text) {
        const ev = ch === "\n" ? keyEvent("enter") : /^[ -~]$/.test(ch) ? keyEvent(ch === " " ? "space" : ch) : null;
        if (ev) await press(c, { ...ev, key: ch === "\n" ? "Enter" : ch }, ch !== ch.toLowerCase() ? 8 : 0);
        else await c.send("Input.insertText", { text: ch });
        if (s.interval_ms !== 0) await sleep(s.interval_ms ?? 25);
      }
      const f = await eye("view().focus");
      return { ok: true, note: `typed ${s.text.length} characters${f.ok && f.value ? ` into ${f.value}` : " (nothing on the page has focus: they went to the document)"}` };
    }
    if (s.op === "key") {
      if (!s.key) return { ok: false, error: "key needs key, like \"Enter\", \"Shift+Tab\" or \"Meta+a\"" };
      const parts = s.key.split("+").filter(Boolean), last = parts.pop()!;
      let mods = 0;
      for (const m of parts) { const b = MODS[m.toLowerCase()]; if (b === undefined) return { ok: false, error: `unknown modifier "${m}" (Alt, Ctrl, Meta, Shift)` }; mods |= b; }
      const ev = keyEvent(last, mods);
      if (!ev) return { ok: false, error: `unknown key "${last}" (a character, or Enter, Tab, Escape, Backspace, Delete, Arrow…, Home, End, PageUp, PageDown, Space)` };
      // macOS editing shortcuts are commands the browser runs, not something a synthetic key event triggers by itself.
      const cmd = mods === 4 ? MAC_COMMANDS[last.toLowerCase()] : mods === 12 && last.toLowerCase() === "z" ? "redo" : undefined;
      await press(c, ev, mods, cmd ? [cmd] : undefined);
      return { ok: true, note: `pressed ${s.key}` };
    }
    if (s.op === "goto" || s.op === "reload") {
      if (s.op === "goto" && !s.url) return { ok: false, error: "goto needs url" };
      const n = await navigate(page, s.url ?? page.url, s.op === "reload");
      return n && /did not load/.test(n) ? { ok: false, error: n } : { ok: true, note: n || `${s.op === "reload" ? "reloaded" : "loaded"} ${page?.url ?? s.url}` };
    }
    if (s.op === "js") {
      if (!s.js) return { ok: false, error: "js needs js" };
      const r = await evaluate(s.js, s.timeout_ms ?? 3000, true);
      return r.ok ? { ok: true, note: JSON.stringify(r.value)?.slice(0, 300) ?? "undefined", value: r.value } : r;
    }
    return { ok: false, error: `${s.op} is not a page op (type, key, goto, reload, js)` };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

/** What can be pressed or read in the window, with where it is on screen. */
export async function pageTree(max = 150): Promise<string> {
  const [t, v] = [await eye(`tree(${max})`), await eye("view()")];
  if (!t.ok) return `page: ${t.error}`;
  if (!t.value || !v.ok || !v.value) return "page: the page probe is not in this document";
  const vw: View = v.value;
  lastView = vw;
  const out = [`${vw.url} · "${vw.title}" · viewport ${vw.iw}×${vw.ih} css px${vw.scale !== 1 ? ` (pinch ${vw.scale.toFixed(2)}×)` : ""} · scrolled ${Math.round(vw.scrollX)},${Math.round(vw.scrollY)} of ${vw.sw}×${vw.sh}${vw.focus ? ` · focus ${vw.focus}` : ""}${vw.ready !== "complete" ? ` · ${vw.ready}` : ""}${vw.origin ? "" : " · screen rects estimated until the pointer moves over the page"}`];
  for (const it of t.value.items) {
    const r = rectToScreen(vw, it.rect).map(Math.round);
    out.push(`${it.role} ${it.sel}${it.name ? ` "${it.name}"` : ""} [${r[0]},${r[1]} ${r[2]}×${r[3]}]${it.st.length ? ` (${it.st.join(", ")})` : ""}${it.value !== undefined ? ` = ${JSON.stringify(it.value)}` : ""}`);
  }
  if (t.value.hidden) out.push(`… ${t.value.hidden} more outside the window or past ${max}`);
  return out.join("\n");
}

// ---- the probe

type Rec = { k: string; t?: number; [x: string]: any };
type Probe = {
  label: string; watch: string[]; started: number; mach: number; timer: NodeJS.Timeout; busy: boolean; recs: Rec[]; file: string;
  els: Map<number, Rec>; dropped: number; watched: any[]; seenLs: number; seenEv: number; hz: number;
};
let probe: Probe | null = null;
// Wall ms → mach seconds, the clock the capture and EyeProbe use. Bun's process.hrtime counts from the start of the
// process (Node's was mach_absolute_time), so the system is asked: CLOCK_UPTIME_RAW is mach_absolute_time in ns.
const CLOCK_UPTIME_RAW = 8;
const libSystem = dlopen("libSystem.B.dylib", { clock_gettime_nsec_np: { args: ["i32"], returns: "u64" } }).symbols;
const machOffset = () => Number(libSystem.clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1e9 - Date.now() / 1000;
const sources = new Map<string, string | null>();
function fetchSource(url: string) {
  if (!url || sources.has(url)) return;
  sources.set(url, null);
  if (url.startsWith("file://")) { try { sources.set(url, readFileSync(fileURLToPath(url), "utf8")); } catch { /* */ } return; }
  if (/^https?:/.test(url)) fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.text() : null)).then((t) => sources.set(url, t)).catch(() => {});
}
function lineOf(url: string, pos: number, fn?: string): number | null {
  const s = sources.get(url);
  if (!s || pos === undefined || pos < 0) return null;
  // An inline <script> counts its position from its own start, not the document's: find the function by name instead.
  if (/^\s*<|<script/i.test(s.slice(0, 2000))) {
    if (!fn) return null;
    const esc = fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`function\\s*\\*?\\s*${esc}\\s*\\(|\\b${esc}\\s*[:=]\\s*(async\\s*)?(function|\\()`).exec(s);
    if (!m) return null;
    pos = m.index;
  }
  let n = 1;
  for (let i = 0; i < Math.min(pos, s.length); i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
const srcName = (u: string) => { try { const x = new URL(u); return x.pathname.replace(/\/$/, "").split("/").pop() || x.host || u; } catch { return u; } };
/** A script that ran in a long animation frame, as a person would look for it: function, file:line. */
function scriptName(s: any): string {
  const ln = s.src ? lineOf(s.src, s.pos, s.fn) : null;
  return `${s.fn || "(anonymous)"}${s.src ? ` ${srcName(s.src)}${ln ? `:${ln}` : ""}` : ""}`;
}
function loafStall(l: Rec, off: number): Stall & { lines: string[] } {
  const scripts: any[] = l.scripts ?? [];
  const lines = scripts.slice(0, 4).map((s) => `${scriptName(s)} ran ${Math.round(s.ms)}ms · ${s.type ?? "script"} ${String(s.inv ?? "").slice(0, 70)}${s.forced >= 5 ? ` · ${Math.round(s.forced)}ms forced style/layout` : ""}${s.pause >= 5 ? ` · ${Math.round(s.pause)}ms paused (sync XHR / alert)` : ""}`);
  if (l.style >= 5) lines.push(`style & layout at the end of the frame: ${Math.round(l.style)}ms`);
  const ran = scripts.reduce((t, s) => t + (s.ms ?? 0), 0);
  if (!scripts.length) lines.push(l.block === undefined ? "no script attribution (this browser has no Long Animation Frames API): a long task"
    : "no script of the page's own ran over 5ms in it (scripts from another origin, and file:// pages, are not attributed): rendering, garbage collection, or someone else's script");
  else if (l.ms - ran - (l.style ?? 0) > 30) lines.push(`${Math.round(l.ms - ran - (l.style ?? 0))}ms not in any script: rendering, garbage collection, or work the page does not own`);
  return { t: l.t! / 1000 + off, ms: l.ms, n: 0, app: scripts.map((s) => [scriptName(s), Math.round(s.ms)] as [string, number]), leaf: scripts.map((s) => [`${s.type ?? "script"} ${s.inv ?? ""}`.trim(), Math.round(s.ms)] as [string, number]), stack: [], lines };
}

async function drain(p: Probe) {
  if (p.busy || probe !== p) return;
  p.busy = true;
  try {
    const r = await eye(`drain(${JSON.stringify(p.watch)})`, 2000);
    if (!r.ok || !r.value) return;
    const v: View = r.value.view;
    lastView = v;
    p.dropped += r.value.dropped;
    const add: Rec[] = [];
    for (const x of r.value.out as Rec[]) {
      if (x.t !== undefined && x.t < p.started - 50) continue; // replayed by a buffered observer from before this run
      if (x.k === "T" && x.c) x.c = x.c.map((c: number[]) => [c[0], ...rectToScreen(v, c.slice(1, 5)), c[5], null, null, null, null]);
      if (x.k === "LS") x.src = (x.src ?? []).map((s: any) => ({ ...s, from: rectToScreen(v, s.from).map(Math.round), to: rectToScreen(v, s.to).map(Math.round) }));
      if (x.k === "L") p.els.set(x.id, x);
      if (x.k === "LOAF") for (const s of x.scripts ?? []) fetchSource(s.src);
      add.push(x);
    }
    p.watched = (r.value.watched ?? []).map((w: any) => ({ ...w, rect: w.rect ? rectToScreen(v, w.rect) : undefined }));
    p.recs.push(...add);
    if (add.length) { try { appendFileSync(p.file, add.map((x) => JSON.stringify(x)).join("\n") + "\n"); } catch { /* cache gone */ } }
  } finally { p.busy = false; }
}

export async function startPageProbe(o: { label?: string; watch?: string[] } = {}): Promise<{ ok: true; note: string } | { ok: false; why: string }> {
  if (!page || page.cdp.closed) return { ok: false, why: "no page open" };
  if (probe) { clearInterval(probe.timer); probe = null; }
  const dir = join(CACHE, "web");
  mkdirSync(dir, { recursive: true });
  const p: Probe = { label: o.label ?? "page", watch: o.watch ?? [], started: Date.now(), mach: machOffset(), timer: undefined as any, busy: false, recs: [],
    file: join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`), els: new Map(), dropped: 0, watched: [], seenLs: 0, seenEv: 0, hz: 0 };
  probe = p;
  try { await register(page, true); } catch (e: any) { probe = null; return { ok: false, why: e.message }; }
  const s = await eye("start()");
  if (!s.ok) { probe = null; return { ok: false, why: s.error }; }
  const loaf = await eye("loaf");
  p.timer = setInterval(() => { drain(p).catch(() => {}); }, 250);
  return { ok: true, note: `page probe recording${loaf.ok && loaf.value ? "" : " (no Long Animation Frames API in this browser: long tasks are timed but not attributed to scripts)"}` };
}

/** One answer per interaction: pointerdown, pointerup and click of one press share an id; the one that ran the handlers speaks for it. */
function interactions(evs: Rec[]): Rec[] {
  const by = new Map<string, Rec>();
  for (const e of evs) {
    const k = e.id ? `i${e.id}` : `t${e.t}${e.name}`, was = by.get(k);
    if (!was || e.run > was.run || (e.run === was.run && e.ms > was.ms)) by.set(k, e);
  }
  return [...by.values()].sort((a, b) => a.t! - b.t!);
}
const pct = (a: number[], q: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : 0);
const elLabel = (p: Probe, id: number) => { const l = p.els.get(id); return l ? [l.cls, l.view, l.name ? `"${l.name}"` : ""].filter(Boolean).join(" ") : `#${id}`; };
/** The same shape as an app probe's live file, for describeProbeLive. */
export function pageLive(): any | null {
  const p = probe;
  if (!p) return null;
  const now = Date.now(), win = 2000, ticks = p.recs.filter((x) => x.k === "T" && x.t! > now - win);
  const us = ticks.map((x) => x.us).sort((a, b) => a - b);
  const moving = new Map<number, any>();
  for (const t of ticks) {
    for (const c of t.c ?? []) { const m = moving.get(c[0]) ?? { id: c[0], label: elLabel(p, c[0]), updates: 0 }; m.updates++; m.rect = c.slice(1, 5); m.opacity = c[5]; moving.set(c[0], m); }
    for (const g of t.g ?? []) { const m = moving.get(g); if (m) m.gone = true; }
  }
  const loafs = p.recs.filter((x) => x.k === "LOAF");
  const span = ticks.length > 1 ? (ticks[ticks.length - 1].t! - ticks[0].t!) / 1000 : 0;
  return {
    t: (now - p.started) / 1000, window_s: win / 1000, ticks: ticks.length, tick_hz: span ? (ticks.length - 1) / span : 0,
    walk_us_p50: pct(us, 0.5), walk_us_max: us[us.length - 1] ?? 0, layers_tracked: p.els.size, moving_count: [...moving.values()].filter((m) => m.updates > 1).length,
    stalls: loafs.length, stall_worst_ms: Math.round(Math.max(0, ...loafs.map((l) => l.ms))),
    moving: [...moving.values()].filter((m) => m.updates > 1).sort((a, b) => b.updates - a.updates),
    watched: p.watched.map((w) => ({ id: w.id ?? 0, label: w.id ? `${w.q} → ${elLabel(p, w.id)}` : `${w.q} (not on the page)`, rect: w.rect, updates: ticks.filter((t) => (t.c ?? []).some((c: number[]) => c[0] === w.id)).length })),
    web: true,
  };
}

function stallsOf(p: Probe, name: string, pid: number): Stalls {
  const off = p.mach;
  return { name, pid, from: p.started / 1000 + off, to: Date.now() / 1000 + off, threshold_ms: 50, stacks: false,
    stalls: p.recs.filter((x) => x.k === "LOAF").map((l) => loafStall(l, off)) };
}
/** What the page's main thread was doing in every frame it held back, saved next to a capture so its reports say why. */
export function pageStalls(dir: string): Stalls | null {
  if (!probe) return null;
  const st = stallsOf(probe, hostOf(page?.url), browser?.pid ?? 0);
  st.to += 0.3; // lines reach the server four times a second
  try { writeFileSync(join(dir, "stalls.json"), JSON.stringify(st)); } catch { /* run dir gone */ }
  return st;
}
const hostOf = (u?: string) => { try { const x = new URL(u ?? ""); return x.host || basename(x.pathname) || "the page"; } catch { return "the page"; } };

/** New things the page said since the last call: console errors, exceptions, failed loads, slow answers, layout shifts. */
export function pageSaid(): string {
  if (!page) return "";
  const out = page.said.filter((s) => s.t > page!.saidAt).map((s) => `${s.line}${s.n > 1 ? ` ×${s.n}` : ""}`);
  page.saidAt = Math.max(page.saidAt, ...page.said.map((s) => s.t), 0);
  if (probe) {
    const ev = interactions(probe.recs.filter((x) => x.k === "EV" && x.t! < Date.now() - 400)), ls = probe.recs.filter((x) => x.k === "LS");
    for (const e of ev.slice(probe.seenEv)) out.push(`slow answer to ${e.name} on ${e.target}: ${Math.round(e.ms)}ms until painted (${Math.round(e.wait)}ms waiting, ${Math.round(e.run)}ms in handlers)`);
    for (const s of ls.slice(probe.seenLs)) if (!s.input) out.push(`layout shift ${s.v.toFixed(3)} not caused by input: ${(s.src ?? []).map((x: any) => `${x.el} ${x.from.slice(0, 2).join(",")}→${x.to.slice(0, 2).join(",")}`).join(", ") || "?"}`);
    probe.seenEv = ev.length; probe.seenLs = ls.length;
  }
  return out.join("\n");
}

export function pageStatus(): string[] {
  const out: string[] = [];
  if (browser) out.push(`browser: ${browser.name} pid ${browser.pid}${browser.gpu ? ` (gpu ${browser.gpu})` : ""} · DevTools port ${browser.port} · profile ${browser.profile}${browser.headless ? " · headless" : ""}`);
  if (page) out.push(`page: ${page.url}${lastView ? ` · "${lastView.title}" · viewport ${lastView.iw}×${lastView.ih}` : ""}`);
  if (probe) out.push(`page probe: ${((Date.now() - probe.started) / 1000).toFixed(1)}s · ${probe.recs.filter((x) => x.k === "T").length} frames · ${probe.els.size} elements · ${probe.recs.filter((x) => x.k === "LOAF").length} long frames${probe.dropped ? ` · ${probe.dropped} lines dropped` : ""}`);
  return out;
}

/** Stop the page probe and report: the app probe's analysis on the page's own frames, then what the page said. */
export async function stopPageProbe(runDir: (label?: string) => string, o: { capture_csv?: string; top?: number } = {}): Promise<string> {
  const p = probe;
  if (!p) return "";
  clearInterval(p.timer);
  for (let i = 0; i < 40 && p.busy; i++) await sleep(50);
  await drain(p).catch(() => {});
  probe = null;
  await eye("stop()").catch(() => {});
  if (page) await register(page, false).catch(() => {});
  const off = p.mach, mach = (t: number) => t / 1000 + off;
  const name = hostOf(page?.url), pid = browser?.pid ?? 0;
  const ticks = p.recs.filter((x) => x.k === "T");
  const iv = ticks.slice(1).map((x, i) => x.t! - ticks[i].t!).filter((d) => d > 2 && d < 40).sort((a, b) => a - b);
  const med = pct(iv, 0.5), hz = med ? [60, 90, 100, 120, 144, 165, 240].reduce((b, h) => (Math.abs(1000 / h - med) < Math.abs(1000 / b - med) ? h : b), 60) : 60;
  const dir = runDir(p.label), dest = join(dir, "probe.ndjson");
  const st = stallsOf(p, name, pid);
  const out: string[] = [JSON.stringify({ k: "S", id: `page-${p.started}`, pid, display: 0, hz, t: mach(p.started), stall_ms: 50, stacks: false, web: true, url: page?.url })];
  for (const x of p.recs) {
    if (x.k === "L") out.push(JSON.stringify(x));
    else if (x.k === "T") out.push(JSON.stringify({ ...x, t: mach(x.t!) }));
    else if (x.k === "A") out.push(JSON.stringify({ ...x, t: mach(x.t!), tf: cssBezier(x.easing) ?? undefined }));
    else if (x.k === "EV" || x.k === "LS") out.push(JSON.stringify({ ...x, t: mach(x.t!) }));
  }
  for (const s of st.stalls) out.push(JSON.stringify({ k: "H", ...s }));
  out.push(JSON.stringify({ k: "E", t: Math.max(mach(Date.now()), ...ticks.slice(-1).map((x) => mach(x.t!))), reason: "session ended" }));
  writeFileSync(dest, out.join("\n") + "\n");
  for (const d of new Set([dir, ...(o.capture_csv ? [dirname(o.capture_csv)] : [])])) { try { writeFileSync(join(d, "stalls.json"), JSON.stringify(st)); } catch { /* gone */ } }
  let report: string;
  try { report = analyzeProbe(dest, { capture_csv: o.capture_csv, name, top: o.top, web: true }); } catch (e: any) { report = `could not analyze ${dest}: ${e.message}`; }
  // Times relative to the capture, like the rest of the report.
  let t0 = mach(p.started);
  if (o.capture_csv) for (const f of [".meta.json", ".live.json"]) { try { const m = JSON.parse(readFileSync(o.capture_csv + f, "utf8")); if (m.t0_mach) { t0 = m.t0_mach; break; } } catch { /* */ } }
  const rel = (wall: number) => `${(mach(wall) - t0).toFixed(3)}s`;
  const extra: string[] = [];
  const said = (page?.said ?? []).filter((s) => s.t >= p.started - 100);
  if (said.length) extra.push(`the page said (${said.length}):`, ...said.slice(-25).map((s) => `  ${rel(s.t)} ${s.line}${s.n > 1 ? ` ×${s.n}` : ""}`));
  else extra.push("the page said nothing: no console error or warning, no uncaught exception, no failed load");
  const evs = interactions(p.recs.filter((x) => x.k === "EV")).sort((a, b) => b.ms - a.ms);
  if (evs.length) extra.push(`slow answers to input (≥40ms from the input to the frame that showed its result): ${evs.length} · worst first:`,
    ...evs.slice(0, 6).map((e) => `  ${rel(e.t!)} ${e.name} on ${e.target}: ${Math.round(e.ms)}ms = ${Math.round(e.wait)}ms waiting for the main thread + ${Math.round(e.run)}ms in its handlers + ${Math.max(0, Math.round(e.ms - e.wait - e.run))}ms until painted`));
  else extra.push("input: every answer to input was painted within 40ms");
  const ls = p.recs.filter((x) => x.k === "LS" && !x.input);
  if (ls.length) extra.push(`layout shifts not caused by input: ${ls.length}, ${ls.reduce((t, x) => t + x.v, 0).toFixed(3)} in total (CLS counts these):`,
    ...ls.slice(0, 6).map((s) => `  ${rel(s.t!)} ${s.v.toFixed(3)}: ${(s.src ?? []).map((x: any) => `${x.el} [${x.from.join(",")}] → [${x.to.join(",")}]`).join(" · ") || "?"}`));
  if (p.dropped) extra.push(`(${p.dropped} probe lines dropped: the page outran the drain)`);
  return `${report}\n\nTHE PAGE ITSELF\n${extra.join("\n")}`;
}
