---
name: the-eye
description: "Test a macOS app's UI (SwiftUI or AppKit) or a website yourself with the the-eye MCP tools: drive it with a hand on the mouse and read what a viewer would have noticed (fps, freezes, judder, the spring or curve behind each motion) and why. Use after a UI change builds and before saying it works, and whenever asked to verify, measure or feel an animation, a gesture or an interaction."
---

the-eye: your eyes and hands on a macOS screen. You act; it tells you what a person watching would have noticed, and why.

USE IT BY DEFAULT: this is how you test a macOS app's UI (SwiftUI or AppKit), or a website, yourself. After a UI change builds, start the app and verify it here. Don't hand the check to the user ("try it and tell me") unless they say they'll drive.

THE LOOP IS ONE CALL: eye_drive {app:"Calculator", wing:'"7" tap "Add" tap "3" tap "Equals" tap settle', end:true}. A wing is a line of words flown as one motion, things by the name accessibility gives them; `steps` are exact (coordinates, timings, gestures). To explore, leave end off: read what came back, send the next wing or steps, end:true when done. app_path starts the app; url:"localhost:3000" drives a website instead (its dev server must be running).

FIVE TOOLS
- eye_drive: the one that acts. One session: the window recorded, the user's input held, a hand on the mouse, a probe inside the app when it can go in (Debug builds). hands:false only watches while the user or your script drives.
- eye_snapshot: one still image. {rect} of the screen as it is; {app} brings a covered or minimized window forward for a fraction of a second, takes the image and the element tree, and puts everything back.
- eye_inspect: what UI is here: an app's element tree with frames, or everything about the element at a point. No recording, no lock.
- eye_report: re-read a finished run: summary, timeline, explain, hover, compare (A/B), probe.
- eye_status: displays, who is driving, what the open session sees right now, the copies of an app that are running.

THE MANUAL comes a chapter at a time: eye_drive {guide:"wing"} returns one and does nothing else (no session, no lock, no queue). Read a chapter before the first use of its part; the tool descriptions only carry the outline.
- wing: every word of a wing, how the hand moves and what it refuses to do
- fingers: two fingers on the trackpad (a thing that follows them, rubber-bands, wobbles), `fingers play`, playing back the user's own touch
- steps: exact steps, their expressions, gestures, Force Touch, where a scroll may land
- web: websites: finding things in the page, typing, what the page said, the page probe
- reply: how to read a reply and a report, line by line
- session: the lock, who drives (hands, command), questions to the user, several copies of an app, the queue
- measure: the probe, A/B, Instruments, what costs frames, coordinates, the files of a run
(Loaded as a skill, the chapters are the files beside this one: wing.md, fingers.md and so on.)

THE LOCK. A session with a hand blocks ALL of the user's physical input (trackpad, mouse, keyboard) and pins the cursor. Orange on screen means locked; the user's way out is Esc 6× in a row, which also stops the hand. Never hold it while the user should be acting: use hands:false. End a session promptly (end:true); one with a hand ends by itself after 30s without a call. Before the-eye quits something that may be the user's it asks them on screen: "Nope" means they are using it, the call fails, do not retry and never ask twice.

READING A REPLY. WHAT IT LOOKED LIKE opens with a verdict (SMOOTH · MOSTLY SMOOTH · ROUGH · BROKEN · NOTHING MOVED), then each thing a viewer would have noticed, worst first: ✗ = clearly visible, ~ = visible if you look, · = a fact, not a defect. "moved by:" is the engine fitted to a motion (spring, timing curve, per-frame lerp, bounce), "why:" the cause of a freeze. NOT SEEN IN FULL, SAW NOTHING or "⚠ NOT SEEING" mean exactly that: do not report on that stretch as if you had watched it. Frames come back unasked: look at them.

ONE AT A TIME. One agent session drives the screen: if another is mid-turn, your call waits in a queue and then runs; don't retry or sleep. If several copies or builds of the app run, eye_drive stops with the list and the choices (duplicates).

WAITING: don't poll. `bun ${CLAUDE_SKILL_DIR}/../../src/index.ts watch` prints one line per UI event (windows, sheets, dialogs with their text and [buttons], titles, announcements; --app NAME, --until "TEXT" --seconds N exits on the first match, 124 if none). `bun ${CLAUDE_SKILL_DIR}/../../src/index.ts live` prints one line each time the recorded screen starts moving, comes to rest or hitches. Stream either with your Monitor tool, or run it in the background.

Coordinates are POINTS, top-left origin. The host app needs Screen Recording and Accessibility permission.
