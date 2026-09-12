# Corrective review of PR 63

Branch `arena/01a07c29-mausvoice`, cut from the head of PR 63,
`9e01cbbc3cd79afc0a3b0527be1aa467013a2b24`.
Reviewed state: base `0e7bd17458de54c126183a21a4c70c44032b00cb`, 175 commits,
624 changed files, 62,701 lines added and 16,204 removed, 221 files added, 14
deleted, 389 modified. The pull request is open and mergeable.

## 1. How the review was done

Every claim below carries an evidence level, so you can see how much weight it
holds without re-reading the code.

| Level | What it means                                                                     |
| ----- | --------------------------------------------------------------------------------- |
| E0    | Someone claimed it in a comment, commit message or bug report. No code read yet.  |
| E1    | The code was found and read in one place, and the behaviour follows from reading. |
| E2    | The whole path was traced, from the event that starts it to the effect it has.    |
| E3    | The path was traced and a test that actually ran confirmed or contradicted it.    |
| E4    | A test reproduced it. The test fails before the fix and passes after it.          |
| E5    | Checked on a running desktop build. Nothing here reaches E5. Section 8 says why.  |

Read in full: all 175 commits, 65 issue comments, more than 60 reviews, 263
inline comments across 184 review threads, the whole cumulative diff,
`AGENTS.md`, `FULL-REVIEW.md`, `REVIEW.md`, the package scripts, the Cargo
manifests and the CI workflows.

## 2. What the 175 commits actually are

They are not 175 separate changes. They are five feature branches joined onto
one trunk, plus a long tail of review fixes.

| Group            | Commits                           | Content                                                                                                        |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Integration      | 4 merges of main, 4 branch merges | Re-merges of main and of the feature branches                                                                  |
| Feature work     | 4 commits                         | Spoken formatting commands with a silence filter, the assistant on the pill, remote send, review before insert |
| Review fixes     | 86 commits                        | Mostly driven by bots and review rounds, including several reverts of earlier fixes on the branch              |
| Tests            | 9 commits                         | Added alongside their fixes                                                                                    |
| CI, chores, docs | 17 commits                        | Workflow hardening, secret scanning rules, migration numbering                                                 |

Three things follow from that shape.

The branch leaves something out on purpose. The pull request body records that
commit `248ca2c` from PR 59, which makes release signing fail closed, was
deliberately not carried over. That is a decision, not a defect, but it blocks a
release (E1).

Several fixes on the branch revert earlier fixes on the same branch. Every area
that was reverted was re-checked against the current head rather than trusted
from history.

Migrations are append-only again. The numbering was corrected mid-branch and
nothing is renumbered on the head (E2).

## 3. What the branch ships

| Area                    | State at the head of PR 63                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The pill                | Three native crates for Windows, macOS and Linux, with shared logic in `rust_pill_shared`. Phases, style bar, cancel, pause, resume, assistant panel, permission cards, toasts, drag and reset |
| Assistant on the pill   | Streaming replies, tool calls, permission prompts, typing mode, open in the app                                                                                                                |
| Dictation               | Manual and automatic styling, style switching while recording, pause and resume, backlog, limits                                                                                               |
| Transcription providers | Groq, OpenAI, Deepgram, ElevenLabs, Mistral, Cerebras, Gladia and any OpenAI-compatible endpoint                                                                                               |
| Post-processing         | Tone pipeline, provider metadata, failure recording, 50 second timeout                                                                                                                         |
| History                 | Retranscribe with guards against stale results, duration refresh, audio storage                                                                                                                |
| Review before insert    | A separate composer window before this branch. Now the pill's own assistant panel, with the transcript in its entry                                                                            |
| Remote send and receive | Pairing and delivery of the final text                                                                                                                                                         |
| Spoken commands         | Formatting commands and a filter for hallucinated silence                                                                                                                                      |
| Updater and signing     | Manifest rules and a secret guard. Signing that fails closed is deliberately absent                                                                                                            |

## 4. Findings

### 4.1 Real defects, now fixed

| Ref | Finding                                               | Evidence | Cause                                                                                                                                                                   | Commit    |
| --- | ----------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| A   | Settings, API keys, crashes when Gladia can be chosen | E4       | Gladia is listed as an API key provider and reports that it supports transcription models, but the form config had no Gladia entry, so the list read a name off nothing | `f93f2bb` |
| C   | Clicking the pill body while paused ends the session  | E4       | The click always went to the start and stop toggle. Resume only existed on the side button                                                                              | `14d438a` |
| D   | Two sounds for one click on the pill body             | E2       | The pill played its own click feedback while the desktop played the recording chime for the same click                                                                  | `2c7e2a3` |
| E   | The review window opens in the middle of the screen   | E4       | The pill only published its position after a drag, so the first review of a session had no position to sit next to                                                      | `1f38d0d` |
| J   | The repo-wide formatting check was red                | E3       | Trailing whitespace in `README.md`                                                                                                                                      | `ee3045d` |

### 4.2 Behaviour that was incomplete, now finished

| Ref | Finding                                                  | Evidence | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Commit               |
| --- | -------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| F   | Review before insert opened a window away from the caret | E2       | The transcript now opens the pill's own assistant panel, the same surface that morphs out of the pill for the assistant, with the text loaded into the panel's entry so it can be edited in place. Insert, Copy and Cancel sit above the entry, Enter inserts, Escape cancels, closing the panel cancels, and the pill body is inert until the transcript is answered. Each decision carries the id it answers and the text as edited, and a second transcript queues behind the first. Builds with no native pill at all still fall back to the composer window | `8633a6c`, `864ab34` |

