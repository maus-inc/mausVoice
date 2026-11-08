# Edge cases for the warm microphone, and how each one is checked

Fifty-two classes of edge case, grouped by the thing they stress. Each row names
the case, what the correct behaviour is, and how it is checked. The last column
is the point of the table: it says whether a test would notice the behaviour
changing, and if not, what would.

The rules this table follows:

- **Verified** means a test in this repository fails if the behaviour changes.
  The row names the test.
- **Inspected** means no test covers it, and a person read the code and decided
  the behaviour is right. It is weaker than a test and is labelled rather than
  merged into the count.
- **Cannot verify here** means the check needs something this environment does
  not have — real audio hardware, a second application, an audio server. The row
  says what would settle it.

Nothing in this file was marked Verified without running it. Where a test was
written for this table, the row was added after the test passed.

## Policy and numeric bounds

These are the values the settings dialog can produce and the values a corrupted
row can produce. The bounds exist so a hand-edited database cannot ask for a
buffer the UI never offers.

| # | Edge case | Correct behaviour | How checked |
| --- | --- | --- | --- |
| 1 | `linger_ms` is exactly `0` | Device closes at stop; no indicator between dictations | Verified — `a_zero_linger_closes_the_device_at_stop` |
| 2 | `linger_ms` is a finite window (1 ms … 30 s) | Stream stays open for that window after stop | Verified — `a_finite_linger_is_a_real_window` |
| 3 | `linger_ms` is the hold sentinel `Number.MAX_SAFE_INTEGER` | Never closes on a timer | Verified — `a_ready_forever_status_line_says_so`, `linger_millis_maps_every_edge_to_the_documented_policy` |
| 4 | `linger_ms` is negative | Still a hold from a caller that asked to open; smallest usable window, not a close | Verified — `linger_millis_maps_every_edge_to_the_documented_policy` |
| 5 | `linger_ms` is `NaN` | Smallest usable window, never a close; NaN is checked before the comparison because every comparison against it is false | Verified — `linger_millis_maps_every_edge_to_the_documented_policy` |
| 6 | `linger_ms` is `Infinity` | Held until released, never a window | Verified — `linger_millis_maps_every_edge_to_the_documented_policy` |
| 7 | `linger_ms` is fractional (`1.5`) | Rounds rather than truncating; `0.9` becomes 1, not 0 | Verified — `linger_millis_maps_every_edge_to_the_documented_policy` |
| 8 | Pre-roll is `0` | Supported choice: records from the press, keeps nothing before it | Verified — `a_zero_length_pre_roll_keeps_nothing_whatever_the_rate` |
| 9 | Pre-roll is above the slider maximum | Clamped to 2 s, not allocated | Verified — `preroll_duration_clamps_to_the_slider_range` |
| 10 | Pre-roll is negative or `NaN` | Clamped to zero; never panics inside the duration conversion | Verified — `preroll_duration_clamps_to_the_slider_range` |
| 11 | Pre-roll is set without a hold | Does not open or keep a device open | Verified — `a_pre_roll_length_alone_does_not_keep_the_device_open` |
| 12 | Pre-roll capacity at a device rate that does not divide evenly | Rounds **up**; a capacity a fraction short drops a whole callback block | Verified — `a_pre_roll_rounds_up_so_a_whole_device_buffer_fits` |
| 13 | Pre-roll at a device rate of 0 | Zero capacity rather than a division by zero | Verified — `a_zero_rate_yields_no_capacity_instead_of_dividing_by_it` |
| 14 | A callback block larger than the whole ring | The tail is kept; the newest audio wins | Verified — `a_block_larger_than_the_ring_keeps_its_tail` |
| 15 | Two policy helpers disagree about one number | Cannot happen: the open policy and the hold decision are asserted against each other | Verified — `warm_policy_agrees_with_the_conversion_it_wraps` |

## Stream lifecycle

