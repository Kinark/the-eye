# session: the lock, who drives, and other people's things

One session at a time. The first `eye_drive` call opens it (`app`, `app_path`, `url` or `rect`), every call may
move, `end:true` closes it and returns the report. The hand, the recording and the lock stay up between calls.

## The lock

A session with a hand blocks ALL of the user's physical input (trackpad, mouse, gestures, keyboard) and pins the
cursor.

- A session that stays open warns with 3·2·1 and an orange overlay. Only one call with `end:true` whose steps / wing
  take under 4 seconds shows a small pill instead ("Just a sec…"). Anything longer gets the full warning, whatever
  `lock_style` says (`"full"` forces the warning on a short call).
- Orange on screen means locked.
- The user's way out is Esc 6× in a row. It stops the hand too: steps are refused and anything held is released
  until the next session.
- The lock does not fail. Everything that could make it fail is checked before anything shows; a refused one is
  taken again until it engages, with nothing driven meanwhile, so a call that needs it simply waits. The reply then
  says "the lock engaged on try N" and what the first refusal was.
- When the reason is a missing permission (Accessibility, Input Monitoring) the-eye asks the user for it itself: the
  macOS prompt and the right pane of System Settings, again on every failed try. The call goes on once it is granted.
- A session with a hand ends by itself after `idle_s` (default 30, 3–300) without a call: input is never held while
  nobody is steering. The next `eye_drive` call hands over its report.

## Who drives: `hands`

There is no lock switch: whoever drives holds the user's input.

| `hands` | who moves things | the user's input |
|---|---|---|
| `true` (default) | the-eye's hand | held |
| `"mine"` | your own driver (a script, another tool); the-eye only watches | held |
| `false` | the USER; the-eye only watches | theirs. No idle end; it stops after `max_seconds` |

Never hold the lock while the user should be acting: use `hands:false`.

Only watching:

- `hands:false` stays open until `end:true`. Passive steps (`wait`, `wait_until`, `assert`) run in it.
- `seconds: N` records that long and returns the report (implies `hands:false`).
- `command: "…"` runs your driver with `/bin/zsh -lc` (`cwd` to place it), with input held, and returns its output
  and the report. It gets `THE_EYE_LIVE`, `THE_EYE_RECT` and `THE_EYE_RUN_DIR`. `pre_ms` (500) and `post_ms` (1000)
  record before and after it; `timeout_s` (300) kills it.
- `rect` watches a display-local region instead of an app's window (`display` picks the display); with
  `hands:false` it needs no app at all.
- `tree: "basic" | "full"` adds the element tree of the watched windows at the start; `ax:true` logs the element
  under the pointer ten times a second (it costs the app frame time).

`max_seconds` stops any recording by itself (default 600 with a hand, 300 watching).

## The window

A session with a hand brings the app's window forward when it opens (also from minimized) and puts it back, with
everything that was above it, when it ends. `front:false` leaves it where it is: a press on a part another app
covers is then refused. `window` picks one of the app's windows by title substring.

Nothing is ever sent to a window that cannot be seen (minimized, hidden, another Space, a sleeping display).

## Starting and quitting the app

- `app_path` starts the .app when no copy of it runs: the build you just made. It never makes a second copy.
- `quit:true` quits the app: with `end`, after the report; alone with `app`, right away.

## One app copy

Every copy and every other build of the app (Dev, Release, Setapp…) draws and answers accessibility. If several
run, `eye_drive` (and `eye_snapshot {app}`) stops with the list and the choices:

| `duplicates` | |
|---|---|
| `"ask"` (default) | stop and list them |
| `"quit_others"` | keep the target (the pid you named, else the newest launch), quit the rest |
| `"relaunch"` | quit them all and start the target's .app fresh (or `app_path`) |
| `"allow"` | go ahead |

`eye_status {app}` lists the copies without doing anything.

## The user is asked

Before the-eye quits something that may be the user's (an app running from Xcode, a copy outside build folders), a
question fills the locked screen: "Nope" · "Yep" (highlighted) · "Mi casa su casa" (yes to this same question for
the rest of the session). Unanswered after 6s the highlighted one is taken.

- Nope = they are using it. The call fails and nothing is quit for 30s. Do not retry.
- Ask your own with `eye_drive {ask:"…"}` (at most 140 characters) before anything else they might mind. It returns
  the answer; nothing else in that call is done.
- Never ask twice after a Nope.

## One at a time

One agent session drives the screen, across every the-eye server on the machine.

- If another is mid-turn, your `eye_drive` / `eye_snapshot {app}` call waits in a queue and then runs ("waited Ns in
  the queue"). Don't retry or sleep.
- An open session holds the turn: end it promptly.
- After about 45s queued you get "QUEUED, not run": call again within 20s to keep your place.
- `eye_inspect`, `eye_report`, `eye_status`, `eye_snapshot {rect}` and `eye_drive {guide}` never wait.

## The end, in order

The hand lets go, the screen is given time to settle and its frame is taken, the capture stops, the window goes
back where it was, the lock is released, and then the report is written (the probe's account, the analysis, the
frame at each ✗). `quit:true` quits the app after that.

## Permissions

The host app (terminal or agent) needs Screen Recording for capture and Accessibility for input and the lock.
