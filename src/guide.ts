/**
 * The manual, a chapter at a time. Its text lives once, in skills/the-eye/: SKILL.md's body is what the server sends
 * on connect (`instructions`), and each other file is a chapter that eye_drive {guide} returns, that a wing which
 * cannot be read brings with its error, and that a client with skills reads as a file. What every session pays for
 * is then the outline; the rest is paid for when it is used.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "skills", "the-eye");

export const CHAPTERS = ["wing", "fingers", "steps", "web", "reply", "session", "measure"] as const;
export type Chapter = (typeof CHAPTERS)[number];

/** SKILL.md without its front matter, its paths made real: the guide an agent gets on connect. */
export function overview(): string {
  return readFileSync(join(DIR, "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "")
    .replaceAll("${CLAUDE_SKILL_DIR}/../..", ROOT).trim();
}

/** Chapters this server has handed over in full, and the ones it has pointed at: each is said once. */
const given = new Set<string>(), pointed = new Set<string>();

export function chapter(name: Chapter | "overview"): string {
  if (name === "overview") return overview();
  given.add(name);
  return readFileSync(join(DIR, `${name}.md`), "utf8").trim();
}

/** The chapter with an error it explains: in full the first time, by name after that. */
export function chapterFor(name: Chapter): string {
  return given.has(name) ? `(the words: eye_drive {guide:"${name}"})` : `\n${chapter(name)}`;
}

const POINTERS: Record<string, string> = {
  wing: "every word a wing knows, and what the hand refuses to do",
  fingers: "strokes, fingers play, how long they stay down, how to read the film strip",
  steps: "every step, the expressions, where a scroll may land",
  web: "finding things in the page, typing, what the page said",
  reply: "how to read this, line by line",
  session: "the lock, who drives, several copies of the app",
};
/** One line that names a chapter, the first time its part is used and only if it was not read already. */
export function pointer(name: Chapter): string {
  if (given.has(name) || pointed.has(name)) return "";
  pointed.add(name);
  return `(manual: eye_drive {guide:"${name}"} — ${POINTERS[name] ?? name})`;
}
