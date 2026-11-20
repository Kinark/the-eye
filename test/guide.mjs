// The manual: what the server sends on connect stays an outline, every chapter is served, the chapters name every
// word the wing parser knows, and a wing that cannot be read comes back with its chapter. No screen, no input.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("..", import.meta.url).pathname;
const client = new Client({ name: "guide", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [`${root}src/index.ts`], stderr: "ignore" }));
let bad = 0;
const ok = (what, cond, detail = "") => { if (!cond) bad++; console.log(`${cond ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`); };
const call = async (args) => {
  const r = await client.callTool({ name: "eye_drive", arguments: args });
  return { text: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), isError: !!r.isError };
};

// What every session pays for, used or not. It was 43,204 characters before the chapters moved out.
const ins = client.getInstructions() ?? "";
const { tools } = await client.listTools();
const sizes = tools.map((t) => [t.name, t.description.length + JSON.stringify(t.inputSchema).length]);
const total = ins.length + sizes.reduce((n, [, v]) => n + v, 0);
console.log(`on connect: instructions ${ins.length} · ${sizes.map(([n, v]) => `${n} ${v}`).join(" · ")} · total ${total} chars`);
ok("five tools", tools.length === 5, tools.map((t) => t.name).join(", "));
// What is left is mostly the shape of the schemas (sixty arguments, eighteen step fields), not prose.
ok("the connect payload is an outline (< 26,000 chars)", total < 26_000, String(total));
ok("the instructions carry the trigger, the lock and the way out", /USE IT BY DEFAULT/.test(ins) && /THE LOCK/.test(ins) && /Esc 6×/.test(ins) && /hands:false/.test(ins));
ok("the instructions name real commands, not the skill's placeholder", !ins.includes("CLAUDE_SKILL_DIR") && ins.includes(`node ${root}src/index.ts watch`));
ok("no front matter in the instructions", !ins.startsWith("---"));

// Every chapter the tool offers is served, and the outline lists it.
const chapters = tools.find((t) => t.name === "eye_drive").inputSchema.properties.guide.enum.filter((c) => c !== "overview");
for (const c of chapters) {
  const r = await call({ guide: c });
  ok(`guide:"${c}"`, !r.isError && r.text.startsWith(`# ${c}`) && r.text.length > 800, `${r.text.length} chars`);
  ok(`the outline lists ${c}`, new RegExp(`^- ${c}: `, "m").test(ins));
}
ok('guide:"overview" is the instructions', (await call({ guide: "overview" })).text === ins);

// The parser's words are all in the manual: a word added to src/wing.ts without its line here fails.
const wing = readFileSync(`${root}skills/the-eye/wing.md`, "utf8"), fingers = readFileSync(`${root}skills/the-eye/fingers.md`, "utf8");
const src = readFileSync(`${root}src/wing.ts`, "utf8");
const said = (text, w) => new RegExp(`(^|[^A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`).test(text);
const verbs = [...src.matchAll(/verb === "(\w+)"/g)].map((m) => `${m[1]}:`);
const words = [...new Set([...src.matchAll(/\bl === "(\w+)"/g)].map((m) => m[1]))];
const fwords = [...new Set([...src.matchAll(/\bd === "(\w+)"/g)].map((m) => m[1]))];
ok(`wing.md has the parser's ${verbs.length + words.length} words`, [...verbs, ...words].every((w) => said(wing, w)), [...verbs, ...words].filter((w) => !said(wing, w)).join(" "));
ok(`fingers.md has the parser's ${fwords.length} fingers words`, [...fwords, "like:", "flick", "lift", "along", "gentle", "lively", "wild"].every((w) => said(fingers, w)), fwords.filter((w) => !said(fingers, w)).join(" "));
ok("the parser's words were found at all", verbs.length >= 8 && words.length >= 12 && fwords.length >= 8, `${verbs.length} ${words.length} ${fwords.length}`);

// A wing that cannot be read: refused before any session or lock, with its chapter once, then by name.
const e1 = await call({ app: "no-such-app-for-guide-test", wing: '"7" tap wiggle' });
ok("an unknown word is refused before anything opens", e1.isError && e1.text.startsWith('NOT RUN, nothing was sent: "wiggle" is not a move'), e1.text.slice(0, 90));
ok("…and names the chapter instead of repeating one already read", e1.text.includes('guide:"wing"') && e1.text.length < 1200, `${e1.text.length} chars`);
const e2 = await call({ wing: "fingers sideways" });
ok("a fingers mistake names the fingers chapter", e2.isError && e2.text.includes('guide:"fingers"'), e2.text.slice(-60));

// A server that has not handed the chapter over yet brings it with the error.
const fresh = new Client({ name: "guide2", version: "1" });
await fresh.connect(new StdioClientTransport({ command: "node", args: [`${root}src/index.ts`], stderr: "ignore" }));
const r = await fresh.callTool({ name: "eye_drive", arguments: { wing: "E wiggle" } });
const t = r.content.map((c) => c.text ?? "").join("\n");
ok("a fresh server sends the wing chapter with the error", r.isError && t.includes("# wing: a line of words") && t.includes("## The words"), `${t.length} chars`);
ok("…and no session was opened for it", /no session is open/.test((await fresh.callTool({ name: "eye_status", arguments: {} })).content[0].text));
await fresh.close();

await client.close();
console.log(bad ? `\n${bad} FAILED` : "\nall good");
process.exit(bad ? 1 : 0);
