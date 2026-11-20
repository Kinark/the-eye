// bun test/queue.mjs — two/three the-eye servers sharing a private lease dir: queued calls wait their turn and
// return their real result; an idle holder hands over at once; FIFO order; capped waits keep their place.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "eye-queue-"));
const server = async (name, env = {}) => {
  const c = new Client({ name, version: "1" });
  await c.connect(new StdioClientTransport({
    command: process.execPath, args: [new URL("../src/index.ts", import.meta.url).pathname],
    env: { ...process.env, THE_EYE_LEASE_DIR: dir, ...env },
  }));
  return c;
};
const txt = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(2);
const call = async (c, name, args, extra = {}) => {
  const s = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000, ...extra });
  return { ms: Date.now() - s, text: txt(r), err: !!r.isError, done: Date.now() };
};
const poke = { app: "zz-no-such-app", quit: true }; // a driving call that touches nothing
const hold = (s) => ({ rect: { x: 0, y: 0, w: 120, h: 120 }, seconds: s, label: "queue-test" });
let fails = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) fails++; };

const [A, B, C] = await Promise.all([server("A"), server("B"), server("C")]);
const Bshort = await server("Bshort", { EYE_QUEUE_WAIT_MS: "1500" });

// 1. B queues behind A's in-flight recording and gets its real answer, with progress while it waits.
{
  const rec = call(A, "eye_drive", hold(3));
  await new Promise((r) => setTimeout(r, 600));
  let progress = 0;
  const b = await call(B, "eye_drive", poke, { onprogress: () => progress++, resetTimeoutOnProgress: true });
  const a = await rec;
  check(b.text.includes("no running app matches"), "queued call returns its real result", b.text.split("\n")[0]);
  check(b.done >= a.done - 50, "it ran after the holder finished", `A done +${a.done - t0}ms, B done +${b.done - t0}ms`);
  check(/waited \d+(\.\d)?s/.test(b.text), "result says how long it waited", (b.text.match(/⏳.*/) ?? [""])[0].slice(0, 160));
  check(progress > 0, "progress notifications while queued", `${progress}`);
}
// 2. Idle holder: A's turn ended, its lease is idle → B takes over immediately.
{
  await call(A, "eye_drive", poke);
  const b = await call(B, "eye_drive", poke);
  check(b.ms < 1000, "idle holder hands over at once", `${b.ms}ms`);
}
// 3. FIFO: B joins before C; both behind A.
{
  const rec = call(A, "eye_drive", hold(2.5));
  await new Promise((r) => setTimeout(r, 500));
  const b = call(B, "eye_drive", poke);
  await new Promise((r) => setTimeout(r, 300));
  const c = call(C, "eye_drive", poke);
  const [rb, rc] = await Promise.all([b, c, rec]);
  check(rb.done <= rc.done, "first to queue goes first", `B +${rb.done - t0}ms, C +${rc.done - t0}ms`);
}
// 4. Capped wait answers with a reply instead of hanging, and calling again keeps the place.
{
  await call(C, "eye_drive", poke); // C holds idle
  const rec = call(A, "eye_drive", hold(4));
  await new Promise((r) => setTimeout(r, 500));
  const s1 = await call(Bshort, "eye_drive", poke);
  check(s1.err && /queue/i.test(s1.text) && s1.ms < 3000, "capped wait answers instead of hanging", `${s1.ms}ms: ${s1.text.slice(0, 200)}`);
  const c = call(C, "eye_drive", poke); // joins after Bshort's kept place
  await new Promise((r) => setTimeout(r, 200));
  const s2 = call(Bshort, "eye_drive", { ...poke });
  const [r2, rc] = await Promise.all([s2.then(async (x) => x.err ? call(Bshort, "eye_drive", poke) : x), c, rec]);
  check(r2.text.includes("no running app matches") && r2.done <= rc.done, "retry kept its place ahead of a later joiner", `Bshort +${r2.done - t0}ms, C +${rc.done - t0}ms`);
}
// 5. status shows the queue
{
  const rec = call(A, "eye_drive", hold(2));
  await new Promise((r) => setTimeout(r, 400));
  const b = call(B, "eye_drive", poke);
  await new Promise((r) => setTimeout(r, 300));
  const st = await call(C, "eye_status", {});
  const line = st.text.split("\n").filter((l) => /lease|queue/i.test(l)).join(" | ");
  check(/waiting|queue/i.test(line), "eye_status shows who's waiting", line.slice(0, 240));
  await Promise.all([rec, b]);
}
await Promise.all([A, B, C, Bshort].map((c) => c.close()));
console.log(fails ? `${fails} FAILED` : "all passed", `(${at()}s)`);
process.exit(fails ? 1 : 0);
