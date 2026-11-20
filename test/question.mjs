// bun test/question.mjs — question mode. **Takes the real input lock** for about fifteen seconds in all.
// 1. ask.ts on its own: what Nope / Yep / Mi casa su casa and a timeout mean for the rest of the session.
// 2. The helper: the first 175ms are deaf, arrows move the highlight, return takes it, Esc is Nope, time runs out on
//    the highlighted button, and a question can be put over a lock that is already held.
// 3. The server: eye_drive {ask} returns the answer.
// Keys come from a separate untagged process; the locks run with --allow tagged so they count as the user's.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ask, mayKill, setPresenter } from "../src/ask.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(ROOT, "bin", "eye-capture");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); };

// ---- 1. the session rules, with a made-up presenter
{
  const shown = [];
  let next = { answer: "yep", how: "key" };
  setPresenter(async (q, pre) => { shown.push([q, pre]); return next; });
  await ask("One?");
  check("a first question opens on Yep", shown[0][1] === "yep");
  next = { answer: "yep", how: "timeout" };
  await ask("Two?");
  next = { answer: "casa", how: "timeout" };
  await ask("Three?");
  check("after one that ran out, the next opens on Mi casa su casa", shown[2][1] === "casa", shown.map((s) => s[1]).join(" "));
  const again = await ask("Three?");
  check("Mi casa su casa: the same question is not shown again", shown.length === 3 && again.answer === "casa" && again.how === "remembered");
  check("a kill goes ahead while nobody said Nope", (await mayKill()) === "");
  next = { answer: "nope", how: "key" };
  const refused = await mayKill("Quit Demo?");
  check("Nope refuses the kill", /Nope/.test(refused), refused);
  const later = await mayKill("Quit Other?");
  check("and every other kill for 30s, without asking", /Nope/.test(later) && shown.length === 4, `${shown.length} shown`);
}

// ---- 2. the helper
mkdirSync("/tmp/the-eye-test", { recursive: true });
const src = "/tmp/the-eye-test/key.swift", key = "/tmp/the-eye-test/key";
writeFileSync(src, `import CoreGraphics
import Foundation
let code = CGKeyCode(UInt16(CommandLine.arguments[1])!)
for down in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!.post(tap: .cghidEventTap); usleep(8000) }
`);
const b = spawnSync("swiftc", ["-O", src, "-o", key], { encoding: "utf8" });
if (b.status !== 0) { console.error(b.stderr); process.exit(1); }
spawnSync(process.execPath, ["-e", "0"]); // warm
const press = (code) => spawnSync(key, [String(code)]);
const RET = 36, ESC = 53, LEFT = 123, RIGHT = 124;

function lock(args) {
  const p = spawn(bin, ["lock", "--allow", "tagged", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const o = { p, out: "", err: "", answers: [] };
  p.stdout.on("data", (d) => { o.out += d; o.answers = o.out.split("\n").filter((l) => l.includes('"answer"')).map((l) => JSON.parse(l)); });
  p.stderr.on("data", (d) => { o.err += d; });
  o.engaged = new Promise((res) => { const t = setInterval(() => { if (/locked for/.test(o.err) || p.exitCode !== null) { clearInterval(t); res(/locked for/.test(o.err)); } }, 5); });
  o.closed = new Promise((res) => p.on("close", res));
  return o;
}
const answered = async (o, ms = 1500) => { for (let i = 0; i < ms / 20 && !o.answers.length; i++) await sleep(20); return o.answers.at(-1); };

{
  const o = lock(["--style", "question", "--question", "Does the first return, pressed too early, count?"]);
  check("question lock engages with no countdown", await o.engaged, o.err.trim().split("\n").pop());
  press(RET); // inside the deaf 175ms
  await sleep(450);
  check("a return in the first 175ms is ignored", o.answers.length === 0 && o.p.exitCode === null);
  press(RIGHT);
  await sleep(120);
  press(RET);
  const a = await answered(o);
  await o.closed;
  check("right, then return = Mi casa su casa", a?.answer === "casa" && a?.how === "key", JSON.stringify(a));
  check("the lock ends with the answer", /"ended":"answered"/.test(o.out));
}
{
  const o = lock(["--style", "question", "--question", "Esc is a no?"]);
  await o.engaged; await sleep(300);
  press(ESC);
  const a = await answered(o); await o.closed;
  check("Esc = Nope", a?.answer === "nope" && a?.how === "escape", JSON.stringify(a));
}
{
  const o = lock(["--style", "question", "--question", "Left of Yep is Nope?"]);
  await o.engaged; await sleep(300);
  press(LEFT); await sleep(100); press(LEFT); await sleep(100); press(RET);
  const a = await answered(o); await o.closed;
  check("left (twice, it stops at the end), return = Nope", a?.answer === "nope" && a?.how === "key", JSON.stringify(a));
}
{
  const t0 = Date.now();
  const o = lock(["--style", "question", "--question", "Nobody home?", "--default", "casa", "--ask-seconds", "1"]);
  await o.engaged;
  const a = await answered(o, 3000); await o.closed;
  check("unanswered, the highlighted button is taken when time runs out", a?.answer === "casa" && a?.how === "timeout" && Date.now() - t0 < 2600, `${JSON.stringify(a)} in ${Date.now() - t0}ms`);
}
{
  const o = lock(["--style", "quick", "--seconds", "8"]);
  await o.engaged;
  o.p.stdin.write("ask 1 3 A question over a lock that is already held?\n");
  await sleep(450);
  press(RET);
  const a = await answered(o);
  await sleep(300);
  check("asked over a held lock: return = Yep", a?.answer === "yep" && a?.how === "key", JSON.stringify(a));
  check("and that lock is still held afterwards", o.p.exitCode === null);
  o.p.stdin.write("release\n"); await o.closed;
}
{
  const r = spawnSync(bin, ["lock", "--style", "question"], { encoding: "utf8" });
  check("no question, no lock", r.status !== 0 && /needs --question/.test(r.stderr));
}

// ---- 3. the server
const client = new Client({ name: "question-test", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "src", "index.ts")], env: { ...process.env, THE_EYE_ASK: "" } }));
const t0 = Date.now();
const r = await client.callTool({ name: "eye_drive", arguments: { ask: "the-eye test: leave this one alone, it answers itself" } });
const t = r.content?.[0]?.text ?? "";
// Left alone it runs out on Yep; someone at the keyboard may answer it instead, which is just as good an answer.
check("eye_drive {ask} returns an answer", !r.isError && /^(YEP|NOPE|MI CASA SU CASA)\./m.test(t) && /nobody answered in 6s|the user (chose|pressed)/.test(t), `${Date.now() - t0}ms: ${t.replace(/\n/g, " | ")}`);
const long = await client.callTool({ name: "eye_drive", arguments: { ask: "x".repeat(141) } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
check("a question over 140 characters is refused", !!long.isError);
await client.close();

console.log(failed ? `\n${failed} FAILED` : "\nall question checks pass");
process.exit(failed ? 1 : 0);