### 4.3 A decision you asked for, now implemented

| Ref | Decision                                                                                       | What changed                                                                                                                    | Commit    |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------- |
| B   | Switching style while recording should restyle the whole transcript and stick for the next one | When finalising in manual mode, the style captured at stop now wins over the one captured at start. Automatic mode is unchanged | `44f886d` |

### 4.4 Claims that were already correct, so nothing changed

| Claim                                                      | Evidence | Result                                                                                            |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| The generated bindings have drifted from the Rust commands | E3       | All 130 handlers appear in all three lists and nothing called from TypeScript is missing          |
| Post-processing loses which provider and model it used     | E2       | Both are captured before the request and kept on failure                                          |
| Cerebras payment errors are mishandled and leak secrets    | E2       | They are mapped to a clear message and redacted                                                   |
| Retranscription loses durations and races itself           | E2       | Durations are refreshed and stale results are discarded                                           |
| Retrying post-processing creates a second history row      | E2       | It writes back to the same row                                                                    |
| Markdown rendering is unsafe                               | E2       | No raw HTML is enabled, and pill text goes through a plain-text converter with a length cap       |
| The composer can open blank or twice                       | E3       | A readiness timeout, a recovery message and a single-flight guard are already there               |
| The Windows pill sticks to the top of the screen           | E2       | The pill placement code is correct. That report is really the composer window, which is finding E |

### 4.5 Needs to be checked on a real machine, so left alone

| Ref | Claim                                                                            | Why it was not fixed                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H   | The assistant stops after a tool call with an error about an invalid resource id | The agent loop and all three provider mappings were traced and no unguarded call was found. The wording of the error comes from Tauri's own resource table, which points at something disposed in a native call rather than at the loop. Fixing it from reading alone would be guesswork |

### 4.6 Decisions left to you

The macOS pill plays a click on Pause and Resume. Windows and Linux stay silent
there. It is not a double sound, since the desktop plays nothing for those
buttons, so this is a difference between platforms for you to settle.

The transcript is edited on one line in the panel's entry, the same field the
assistant is typed into. The whole text is shown above it, wrapped and
scrolling, and it updates as it is edited. A multi-line editor in the pill would
mean replacing the text control in all three native crates, which is a much
larger change for a surface that usually holds a sentence or two.

The buttons on the pill say Insert, Copy and Cancel in English, the same way the
existing permission card is hardcoded. The pill has no translation system of its
own.

Release signing that fails closed is still missing from this branch.

## 5. What I got wrong in my own first pass, and fixed

I re-read my own changes line by line and found six mistakes worth naming.

The pill could hide the very card it was asked to show. If the pill visibility
setting is Hidden or While active, the pill hides as soon as the phase returns
to idle, and a review card arrives exactly then. On Linux the clickable area
also shrank back to the pill body, so the buttons could not be pressed even when
drawn. The rule for when the pill is on screen was written out three times, once
per platform, so I moved it into the shared crate as one function that also
counts a waiting review as a reason to stay visible, and the Linux click area
and the Windows hover test now follow the same rule. Commit `8ae2e6b`, with
tests in the shared crate.

A review could be queued that nobody could answer. The transcript was put in the
queue before the listener for decisions was registered, so if registering failed
the caller waited forever. There was also no upper bound, so a card the user
walked away from held up the insert path for good. The listener is now
registered first and a failure falls back to the composer window, and a card
that goes unanswered for five minutes gives up and leaves the transcript in
history, which is exactly what the composer window already does. Commit
`ab206e0`, with two new tests.

The card was taller than the panel it lives in, which is the worst of the six.
The expanded panel leaves 138 pixels between the header and the pill. My card
asked for up to 262, so any transcript longer than about two lines put Insert,
Edit, Copy and Cancel behind the pill, and the panel refused to scroll while a
review was open, so there was no way to reach them. I found this by working the
geometry out on paper rather than by running it, since there is no Rust
toolchain here. The card is now sized to the space it has, the line count comes
from one function in the shared crate so the three renderers cannot drift, and
the marker for cut text sits on the last line shown instead of taking a line of
its own. A pending review also makes the panel scrollable now. Because
scrolling can move a card out of view, click regions from the scrollable
content are dropped when their centre leaves the visible band, so an invisible
button cannot take a click. That last part also fixes the same hazard for
permission cards. Commit `1446827`, with tests on the sizing function that use
the real panel geometry.

Both bridges guessed at a review decision they could not read. A missing or
unknown action became cancel and a missing id became an empty string, so a wire
mistake would have thrown away the transcript the card was asking about, with
nothing logged. Both now go through one checked parser that requires an id and
a known action and drops anything else with a warning, which leaves the card on
the pill so the click can be repeated. Commit `0d3f2b6`, with parse tests for
every accepted action and every way a line can be unreadable.

Small things in the same pass. The new drawing function had taken over a clippy
exception that belonged to the permission card next to it, it measured its
button labels with `unwrap`, the same Tauri command was called by hand in two
places instead of through the generated bindings, an exported helper was never
used, and the new user-facing message had not been extracted or translated. All
of that is corrected, and the new message is now translated into all nine
locales.

## 6. What the review bots found, and what I did with it

The automated reviewers ran over the pushed branch. Sonar passed its quality
gate with two issues, DeepSource graded the change A with twenty three, and
CodeSpect and Kilo each left a handful. I checked every one against the code
rather than taking it on trust.

