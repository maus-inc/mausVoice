# Edge cases for the warm microphone, and how each one is checked

Sixty-six classes of edge case, grouped by the thing they stress. Each row names
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
| 28 | A stream stopped while paused | Resumed before being left warm, so the next press does not adopt a stream that delivers nothing | Verified — `a_stopped_stream_says_whether_it_was_paused_before_it_forgot`, `a_stop_after_a_resume_does_not_claim_the_stream_was_paused`. The resume decision was **wrong** before this row was deepened: the stop cleared the pause flag and the stop path then asked the sink, so it was always told "not paused" and never resumed. The pause now travels back with the stop, and the two tests hold that. The resume itself still needs a real stream — see the note below |
| 29 | The startup trace is missing | `Microphone last start: none` rather than a fabricated summary | Verified — `a_start_with_no_trace_has_no_summary` |
| 30 | Startup trace stages | Every stage a reader expects is marked, in order | Verified — `a_cold_start_marks_the_stages_a_reader_expects` |
| 31 | The status line | Names readiness, policy, pre-roll and last start together | Verified — `a_status_line_names_the_policy_the_pre_roll_and_the_last_start` |

## Device selection

| # | Edge case | Correct behaviour | How checked |
| --- | --- | --- | --- |
| 32 | Two devices with the same name | Ordinal suffix so the list is not ambiguous | Verified — `repeated_names_get_an_ordinal_suffix`, `first_device_keeps_its_bare_name` |
| 33 | A preferred name that also matches a speaker or a low-quality input | Excluded from the candidates | Verified — `preferred_name_blocks_low_quality_keywords`, `preferred_name_requires_microphone_context` |
| 34 | Built-in microphone detection | Recognised by name across the platform namings; a device that merely mentions "microphone" is not built-in | Verified — `builtin_names_are_recognised_across_platforms` (macOS model names, Linux/portable namings, and four non-built-in devices that must not match) |
| 35 | A cached device that has since disappeared | Falls back to scoring rather than failing the press | Verified — `a_cached_device_that_is_no_longer_listed_falls_through_to_scoring`, `a_cached_device_that_is_still_listed_is_tried`, `an_empty_cache_has_nothing_to_try` |
| 36 | Changing the preference | Invalidates the device cache so the next press does not reuse the old device | Verified — `a_changed_preference_clears_the_device_cache` |
| 37 | No input device on any host | Reported as unavailable, not as a stream error | Verified — `no_host_yielding_a_device_is_reported_as_no_device` |
| 38 | Several hosts, the first one failing | Later hosts are still tried; the failure of one is not fatal | Verified — `the_second_host_is_tried_when_the_first_one_fails`, `a_host_that_will_not_load_is_skipped_rather_than_fatal`, `a_host_listed_twice_is_only_tried_once`, `the_default_host_is_tried_first` |

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

## A stream that dies mid-recording

The host reports stream errors asynchronously, through a callback cpal calls on a
thread of its own choosing. Before these rows existed that callback only logged:
a device unplugged mid-dictation produced a short recording, no error, and a
successful-looking result. The classification of those messages is
`platform/stream_fault.rs`.

| # | Edge case | Correct behaviour | How checked |
| --- | --- | --- | --- |
| 53 | ALSA reports a spurious `poll()` timeout | Not fatal: the host keeps polling, and retiring on this rebuilds the stream several times a second and captures nothing | Verified — `an_alsa_poll_timeout_does_not_retire_the_stream`, `the_message_as_cpal_renders_it_is_what_is_matched` |
| 54 | The device is unplugged mid-recording | The stream is marked dead, never handed to a later press, and the recording reports the fault | Verified — `a_fatal_fault_is_recorded_and_named`, `a_faulted_stream_is_never_usable_however_recently_it_delivered` |
| 55 | A stream that faulted still sits in the warm slot | Rejected for the next press even though it delivered a block moments ago; the reason named in the log is the fault, not staleness | Verified — `a_faulted_stream_is_rejected_for_a_press_naming_the_fault` |
| 56 | An unrecognised error message | Treated as fatal, the opposite of the open-failure classifier: a wrong "transient" leaves a dead stream recording silence | Verified — `an_unrecognised_message_is_fatal_not_transient` |
| 57 | An error that repeats hundreds of times a second | The first few are logged in full, the rest only counted, and the recorded fault is unchanged | Verified — `an_error_storm_does_not_change_the_fault_it_records` |
| 58 | Errors arriving after the first fatal one | The first token wins; a second error from an already-dead backend does not overwrite when it died | Verified — `the_first_fatal_fault_wins` |
| 59 | The capture dies but the host says nothing | Logged as captured-vs-expected milliseconds when the shortfall is material; `duration` stays what was captured and `expected_duration` what was expected | Verified — `a_recording_that_lost_a_tenth_of_its_length_is_suspicious`, `a_gap_under_the_tolerance_is_not_suspicious`, `captured_audio_longer_than_the_wall_clock_is_not_a_gap` |
| 60 | A recording paused for part of its length | The pause is subtracted from `expected_duration`, so a paused dictation is not reported as a capture that died | Verified — `a_paused_recording_does_not_pause_time_count_against_capture`, `a_new_recording_starts_with_no_paused_time` |
| 61 | Two pauses, or a pause resumed twice | The interval is counted once and a repeat call does not restart the clock | Verified — `a_second_pause_does_not_restart_the_first_interval`, `resuming_twice_counts_the_pause_once` |
| 62 | A faulted stream is restarted | The fault survives the restart: the device is gone, not just the recording | Verified — `a_fault_token_survives_a_restart_of_the_recording` |
| 63 | A recording that faulted ends with the hold turned on | The dead stream is **not** left warm: it can never serve a press, and holding it keeps the microphone indicator on for a device that cannot record. The next press opens a working one | Inspected — the decision is one line in the stop path and has no separate rule to test; the outcome it prevents (adopting a faulted stream) is row 55, which is tested. Settling this needs a real stream, because closing one requires one |
| 64 | A faulted recording reaches the user | The stop body carries the fault and both lengths, and the user is told the microphone stopped after N of M seconds instead of being left to blame the app for a short transcript; a fault that lost no audio is not reported at all | Verified — `reports the fault and both lengths`, `keeps every sample and none of the trailer as audio`, `says nothing for a recording that did not fault`, `does not claim a loss when the whole recording was delivered` (TS), `a_faulted_recording_carries_its_lengths_and_a_flag`, `a_trailer_round_trips_to_the_audio_and_the_two_lengths`, `the_faulted_body_is_exactly_these_bytes`, `a_fault_that_lost_no_audio_is_not_reported` (Rust), `decodes the bytes the Rust encoder actually produces` (TS) |
| 65 | An ordinary recording, after the trailer was added | Byte-for-byte the old framing: no trailer, no decode branch, every sample intact, and no fault reported even when the final sample's bit pattern would have looked like a marker to a decoder that guessed | Verified — `a_healthy_recording_is_byte_for_byte_the_old_framing`, `audio_that_happens_to_look_like_a_flag_is_not_a_trailer`, `a_trailer_missing_its_flag_is_left_as_audio` (Rust), `leaves an ordinary recording with no trailer and no fault`, `does not mistake ordinary audio for a trailer`, `never misreads a long healthy recording, whatever its last sample`, `keeps the audio when a magic arrives without its flag` (TS) |
| 66 | A faulted body with no expected length, or lengths that contradict each other | The wording without figures rather than "0.0 of 0.0 seconds", `expected` never below `captured`, and a fault that lost nothing produces no message at all | Verified — `falls back to a message with no numbers when none were reported`, `never reports less expected time than captured`, `does not claim a loss when the whole recording was delivered` |

