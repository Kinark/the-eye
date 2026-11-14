// Question mode: the server puts a yes/no to the person at the machine before it does something they may mind
// (quitting an app they could be using, killing an Xcode run session), or because the agent asked it to.
// The helper shows it over an input lock (`eye-capture lock --style question`); this file holds what the answers
// mean for the rest of the session. No I/O of its own: index.ts hands in the function that shows the question.

export type Answer = "nope" | "yep" | "casa";
export type Reply = { answer: Answer; how: "key" | "escape" | "timeout" | "remembered" | "env"; waited_ms?: number };
/** Shows one question with `preselect` highlighted; a string = why it could not be shown. */
export type Presenter = (question: string, preselect: Answer, seconds: number) => Promise<Reply | string>;

export const QUESTION_MAX = 140;
export const ASK_SECONDS = 6;
export const NOPE_MS = 30_000;

let present: Presenter | undefined;
export function setPresenter(p: Presenter) { present = p; }

/** Questions answered "Mi casa su casa": the same words are a yes for the rest of the session, never shown again. */
const casa = new Set<string>();
/** Until when a "Nope" stands: the user is at the machine, nothing of theirs is quit. */
let nopeUntil = 0;
/** The last question shown ran out unanswered: nobody is there, so the next one opens on "Mi casa su casa". */
let unattended = false;
let chain: Promise<unknown> = Promise.resolve();

export const clean = (q: string) => q.replace(/\s+/g, " ").trim().slice(0, QUESTION_MAX);
export const nopeLeftMs = () => Math.max(0, nopeUntil - Date.now());

/** Put one question. One at a time: a second caller waits for the first answer (and may then be answered by it). */
export function ask(question: string): Promise<Reply | string> {
  const run = chain.then(() => askNow(clean(question)));
  chain = run.catch(() => {});
  return run;
}
async function askNow(q: string): Promise<Reply | string> {
  if (!q) return "empty question";
  if (casa.has(q)) return { answer: "casa", how: "remembered" };
  const fixed = process.env.THE_EYE_ASK;
  let r: Reply | string;
  if (fixed === "yep" || fixed === "nope" || fixed === "casa") r = { answer: fixed, how: "env" };
  else if (!present) return "no way to show a question";
  else r = await present(q, unattended ? "casa" : "yep", ASK_SECONDS);
  if (typeof r === "string") return r;
  unattended = r.how === "timeout";
  if (r.answer === "casa") casa.add(q);
  if (r.answer === "nope") nopeUntil = Date.now() + NOPE_MS;
  return r;
}

/** The answer in words, for a tool reply. */
export function sayReply(q: string, r: Reply): string {
  const how = r.how === "remembered" ? "not asked again: the user answered \"Mi casa su casa\" to the same question earlier in this session"
    : r.how === "timeout" ? `nobody answered in ${ASK_SECONDS}s, so the highlighted button was taken`
    : r.how === "escape" ? `the user pressed Esc after ${((r.waited_ms ?? 0) / 1000).toFixed(1)}s`
    : r.how === "env" ? "THE_EYE_ASK answered, nothing was shown"
    : `the user chose it after ${((r.waited_ms ?? 0) / 1000).toFixed(1)}s`;
  const means = r.answer === "nope" ? `NOPE. Take it that the user is at the machine and using it: do not do what you asked about. the-eye refuses to quit any app for the next ${NOPE_MS / 1000}s.`
    : r.answer === "casa" ? "MI CASA SU CASA. Yes, and yes to this same question for the rest of the session (it will not be shown again)."
    : "YEP. Yes, this once.";
  return `"${q}"\n${means}\n(${how})`;
}

/** Why nothing may be quit right now, or "" when a kill may go ahead (asking `question` first when one is given). */
export async function mayKill(question?: string): Promise<string> {
  const left = nopeLeftMs();
  if (left > 0) return `the user answered "Nope" ${Math.round((NOPE_MS - left) / 1000)}s ago, so they are using the machine: nothing is quit for another ${Math.ceil(left / 1000)}s. Do not retry before then; work with what is running, or wait`;
  if (!question) return "";
  const r = await ask(question);
  // A question that could not be put (no permission for the lock, another lock in the way) is not a "no".
  if (typeof r === "string") return "";
  return r.answer === "nope" ? `the user answered "Nope" to "${clean(question)}": they are using it. Nothing is quit for the next ${NOPE_MS / 1000}s; work with what is running, or wait` : "";
}
