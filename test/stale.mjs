// node test/stale.mjs: stale copies of a build are quit by the server itself, never left running unnoticed.
// Uses window-less dummy .app bundles (a sleeping binary) under a fake DerivedData folder, so it touches no screen or input.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInstances, freshEvents, watchPid } from "../src/single.ts";

const root = join(tmpdir(), `eye-stale-${process.pid}`);
const mk = (dir) => {
  const app = join(root, dir, "EyeDupProbe.app"), mac = join(app, "Contents", "MacOS");
  mkdirSync(mac, { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.eye.dupprobe</string><key>CFBundleExecutable</key><string>EyeDupProbe</string></dict></plist>`);
  writeFileSync(join(root, "s.c"), "#include <unistd.h>\nint main(){sleep(120);return 0;}\n");
  spawnSync("cc", [join(root, "s.c"), "-o", join(mac, "EyeDupProbe")]);
  return join(mac, "EyeDupProbe");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kids = [];
const run = (exe) => { const c = spawn(exe, [], { stdio: "ignore" }); kids.push(c); return c.pid; };
let failed = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? ` — ${info}` : ""}`); if (!ok) failed++; };

try {
  const a = mk("DerivedData/X/Build/Products/Debug"), b = mk("dd-other/Build/Products/Debug");

  // 1. Two runs of the same build already up when the agent asks: the older one is quit, the call goes on.
  const p1 = run(a); await sleep(1100); const p2 = run(a); await sleep(300);
  let c = await checkInstances(p1, "ask");
  check("same build, named the OLD pid → ok, redirected to the new one", c.ok && c.pid === p2 && !alive(p1), JSON.stringify(c));

  // 2. The watcher: a newer build (another build folder) launches mid-test → old quit within a tick, event reported.
  watchPid(p2);
  await sleep(1100);
  const p3 = run(b);
  await sleep(2000);
  const ev = freshEvents();
  check("watcher quits the stale copy on its own", !alive(p2) && alive(p3), `p2 alive=${alive(p2)} p3 alive=${alive(p3)}`);
  check("…and the next tool output says so", ev.some((e) => e.includes(`pid ${p2}`) && e.includes("stale")), ev.join(" | "));

  // 3. A call naming the quit pid follows the handover.
  c = await checkInstances(p2, "ask");
  check("call naming the quit pid follows to the new one", c.ok && c.pid === p3 && /stale/.test(c.note ?? ""), JSON.stringify(c));

  // 4. A copy outside build folders (like /Applications) is never quit without asking.
  const appsDir = mk("Apps"); // not a build folder
  const p4 = run(appsDir); await sleep(300);
  c = await checkInstances(p3, "ask");
  check("non-build copy → STOPPED with the choices, nothing quit", !c.ok && alive(p3) && alive(p4) && /copies/.test(c.error ?? ""), (c.error ?? "").split("\n")[0]);
} finally {
  for (const k of kids) try { k.kill("SIGKILL"); } catch {}
  rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