Two were real defects, both mine, and both on the review panel. Escape
cancelled a transcript under review only on Windows. The macOS pill had no
Escape handling at all and the GTK pill only wired Enter and change on its
entry, so on two platforms out of three the card could be left only through
its buttons or the five minute expiry, while the panel and this report both
said Escape works. macOS now makes the pill view the text field's editing
delegate, which is where the field editor sends Escape, and Linux handles the
key on the window, which sees it before the focused entry. The same macOS
delegate also mirrors each keystroke into state, so a click on Insert or Copy
can never answer with the text as it stood at the previous frame. Commit
`b1fe214`, with a contract test across all three crates.

The parser for a review decision wrote the whole unreadable line into a
warning, and that line carries the transcript. Logs travel with bug reports,
so that is a leak of exactly the text the user was reviewing. The warnings now
carry the parse error and the short action token only. Commit `897e259`, with
a contract test that fails if a diagnostic starts repeating the line again.

The rest were about shape rather than behaviour, and the ones worth taking are
in commit `084bdd6`: the same stale id check written twice, a publish step and
a settle step that called each other, a switch with three exits, and a five
branch chain inside an effect that decided the pill window size where no test
could reach it. That chain is now a pure function with its own tests. A
decision that fails also clears its busy flag now, so the click can be
repeated instead of the transcript sitting behind a flag nobody can clear.

Two more rounds ran on the fixes themselves. In
`packages/rust_macos_pill/src/app.rs`, the helper `field_string` passed the
pointer from `UTF8String` straight to `CStr::from_ptr`; it now checks that
pointer and the string value for null first, and reads the bytes with
`to_string_lossy`, so text that is not valid UTF-8 keeps its readable
characters instead of the whole entry reading as empty. In
`parse_review_decision` in `apps/desktop/src-tauri/src/pill_process.rs`, the
unknown action warning printed the Rust debug form of an option, so it reached
the log as `Some("x")`; it now prints the token itself, capped at 32
characters so a malformed line cannot write an unbounded string into the log.
Commits `438ae23` and `1829845`. `applyDecision` came down to five in the same
two commits, by moving the answer text into `reviewAnswerText` and by clearing
the busy flag in a `finally` rather than a catch and a rethrow. The other
queue function stays whole, for the reason below.

Three suggestions I did not take, with the reason.

Kilo reported that macOS never syncs the field into state, so every Insert
and Copy would send the pre-edit transcript. The sync does exist: the pill
ticks on every vsync and copies the field into state while the entry is
shown. The window was one frame wide, not total, so the report was overstated.
The per-keystroke delegate closes that frame anyway.

CodeSpect asked for the new binding in `bindings.ts` to return its error
instead of rethrowing it. That file is generated by tauri-specta and says so
at the top. Every other command in it rethrows an `Error` the same way, and
the next `pnpm gen:bindings` would undo a hand-made exception. The right place
for that change is the generator, not this branch.

DeepSource asked for the queue transition to be split. It was two functions
before, a publish half and a settle half, and each called the other. That is
the mutual reference DeepSource itself flagged as use before define in the
first round. The function is twenty lines and runs top to bottom, and most of
its count comes from null safe access rather than from branching, so it stays
as one function.

CodeSpect also asked for the click-feedback contract test to find the pill
click handler with a non-greedy regular expression instead of counting braces.
I ran the suggested expression against the real file: it stops at the first
closing brace, which is the end of the pending-review guard, so it captures
seven lines of a fifty line handler. The test that checks the loading guard is
still there would fail, and the test that checks no sound is played would pass
without reading the code that plays it. Brace counting stays.

A third round came from CodeRabbit, eight comments on the review panel and its
bridge. Four described real problems and are fixed here.

A click target that had scrolled half out of the panel was kept whole whenever
its middle was still inside, so Insert or Cancel could be pressed on the strip
the chrome had painted over, and a button whose middle had just left was
dropped even though a sliver of it was still visible. Each target is now cut
down to the part of the panel that shows, by one helper in the shared crate
with tests on both edges. Commit `2950ed3`.

On Linux the clickable area of the window still asked whether the assistant
was running. A review opens the panel on its own, so the buttons were drawn
outside the area that accepts a click and could not be pressed at all. The
same question was being asked in the layout: the review and the window size
arrive as two separate messages, so a review that landed first was drawn into
a pill-sized box. The pill state answers both questions now, `owns_panel` and
`effective_window_mode`, and every place that used to guess uses them. Commit
`c5696c3`.

The entry text was trimmed before it was sent, which quietly changed the
transcript the user had lined up for their document. Trimming now only decides
whether there is anything to send. Enter in the Windows entry had the reverse
problem, clearing the box even when nothing went out, so a whitespace
entry lost the transcript for nothing. Commit `5fa27fd`.

The macOS bridge hands its messages to the pill through a channel behind a
lock and threw away both failures, so asking the pill for its position
answered Ok with nothing sent and the placement dialog waited for an event
that could never come. Windows and Linux already report that failure. The
helper now returns it, the calls that are waiting pass it on, and the rest log
the lost message. Commit `192366b`.

The remaining four repeated the same two points on other lines, and are
covered by the same commits.

CodeSpect then looked at the two test files those commits added and found the
duplication that came with them. Each contract test that reads Rust source
carried its own copy of the repository root, the file reader and a brace
walker, five copies in all, and the newest two were close enough for the
duplication check to count them. All five now share
`apps/desktop/test/helpers/rust-source.utils.ts`, and the walker starts
counting at the first brace from the marker onward so a marker that carries
its own brace still yields the whole block. It reports a missing marker or an
unbalanced block by throwing rather than by calling a test assertion inside a
helper, and it has its own tests. Commits `0ed1ea8` and the follow up that
hardened the helper.