| # | Edge case | Correct behaviour | How checked |
| --- | --- | --- | --- |
| 16 | Cold start at stop with no linger | Does not leave the device open | Verified — `a_cold_start_does_not_leave_the_device_open_at_stop` |
| 17 | Cold start with a linger configured | Stays open for exactly that window | Verified — `a_cold_start_stays_open_only_when_a_linger_was_configured` |
| 18 | Cold start after a warm one | Prepends nothing from the shared ring; no audio appears in two recordings | Verified — `a_cold_start_prepends_nothing_from_the_shared_ring` |
| 19 | A press arrives while a recording is running | Not handed to the warm open; the open declines instead of stealing the device | Verified — `a_running_recording_is_never_handed_to_a_warm_open` |
| 20 | Stop, then start inside the linger window | The stream from the finished recording is adopted, not reopened | Verified — `stopping_hands_the_stream_back_to_the_preroll` |
| 21 | The hold is turned off | Device released, and the user's stored window is untouched; this process's copy returns to zero and the front end restates it on mount | Verified — `turning_the_hold_off_releases_the_device`, `releasing_the_hold_leaves_the_post_recording_window_alone` |
| 22 | A hold is set, then the policy changes to one that rejects the open stream | The stream is closed rather than kept under the old policy | Verified — `setting_the_linger_still_closes_a_stream_the_new_policy_rejects` |
| 23 | The preferred device changes while held | Closes and reopens on the new device; the hold is not silently dropped | Verified — `changing_the_preferred_device_keeps_a_held_microphone_held` |
| 24 | A stream that has delivered nothing | Not ready; the press records cold rather than recording silence | Verified — `a_stream_that_never_delivered_is_not_ready` |
| 25 | A stream that delivered and then went quiet | Reads as stale after the silence window | Verified — `a_stream_that_went_quiet_reads_as_stale` |
| 26 | A paused stream | Does not read as dead, and is not reopened | Verified — `a_paused_stream_does_not_read_as_dead` |
| 27 | A stopped stream | Does not read as dead | Verified — `a_stopped_stream_does_not_read_as_dead` |
| 28 | A stream stopped while paused | Resumed before being left warm, so the next press does not adopt a stream that delivers nothing | Inspected — the resume happens in the stop path; no test covers the paused-then-stopped sequence |
| 29 | The startup trace is missing | `Microphone last start: none` rather than a fabricated summary | Verified — `a_start_with_no_trace_has_no_summary` |
| 30 | Startup trace stages | Every stage a reader expects is marked, in order | Verified — `a_cold_start_marks_the_stages_a_reader_expects` |
| 31 | The status line | Names readiness, policy, pre-roll and last start together | Verified — `a_status_line_names_the_policy_the_pre_roll_and_the_last_start` |

## Device selection

| # | Edge case | Correct behaviour | How checked |
| --- | --- | --- | --- |
| 32 | Two devices with the same name | Ordinal suffix so the list is not ambiguous | Verified — `repeated_names_get_an_ordinal_suffix`, `first_device_keeps_its_bare_name` |
| 33 | A preferred name that also matches a speaker or a low-quality input | Excluded from the candidates | Verified — `preferred_name_blocks_low_quality_keywords`, `preferred_name_requires_microphone_context` |
| 34 | Built-in microphone detection | Recognised by name across the platform namings; a device that merely mentions "microphone" is not built-in | Verified — `builtin_names_are_recognised_across_platforms` (macOS model names, Linux/portable namings, and four non-built-in devices that must not match) |
| 35 | A cached device that has since disappeared | Falls back to scoring rather than failing the press | Inspected — `try_cached_device` falls through, but no test simulates a vanished cached label |
| 36 | Changing the preference | Invalidates the device cache so the next press does not reuse the old device | Verified — `a_changed_preference_clears_the_device_cache` |
| 37 | No input device on any host | Reported as unavailable, not as a stream error | Inspected — `prepare_device` returns `InputDeviceUnavailable` when every host yields nothing; no test drives the zero-device case, because a machine with no microphone is not available to test on |
| 38 | Several hosts, the first one failing | Later hosts are still tried; the failure of one is not fatal | Inspected — the loop continues on error, but no test drives two hosts |

