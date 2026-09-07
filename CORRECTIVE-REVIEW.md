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
| Review before insert    | A separate composer window before this branch. Now a card on the pill                                                                                                                          |
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

| Ref | Finding                                                  | Evidence | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Commit    |
| --- | -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| F   | Review before insert opened a window away from the caret | E2       | The transcript is now shown on the pill, with Insert, Edit, Copy and Cancel. Each decision carries the id of the review it answers, a second transcript queues behind the first, closing the panel counts as cancel, and the pill body is inert while a card is open. Edit still opens the composer, which is the only surface with a real text field, and the edited text goes back through the caller's normal insert path. Builds without the native pill keep the composer | `8633a6c` |

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

The card on the pill cannot edit text in place. Edit opens the composer. Putting
a real multi-line editor in the pill means a much larger change in all three
native crates.

The card itself does not scroll. It is sized to the room the panel has, so a
long transcript is cut with a marker on the last line it can show, at most
eight. The panel around it does scroll while a review is open. The full text is
always available through Edit and in history.

The buttons on the pill say Insert, Edit, Copy and Cancel in English, the same
way the existing permission card is hardcoded. The pill has no translation
system of its own.

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

## 6. Fixes, cause and test

| Commit    | The fix                                                                                                                                        | Test that guards it                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `f93f2bb` | Gladia registered in the API key form config, and the map typed so a missing provider fails to compile instead of throwing at runtime          | A test walks every provider in both contexts. It fails if the entry is removed                   |
| `14d438a` | A small pure function decides what a pill body click means, and a paused click resumes                                                         | Four cases: paused, idle, other window, already stopping                                         |
| `2c7e2a3` | The pill no longer plays its own sound for a body click on any platform. The loading guard, the style click and the cancel click are untouched | A test reads the click handler of all three crates and asserts no sound and a kept loading guard |
| `1f38d0d` | A new message asks the pill to publish its position, and the app asks once at startup. The placement maths is unchanged                        | Four cases, including listener before request, timeout fallback and the cached path              |
| `44f886d` | Finalising in manual mode prefers the style captured at stop                                                                                   | The style tests were rewritten to the new contract                                               |
| `ee3045d` | Formatting on `README.md`                                                                                                                      | The repo formatting check is green                                                               |
| `8633a6c` | The review travels inside the assistant state message the pill already receives, and comes back as a decision tagged with the review id        | Seven cases: insert, cancel, copy, edit, queueing, a stale decision and an unknown action        |
| `8ae2e6b` | One shared rule for when the pill is on screen, which now counts a waiting review                                                              | Four cases in the shared crate, including a hidden pill that must still show a review            |
| `ab206e0` | Listen before queueing, fall back to the composer if listening fails, and expire a card after five minutes                                     | Two new cases: the listener fails, and nobody answers                                            |
| `0d3f2b6` | One checked parser for the decision the pill sends, on both bridges. An unreadable line is logged and dropped instead of read as cancel        | Parse tests for each action and for a missing id, an unknown action, a wrong type and bad JSON   |
| `1446827` | The review card is sized to the panel, the panel scrolls while a review is open, and click regions outside the visible band are dropped        | Tests on the shared sizing function, including the panel geometry that exposed the bug           |

Throughout: no `any`, no new `unwrap`, no fixed sleeps, and no silent fallbacks,
since every fallback logs. Stale replies are matched by id. The platform
adapters stay separate. No test, lint, type, content-security, capability,
validation or signing rule was weakened.

## 7. Interfaces that changed

A new Tauri command, `request_pill_position`, registered in `app.rs`, exported
through Specta and written into `bindings.ts` in the exact shape and position
the generator uses. The desktop calls it through the generated binding, so the
type checker validates that hand-written entry.

A new message to the pill, `request_position`.

An extra optional field on the assistant state message, `review`, so an older
pill binary simply ignores it.

A new message from the pill, `review_decision`, carrying the review id and the
action, surfaced to the app as the `pill-review-decision` event.

A new piece of app state, `pendingPillReview`.

## 8. Verification

Run here, all green.

| Check                                   | Result                                                              |
| --------------------------------------- | ------------------------------------------------------------------- |
| Types across all packages               | Pass                                                                |
| Desktop unit tests                      | Pass, 115 files and 1,243 tests, against 112 and 1,185 at the start |
| Desktop lint, formatting and oxlint     | Pass, no warnings and no errors                                     |
| Repo-wide formatting                    | Pass, and it was failing at the head of PR 63                       |
| Build                                   | Pass, 6 of 6 packages                                               |
| Message extraction and translation sync | Pass and idempotent, a second run changes nothing                   |

Not run here, and why.

| Check                              | Reason                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust build, clippy and crate tests | There is no Rust toolchain in this sandbox and the Rust download hosts are unreachable, so every Rust change on this branch is compiled first by CI |
| Regenerating the bindings          | That script runs cargo. The entry was written by hand to match the generator and the CI check is the authority                                      |
| Desktop integration tests          | They need a Groq API key, and they fail the same way on the unmodified head                                                                         |
| WebDriver tests                    | Installing them needs a download that is blocked here                                                                                               |
| Anything that needs a running app  | No display and no packaged build                                                                                                                    |

## 9. What to check before release

Build the three pill crates on Windows, macOS and Linux and run clippy on all
four Rust crates. This is the first compile of the review card code.

Click the pill body while paused, while idle and while recording, and count the
sounds on each platform. There should be exactly one per click.

Run review before insert on the native pill: insert, copy, edit, cancel, close
the panel, and let a second dictation finish while a card is open so you can see
it queue. Also set the pill to Hidden and confirm the card still appears.

Open the composer next to the pill on first use, on more than one monitor, with
a pill that has never been dragged.

Switch style in the middle of a dictation and confirm the whole transcript comes
back in the new style and the next recording starts on it.

Open Settings, API keys, with a Gladia key configured.

Reproduce the assistant stopping after a tool call on a debug build and capture
the stack trace for the invalid resource id.

Static review does not prove desktop-runtime behavior. The required platform and
end-to-end checks remain necessary before release.