| 67 | A press and a warm open arriving together | Neither can wait on a lock the other holds: the two calls deadlock and the whole capture path stops, with the microphone indicator on and no way to record | Verified — `a_press_and_a_warm_open_cannot_deadlock_on_each_others_locks`, which drives both calls on two threads and fails on a timeout rather than on a wrong value. It failed exactly that way before the lock order was fixed |
| 68 | A press that lost audio after a warm start | The pre-press audio seeded into the buffer is not counted as delivered, so a stream that died two seconds in is still reported as a short recording rather than a complete one | Verified — `captured_duration_excludes_the_audio_recorded_before_the_press`, `a_seeded_recording_that_captured_nothing_has_no_sample_duration`, `the_preroll_seed_cannot_mask_a_lost_capture` |
| 69 | The first press after a cold start, with a hold configured | It starts with the pre-roll the cold recording collected. Before the callback kept a ring while recording, this press began with nothing and the setting silently did nothing for anyone who had never turned on keep-ready | Verified — `a_recording_fills_the_ring_that_becomes_the_next_presses_preroll` |
| 70 | A linger timer armed before a release, firing after the next hold | Does not close the stream the user is now holding; the generation is read under the same lock the close takes | Verified — `a_stale_linger_cannot_close_a_stream_opened_after_it_was_armed`, `a_current_linger_does_close_the_stream_it_was_armed_for` |
| 71 | A recording starting while a stream is held | The held device is left alone. Releasing it closed the stream the press had just adopted and zeroed the window the stop path reads, so every dictation paid the device open keep-ready exists to avoid | Verified — `leaves the held device alone when a recording starts` (TS) |
| 72 | The process exiting with a held stream that never delivered | The device is still released. Asking readiness skipped exactly this stream, which holds the device with the indicator lit; the structural question is now a separate call | Inspected — the decision is one branch in the exit path and needs a live stream to exercise; the two questions it distinguishes are separately tested (`a_stream_that_never_delivered_is_not_ready`) |
| 73 | The PulseAudio backend's read failing mid-recording | Reports the fault rather than returning a result indistinguishable from a clean stop | Inspected — this backend is not built on a macOS or Windows runner and has no host error callback; the token and its front-end treatment are the same ones rows 63 and 64 cover |

## What this table does not settle

Five things, stated plainly because a table of green rows invites the
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
4. **The mid-recording fault path has never seen a device die.** The
   classification is tested against cpal's own wording, read from the vendored
   0.15.3 source, and the sink's fault state is driven directly. What is not
   tested is the whole chain on hardware: no test here has unplugged a
   microphone during a recording and read the resulting metrics. It is also
   untested whether the host's error callback arrives before the stop in every
   backend — if it arrives after, the fault lands on the *next* recording's
   stream rather than this one's metrics. What would settle it: unplug a USB
   microphone mid-dictation and read the warn line that begins with "capture
   reported" and the returned `duration` / `expected_duration`.
5. **Two rows are held by a narrower test than the row describes.** Row 28's
   resume and row 55's rejection are decided from data the sink holds, and both
   the data and the decision are tested, but the call that acts on them needs a
   live `cpal::Stream`. The gap is the call, not the rule.