## Failure classification

| # | Edge case | Correct behaviour | How checked |
| --- | --- | --- | --- |
| 39 | Another application holds the device (ALSA `EBUSY`) | Classified in-use, and the user is told which application class of problem it is | Verified — `alsa_busy_is_in_use_not_missing` (Rust), `names the other application when the device is busy` (UI) |
| 40 | Windows privacy switch off (`E_ACCESSDENIED`) | Classified permission, not "no input device" | Verified — `windows_privacy_switch_is_permission_not_missing` |
| 41 | Device unplugged | Classified unavailable; cpal's own wording matched, not a guess | Verified — `cpal_device_not_available_text_is_unavailable` |
| 42 | A message that matches two classes | Permission beats in-use, in-use beats unavailable, on both sides | Verified — `permission_wins_over_in_use_when_both_appear`, `keeps the precedence the Rust side documents` |
| 43 | An unrecognised message | `unknown`, with the generic text; no cause is invented | Verified — `unrecognised_text_is_unknown_not_guessed`, `falls back to the generic message for a failure it cannot identify` |
| 44 | The marker lists drift between Rust and TypeScript | Cannot ship: a test reads the Rust arrays and asserts both sides agree | Verified — `knows the same in-use markers as the Rust classifier`, `knows the same permission markers as the Rust classifier`, `knows the same unavailable markers as the Rust classifier` |
| 45 | The hold fails repeatedly | The user is told once, and again only after a success in between | Verified — `tells the user once when the hold cannot open, and does not repeat it` |
| 46 | Permission is denied | The snackbar points at system settings and no open is attempted | Verified — `points at the system settings when permission blocks the hold entirely` |

## Usage detection

| # | Edge case | Correct behaviour | How checked |
| --- | --- | --- | --- |
| 47 | Nothing is recording | `idle` — a measured answer, not "unknown" | Verified — `empty_listing_is_idle_not_unknown` |
| 48 | Another application is recording | Named, deduplicated, sorted | Verified — `two_applications_are_both_reported`, `duplicate_holders_are_collapsed` |
| 49 | A loopback monitor source is in use | Not counted as a microphone: playing audio must not report the mic as held | Verified — `monitor_sources_do_not_count_as_a_held_microphone` |
| 50 | This application's own keep-ready stream | Excluded; otherwise keep-ready accuses itself | Verified — `our_own_hold_is_not_another_application` |
| 51 | `pactl` is not installed | `unavailable:<reason>`, never `idle` | Verified — `a_probe_that_cannot_run_is_unavailable_not_idle` |
| 52 | `pactl` runs and exits non-zero | `unavailable:<reason>` with the exit status | Verified — `a_probe_that_fails_is_unavailable_not_idle` |

## What this table does not settle

Three things, stated plainly because a table of green rows invites the
assumption that everything is known.

1. **No test above touches a real microphone.** Every recording path is driven
   through a fake sink. A device that opens and delivers blocks is verified
   logically, not physically. What would settle it: run the app on a machine
   with an input device and read `[audio-startup]` lines from a real press.
2. **The busy-device classification has never seen a real busy device.** The
   markers come from cpal's vendored source and from documented platform error
   text, and the pairing test keeps the two languages in step, but no test on
   this machine has ever held a device open with one process and failed to open
   it with another. What would settle it: two processes and one microphone.
3. **The usage probe has never run against an audio server.** `pactl` is not
   installed here and there is no PulseAudio or PipeWire to answer. The parser
   and the subprocess handling are both covered, through a fake script, but the
   live path is not. What would settle it: `pactl list source-outputs` on a
   machine with a recording application.