One thing the bots did not raise, found on a re-read of my own change. The
macOS bridge sends audio levels on every frame, so logging each failed hand
off would have written a warning sixty times a second once the pill was gone.
The first failure is reported and the rest are left at debug level.

CodeRabbit then found a leak in code this branch added. Every Foundation
string the macOS pill makes with `NSString::alloc(nil).init_str(...)` is owned
by this process, and Cocoa calls that take a string keep their own copy, so
each one had to be released. None were. It showed up in `set_entry_text`,
which runs once per review, but the same pattern draws every line of text in
`gfx.rs`, so the pill was leaking a string on every frame it painted. All nine
call sites now go through `with_ns_string` in
`packages/rust_macos_pill/src/nsstring.rs`, which releases the string once the
call that needed it has returned, and a contract test fails if a new caller
allocates one directly. The release hangs off a guard, so it also runs if the
call it wraps panics, and two tests in the crate itself prove it on both paths
by holding a reference of their own and reading the count that is left. Those
run in the macOS lint job, which is the one job that builds this crate's tests.
Two one-shot sites in
`apps/desktop/src-tauri/src/platform/macos/permissions.rs` have the same shape
but leak one small string per click on a settings link, so they are left for a
change that can be checked with Instruments on a real machine.

The first build after that fix failed, and the failure is worth naming. The
macOS pill crate is built twice, once as the library the desktop app embeds and
once as a standalone binary, and each of the two roots lists its own modules. I
added the new string helper to the library root only, so the binary could not
find it. There is no Rust toolchain in this workspace, so nothing here would
have caught that before the push. A new contract test now reads the module
files of all three pill crates and fails if any root leaves one of them out.

## 7. Fixes, cause and test

| Commit    | The fix                                                                                                                                                                 | Test that guards it                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `f93f2bb` | Gladia registered in the API key form config, and the map typed so a missing provider fails to compile instead of throwing at runtime                                   | A test walks every provider in both contexts. It fails if the entry is removed                                      |
| `14d438a` | A small pure function decides what a pill body click means, and a paused click resumes                                                                                  | Four cases: paused, idle, other window, already stopping                                                            |
| `2c7e2a3` | The pill no longer plays its own sound for a body click on any platform. The loading guard, the style click and the cancel click are untouched                          | A test reads the click handler of all three crates and asserts no sound and a kept loading guard                    |
| `1f38d0d` | A new message asks the pill to publish its position, and the app asks once at startup. The placement maths is unchanged                                                 | Four cases, including listener before request, timeout fallback and the cached path                                 |
| `44f886d` | Finalising in manual mode prefers the style captured at stop                                                                                                            | The style tests were rewritten to the new contract                                                                  |
| `ee3045d` | Formatting on `README.md`                                                                                                                                               | The repo formatting check is green                                                                                  |
| `8633a6c` | The review travels inside the assistant state message the pill already receives, and comes back as a decision tagged with the review id                                 | Seven cases: insert, cancel, copy, edit, queueing, a stale decision and an unknown action                           |
| `8ae2e6b` | One shared rule for when the pill is on screen, which now counts a waiting review                                                                                       | Four cases in the shared crate, including a hidden pill that must still show a review                               |
| `ab206e0` | Listen before queueing, fall back to the composer if listening fails, and expire a card after five minutes                                                              | Two new cases: the listener fails, and nobody answers                                                               |
| `0d3f2b6` | One checked parser for the decision the pill sends, on both bridges. An unreadable line is logged and dropped instead of read as cancel                                 | Parse tests for each action and for a missing id, an unknown action, a wrong type and bad JSON                      |
| `1446827` | The review card is sized to the panel, the panel scrolls while a review is open, and click regions outside the visible band are dropped                                 | Tests on the shared sizing function, including the panel geometry that exposed the bug                              |
| `864ab34` | The review moved into the pill's own panel and entry: the transcript is edited in place, Enter and Escape work, and no window opens for it                              | Three cases on the edited text coming back from the pill, plus the parse test for the text field                    |
| `b1fe214` | Escape answers a review on macOS and Linux as well as Windows, and the macOS entry mirrors each keystroke into state                                                    | A contract test reads all three crates and fails if a platform loses its Escape path                                |
| `897e259` | The review decision parser logs the error and the action token, never the line, because the line holds the transcript                                                   | A contract test fails if a diagnostic in the parser repeats the line again                                          |
| `084bdd6` | One transition through the review queue, one stale id guard, and the pill window size decided by a pure function                                                        | Five cases on the window size function, and the existing eleven review cases still pass                             |
| `438ae23` | `field_string` in `rust_macos_pill/src/app.rs` checks both pointers, `parse_review_decision` in `pill_process.rs` logs the action token, and the answer text has a name | The eleven review cases cover the answer text, empty edit included                                                  |
| `1829845` | The same field reader keeps text that is not valid UTF-8, the logged token is capped at 32 characters, and the busy flag clears in a `finally`                          | The log privacy contract test, and the eleven review cases                                                          |
| `2950ed3` | Click targets in the panel are cut down to the part still on screen, so a half hidden review button answers only where it shows                                         | Seven cases on the shared clipping helper, both edges and both misses, plus a contract test across the three crates |
| `c5696c3` | `owns_panel` and `effective_window_mode` on the pill state, so a review owns the clickable area and the window size with no assistant session behind it                 | A contract test reads all three crates for both helpers and for the Linux input region                              |
| `5fa27fd` | The entry text travels as the user left it, and the Windows box is cleared only when something was sent                                                                 | A contract test on `submit_entry` in all three crates and on the Windows Enter path                                 |
| `192366b` | The macOS bridge returns a failed hand off instead of answering Ok, and logs the messages nobody is waiting on                                                          | A contract test on the send helper and on both position calls, against the child process bridge as the reference    |

Throughout: no `any`, no new `unwrap`, no fixed sleeps, and no silent fallbacks,
since every fallback logs. Stale replies are matched by id. The platform
adapters stay separate. No test, lint, type, content-security, capability,
validation or signing rule was weakened.

## 8. Interfaces that changed

A new Tauri command, `request_pill_position`, registered in `app.rs`, exported
through Specta and written into `bindings.ts` in the exact shape and position
the generator uses. The desktop calls it through the generated binding, so the
type checker validates that hand-written entry.

A new message to the pill, `request_position`.

An extra optional field on the assistant state message, `review`, so an older
pill binary simply ignores it.

A new message from the pill, `review_decision`, carrying the review id, the
action and the text the entry held, surfaced to the app as the
`pill-review-decision` event.

A new piece of app state, `pendingPillReview`.

## 9. Verification

Run here, all green.

| Check                                   | Result                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Types across all packages               | Pass                                                                                                                                   |
| Desktop unit tests                      | `pnpm --filter desktop test:unit` on this branch head: pass, 123 files and 1,284 tests, against 112 and 1,185 at the start of the work |
| Desktop lint, formatting and oxlint     | Pass, no warnings and no errors                                                                                                        |
| Repo-wide formatting                    | Pass, and it was failing at the head of PR 63                                                                                          |
| Build                                   | Pass, 6 of 6 packages                                                                                                                  |
| Message extraction and translation sync | Pass and idempotent, a second run changes nothing                                                                                      |

Not run here, and why.

| Check                              | Reason                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust build, clippy and crate tests | There is no Rust toolchain in this sandbox and the Rust download hosts are unreachable, so every Rust change on this branch is compiled first by CI. On this head CI is green: clippy over all targets on the three platforms, the desktop build on the three platforms, and the crate tests, which include the two that measure the macOS string release |
| Regenerating the bindings          | That script runs cargo. The entry was written by hand to match the generator and the CI check is the authority                                                                                                                                                                                                                                            |
| Desktop integration tests          | They need a Groq API key, and they fail the same way on the unmodified head                                                                                                                                                                                                                                                                               |
| WebDriver tests                    | Installing them needs a download that is blocked here                                                                                                                                                                                                                                                                                                     |
| Anything that needs a running app  | No display and no packaged build                                                                                                                                                                                                                                                                                                                          |

## 10. What to check before release

Build the three pill crates on Windows, macOS and Linux and run clippy on all
four Rust crates. This is the first compile of the review code.

Click the pill body while paused, while idle and while recording, and count the
sounds on each platform. There should be exactly one per click.

Run review before insert on the native pill, on each platform: edit the text in
the entry, then insert with Enter and with the button, copy, cancel, press
Escape both while the entry has the keyboard and while it does not, close the
panel, and let a second dictation finish while one is open so you can see it
queue. Also set the pill to Hidden and confirm the panel still appears. Check
that no separate window opens at any point.

Open the composer next to the pill on first use, on more than one monitor, with
a pill that has never been dragged.

Switch style in the middle of a dictation and confirm the whole transcript comes
back in the new style and the next recording starts on it.

Open Settings, API keys, with a Gladia key configured.

Reproduce the assistant stopping after a tool call on a debug build and capture
the stack trace for the invalid resource id.

Static review does not prove desktop-runtime behavior. The required platform and
end-to-end checks remain necessary before release.

## 11. Takeover state (September 9, 2026)

The coordinating session stopped before it opened its pull request. A second
session took the branch over at commit `052e6e4` (single squashed snapshot)
and opened the pull request from `arena/01a08611-mausvoice` against
`fix/superfix-review-findings`, the head of PR 63.

State of the re-review at handover.

- Compared against the PR 63 head `f13ab95`: 128 changed files, 4,381 lines
  added and 1,822 removed. Every changed file was re-read against the final
  tree; the fixes in sections 4 and 5 are intact and not regressed by later
  commits.
- The final session stage added, on top of the fixes above: the Open decision
  on the review card (header open button) with durable persistence before the
  card closes, the pending Paste review bubble in Chats for agent Paste calls,
  an integer ceiling division and fallible allocation in the resampler, Base64
  framing with a decoded-size preflight in the private HTTP bridge, the
  capability-based managed audio directory, strict SemVer release validation
  with minisign verification of every updater bundle before `latest.json` is
  written, OpenRouter transcription model discovery, and non-shell dev
  runners.
- Verified locally on this tree: `pnpm install --frozen-lockfile`, workspace
  build, desktop and root type checks, desktop lint, desktop unit tests, the
  i18n extractor (idempotent, nine locales in sync), and the repo formatting
  gate. Rust compiles and tests only in CI: there is no Rust toolchain in this
  sandbox, and the download hosts are unreachable. The CI jobs that cover the
  Rust changes are the lint matrix (clippy with `-D warnings` on all three
  platforms plus crate tests), the desktop Rust unit tests (which also run
  `scripts/check-bindings.sh`), and the three-platform transcription tests.
- The desktop integration tests fail locally only for the missing
  `GROQ_API_KEY`; CI provides the secret for same-repo pull requests.

Open items carried forward: the assistant invalid-resource-id repro (section
4.5), the platform sound parity decision (section 4.6), and the manual QA
matrix in section 10.

## 12. Deep-dive re-audit (September 9, 2026, second pass)

A second audit pass executed the pure-logic code instead of reading it
(every pure function run with constructed inputs), and web-verified each
external claim against the governing source (HTML Standard, Cerebras
docs, OpenRouter docs, Tauri updater docs, semver.org). Five confirmed
behavioural defects were found, fixed, and pinned with regression tests:

1. **Auto-learn never learned casing corrections** (`auto-learn.utils.ts`).
   The multiset difference between inserted and corrected text was
   case-insensitive, so the feature's primary signal — a user correcting
   "google" to "Google" — produced no added token and nothing was
   learned. The diff is now case-sensitive; the initial-capital check and
   the case-insensitive existing-terms skip are unchanged.
2. **Pill text lost content on numeric ranges**
   (`assistant-pill-text.utils.ts`). The HTML tag scanner treated a `<`
   followed by a digit as a tag start (HTML tag names start with an ASCII
   letter), so "I have <3> apples" became "I have apples" and a long span
   up to the next `>` was deleted. Tag start is now letter/`!`/`?` only.
3. **"scratch that" was a no-op after "new line"/"new paragraph"**
   (`spoken-commands.utils.ts`). The scratch boundary search stopped at
   the trailing newline the structural command had inserted, keeping the
   sentence the user asked to drop. Trailing stops and whitespace are now
   trimmed together before the boundary search.
4. **A second agent run made Stop dead for the first** (`run-agent.ts`,
   `chat.actions.ts`). Two concurrent sends for one conversation (pill
   typed message while a dashboard run is live) let the newer run
   overwrite `activeLoops`; the superseded run's cleanup then deleted the
   NEWER run's registration and agent state, so `abortAgentLoop` reached
   nothing and two loops interleaved one conversation. A new run now
   supersedes (aborts) the previous loop, and both cleanups are
   identity-guarded so only the current run deregisters itself.
5. **Hardcoded English aria-label** (`PendingPasteReviewBubble.tsx`), in
   this branch's diff. Now goes through the i18n pipeline with real
   translations in all eight non-English locales (catalogs 829 keys).

Also corrected a stale contract comment in `DictationSideEffects.tsx`
that described the superseded start-tone contract; the implemented and
tested contract is that the stop-time snapshot is authoritative and a
mid-dictation switch restyles the whole transcript.

Verification: the full desktop unit gate (1,339 tests), the node
dev-script tests (4), the formatting gate, and the idempotent i18n sync
all pass locally. Pre-existing hardcoded aria-labels in `main`
(`HotkeySetting` "Enable hotkey" and four others) were noted and left
untouched as out of scope for this PR.

## 13. PR #190 review round (opened September 9, 2026)

After the PR opened, the review bots returned:

1. **CodeSpect (major, the only finding it actually posted):** the
   private-HTTP path decodes the request body to a `Vec<u8>` (up to the
   128 MiB limit), and the existing redirect loop cloned that buffer into
   the reqwest builder on every 307/308 hop - a full copy of the payload
   per hop (up to 5 hops), so a redirecting server could push peak memory
   toward several hundred MiB. This branch introduced the decoded-Vec
   source, so it was in scope. **Fixed in `0a09a93`:** the decoded body is
   now a `bytes::Bytes` (a refcounted buffer, wrapped zero-copy from the
   decoded `Vec`), so per-hop clones are O(1) and reqwest stores the body
   as its reusable variant (verified against the reqwest 0.12.28 source:
   `impl From<Bytes> for Body`). `bytes = "1"` added to the desktop Cargo
   manifest and lockfile (already in the tree via reqwest, no new version).
2. **Kilo Code Review check failed with "Assistant request was rate
   limited"** - a failure of the bot's own service, not a code finding.
   It re-runs automatically on the next push.
3. **Buoy (neutral):** suggested design tokens for two MUI scale values in
   `PendingPasteReviewBubble.tsx`. Those values (`border: 1`,
   `borderRadius: 1`) are scale units, not raw pixels, and are the
   established convention in this component family (ChatMessageBubble,
   ConversationLayout, ConversationListItem all use the same). The
   suggested tokens do not exist in the design system; replying that we
   keep the family convention and would rather add the tokens for the
   whole family in a follow-up than invent them for one component.

## 14. Line-by-line re-audit of the full PR content (September 10, 2026)

Per the standing directive, the entire diff (main `72d4163` -> this branch,
662 files) was re-audited line by line: Rust executed against reqwest/Tauri
docs, TypeScript executed locally (merge algorithm, spoken commands,
unit suite) and checked against provider API references, web-verified
against OpenAI, Hugging Face, k2-fsa, ElevenLabs, Gladia, and Tauri
sources. One confirmed behavioral bug class was found and fixed:

### 14.1 FIXED: JSON response-format selection (voice-ai)

`openai.utils.ts`, `openrouter.utils.ts`, and `azure-openai.utils.ts`
decided, per model, whether to send OpenAI's new `json_schema` response
format or the legacy `json_object` format. Two defects, both verified
against OpenAI's official Structured Outputs documentation and the
documented 400 errors:

1. The "supports json_schema" allow-list wrongly included
   `gpt-4-turbo` / `gpt-3.5-turbo` (OpenAI and OpenRouter) and `gpt-4` /
   `gpt-35-turbo` (Azure deployment names). Those predate Structured
   Outputs and are rejected with a 400 when sent `json_schema`, so any
   post-processing run targeting one of them failed.
2. The `json_object` fallback never put the word "JSON" into the prompt.
   OpenAI's API rejects `json_object` requests whose context never
   mentions JSON ("the API will throw an error if the string 'JSON' does
   not appear somewhere in the context"). Cerebras and DeepSeek already
   injected the schema instruction; the other three providers did not.
   OpenRouter made this reachable for every discovered model outside the
   allow-list, including the o-series, which additionally rejects
   `json_object` outright - so those got a 400 from the wrong format too.

**Fix (smallest root cause):** inverted the decision to a small
legacy-only `json_object` set (the pre-Structured-Outputs chat models);
every other model - curated or discovered - defaults to `json_schema`.
On the legacy branch, the schema instruction ("Respond with valid JSON
matching this schema: ...") is appended to the prompt, exactly as
Cerebras/DeepSeek already did. Azure additionally keeps `json_object` for
user-deployed open-model families (llama/phi/mistral/mixtral), which
Azure serves through JSON mode only (an existing test pins this
behavior). 9 regression tests added (legacy model -> `json_object` +
prompt hint; o-series/discovered model -> `json_schema`, prompt
untouched; Azure `gpt-4` deployment and open-model deployments ->
`json_object` + hint). voice-ai: 159/159 tests pass; full workspace
build green; desktop `test:unit` green.

### 14.2 Re-verified OK (no behavioral bugs)

- **Merge/overlap algorithm** (`transcribe.utils.ts`): executed 8 cases
  (exact overlap, truncated word, fuzzy contraction, no overlap, prefix
  coincidence). The one imperfect case (a complete word that is a prefix
  of the next segment's first word, e.g. "you"/"your") is a pre-existing
  heuristic present in main before this PR - the PR only refactored the
  same algorithm for speed. Not a regression; noted as a known
  limitation.
- **Silence gating:** `gateSilentSegments` (all-gated -> empty text, not
  fallback), `analyzeSilence` (requires global AND windowed RMS and peak
  below thresholds - quiet real speech survives), `joinKeptSegmentTexts`
  spacing rules.
- **Spoken-commands engine:** traced scratch/abbreviation stops
  (incl. `Dr.` and 2-letter `a.`), blocked follower/predecessor pairs,
  gap/whitespace preservation, attach-left punctuation.
- **Pill review queue** (`pill-review.actions.ts`): busy-flag
  double-click guard, expiry-vs-persistence race (timer cleared before
  the await), stale-click identity check, composer fallback when no
  native pill, queue-advance semantics (later arrivals do not extend the
  open card's expiry).
- **Dictation backlog** (strategy + `drainDictationBacklog`):
  non-destructive snapshot + nonce pre/post checks, serial paste queue,
  cleanup on session end prevents stale-session delivery, 1s drain poll
  only while a backlog exists.
- **Output routing / secure-fetch:** review gate before remote and local
  delivery, hands-free delay invalidation by session id, http ->
  native SSRF-guarded command / https -> curated capability allow-list,
  body stream capping at 128 MiB with abort support.
- **macOS manual installer path:** TS derives the `.dmg` + detached
  `.sig` URLs (exact `${dmgUrl}.sig` only), Rust re-validates the host,
  validates every redirect hop, caps the download, and verifies the
  minisign signature before `open` - an unverified installer is never
  launched.
- **Gladia provider (new, 861 lines):** language mapping, WS endpoint
  allow-list, transcript accumulator (finals never overwritten,
  authoritative post-final override), finalize deadline clamping,
  remote session deletion in all paths; desktop session feeds PCM16
  matching the declared encoding.
- **Stop flow / tone contract:** stop-snapshot wins (whole utterance
  restyled, persisted selection seeds the next recording), start
  snapshot only as fallback, awaited style load before seeding,
  provider timer anchored to native capture success, empty-result
  handling preserves the recording with a retry toast.
- **Hotkeys:** level-based hold model with `allowedAdditionalKeys`
  (arrows during hold do not break hold-to-talk release), native fire
  model contamination logic unchanged from main, release-on-key-up for
  style actions, main-window-only guards against double dictation from
  the composer popout.
- **run-agent / chat actions:** `safeSideEffect` isolation in the loop,
  block-atomic context trimming (tool-call/result pairs never split),
  supersede identity guard, delete-vs-send race (flag + queue drain +
  abort + post-delete guard).
- **Provider model pins:** OpenAI transcription response formats
  (web-verified), ElevenLabs `scribe_v2` (web-verified), Gladia
  `solaria-1` + API shape, OpenRouter default/favorites, xAI `format`
  field ordering.
- **Release pipeline:** hardcoded throwaway signing key removed from
  `release.yml`; updater keypair lives only in repository secrets;
  manifest entries emitted only with a matching `.sig`; release tag
  round-trips through the manifest URL into the manual-installer URL.
- **SQL migrations:** additive only, safe defaults, all matching the TS
  preference defaults (verified per column).
- **Scripts/workflows/locale parity:** CI-enforced (Format+i18n gate
  green on this branch).

Residual: `TutorialForm`, `MoreSettingsDialog`, `StyleHotkeysDialog`,
`ApiKeyList`, `MicrophoneTester`, `ScrollListPage`,
`TranscriptionsPage`, `ConversationListItem` were structurally reviewed
(form/UI wiring whose underlying logic lives in the audited
utils/actions/repos); no behavioral logic was found inline.

## 15. CI gates after the PR opened (September 10, 2026)

### 15.1 SonarCloud "8.5% duplication on new code" — fixed

The three provider response-format test blocks were near-identical.
Extracted the shared block into
`packages/voice-ai/src/test-helpers/shared-json-response-format.helper.ts`;
the three test files now only declare their own model lists and options.
Committed as `9927135` (net -164 lines); all 160 voice-ai tests and the
full monorepo build pass, so the duplication gate should clear on the
next analysis.

### 15.2 macOS build failure at `9927135` — assessed as environmental

The "Build Desktop (macOS)" job failed at the "Build Tauri app" step
after ~2m12s; Windows and Linux jobs on the same commit passed. Evidence
that this is not a code regression:

- Nothing Rust changed since the last green macOS build (`0a09a93`,
  run 34379415766): the delta is TS test files, one test helper, and
  this document.
- The frontend half of the build (the only part that consumes TS) passed
  on all three OSes at this commit.
- A concurrent branch (`arena/01a08680-mausvoice-item02`, commit
  4c6fae1) failed all three OS builds at the frontend step in the same
  window, with its own follow-up commit building green — the build
  queue was producing scattered failures that night.
  The token in this environment cannot re-run the failed job (403), so a
  new commit (this document) re-triggers the full build; if macOS fails
  again at the same step on the new commit, the job log in the GitHub UI
  must be inspected by a maintainer, because the error text is not
  downloadable from this sandbox.

Resolved: the macOS build then passed at `5742244` (Windows, macOS and
Linux all green), where the Rust code is byte-identical to `9927135` —
the delta since the last green macOS build is TS test files, one test
helper, and this document. The failure was an environmental flake; no
code change was needed.

### 15.3 Ito QA diff review (0a09a93 -> 9927135): two real Azure bugs — fixed

Ito QA ran its own tests against the diff and reported two failures,
both confirmed against OpenAI's documentation:

1. **Case-variant deployment names.** The legacy-set lookup compared the
   raw deployment name while the open-model prefix check compared the
   lowercased name, so a deployment named `GPT-4` was misclassified as
   modern and received `json_schema`, which the frozen model rejects
   with a 400. Fix: the set lookup is now case-insensitive (all
   canonical names are lowercase).
2. **Missing frozen preview snapshot names on Azure.** The Azure legacy
   set had drifted out of sync with the OpenAI one (it was a second,
   hand-maintained list): it missed `gpt-4-1106-preview`,
   `gpt-4-0125-preview`, `gpt-4-turbo-preview`, the vision previews,
   and other real ids, and it even listed `gpt-4-0301`, which is not a
   real OpenAI id (the March 2023 snapshot is `gpt-4-0314`, per
   OpenAI's launch announcement and deprecation list). Fix: the
   canonical list in `response-format.utils.ts` is now complete (every
   entry verified against the OpenAI catalog/deprecation page) and the
   Azure set is DERIVED from it (plus the dot-less `gpt-35-turbo`
   names), so the two can no longer drift apart.
   Regression tests: 18 new cases across the OpenAI, OpenRouter and Azure
   response-format suites (case variants, preview snapshots, dot-less
   Azure names). 178/178 voice-ai tests pass; full build green.

### 15.4 Bot checks with no findings — classified as bot-side failures

Across every commit of this PR (`f76804c`, `9927135`, `5742244`,
`35233ea`):

- **CodeSpect**: the check marked itself failed with zero annotations
  and no new inline comments each time. Its single real finding (the
  request-body OOM risk in `commands.rs`) was fixed in `0a09a93` and
  answered in-thread.
- **Kilo Code Review**: stuck in the queued state on every commit, no
  output.
- **DeepSource**: skipped with no output.

None of these three has ever posted a finding on this branch, so their
red or queued state is treated as their own infrastructure problem, not
a code issue. Ito QA, SonarCloud, CodeRabbit, Socket, Gitleaks, Buoy,
and every first-party gate (builds for all three OSes, desktop unit,
integration, lint, format, i18n, Rust unit, voice-ai unit) are green or
clean.

Final bot outcomes (as of HEAD `1b3e51f`):

- **Ito QA re-run (9927135 -> 1b3e51f): PASSED** — "2 fixed, 12
  passing", "safe to merge, no PR-attributable regressions". Both of
  its earlier failures (case-variant and preview deployment names) are
  confirmed fixed inline.
- **Kilo Code Review (after being stuck queued all PR): posted a full
  independent review — "No new code defects found in changed code",
  recommendation to merge.** Its advisory notes: (1) SonarCloud reports
  7 new non-gate issues that are only visible on the authenticated
  dashboard (gate still passed; flagged for a maintainer to glance at
  before merging — not enumerable from this environment); (2) the
  CodeSpect review is stale and should be dismissed (all 3 of its
  issues are fixed — answered on the review itself); (3) the
  `console.log` llm-usage lines in the OpenAI utils are pre-existing,
  out of scope.
- **CodeSpect:** its single CHANGES_REQUESTED review (1 major + 2
  minors) is fully addressed on HEAD — major fixed in `0a09a93`, the
  two minors are the Azure defects fixed in `5742244`. A comment has
  been posted on the review requesting re-analysis/dismissal by a
  maintainer (the token in this environment cannot dismiss reviews).
