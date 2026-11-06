#!/usr/bin/env bash
# Runs the `#[ignore = "requires an isolated ALSA null ..."]` tests in the
# desktop crate against an injected ALSA null device.
#
# Those tests exist to prove the recorder's ownership rules survive failed
# open, start, stop, pause, resume, uncertain close, disconnect, XRUN and short
# or stalled reads. They are `#[ignore]`d because they need two things a plain
# `cargo test --lib` cannot give them: an ALSA device to talk to, and an
# `LD_PRELOAD` shim that makes the driver fail on purpose. Nothing wired them
# up, so for a while the fixtures in
# `apps/desktop/src-tauri/tests/fixtures/` were referenced only by a paragraph
# in `patches/cpal-0.15.3/PATCH.md`. This script is that wiring: one row per
# test, naming the fixture and any environment the fixture reads.
#
# Every row runs in its own process. A preload interposes process-wide symbols,
# and an armed fault is one-shot state inside the shim, so two tests sharing a
# process would arm each other.
#
# Usage:
#   scripts/ci/run-alsa-fault-tests.sh              # every row
#   scripts/ci/run-alsa-fault-tests.sh overrun      # rows whose test name matches
#
# Environment:
#   MAUS_ALSA_FAULT_WORKDIR  keep build output here instead of a temp dir
#   MAUS_ALSA_FAULT_CARGO    cargo binary (default: cargo)
#   MAUS_ALSA_FAULT_CC       C compiler (default: cc)
#
# The build is `--locked`: CI must test the committed manifest, and a lockfile
# that has drifted is a failure this script should surface rather than repair.
#
# Linux only. The desktop crate's ALSA tests are gated on `target_os = "linux"`,
# and the shims interpose `snd_*` symbols that only libasound exports.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
desktop_crate="$repo_root/apps/desktop/src-tauri"
fixture_dir="$desktop_crate/tests/fixtures"
cargo_bin=${MAUS_ALSA_FAULT_CARGO:-cargo}
cc_bin=${MAUS_ALSA_FAULT_CC:-cc}
test_module="platform::audio::cpal_impl::tests"

# Rows are `fixture|env assignments|test name`. `-` means no preload: the test
# only needs the null device. The env column is read by the fixture, not by the
# test, so it has to be set here rather than in the Rust test body.
rows=(
  # Pure null-device tests.
  "-||cpal_worker_captures_and_hands_off_on_an_alsa_null_device"
  "-||cpal_alsa_pause_suppresses_samples_until_resume"
  "-||cpal_alsa_input_waits_for_play_and_can_be_dropped_unstarted"
  "-||cpal_alsa_playback_uses_aligned_sample_buffers"
  # Open, build and close faults.
  "alsa_open_failure||cpal_alsa_uncertain_probe_open_blocks_capture"
  "alsa_open_failure||cpal_alsa_uncertain_stream_open_blocks_capture"
  "alsa_probe_close_failure||cpal_alsa_uncertain_probe_blocks_successor_capture"
  "alsa_probe_close_failure||cpal_alsa_capture_build_waits_for_probe_close"
  "alsa_probe_close_failure||cpal_alsa_discovery_during_recording_leaves_capture_running"
  "alsa_build_failure||cpal_alsa_build_failure_distinguishes_confirmed_close"
  "alsa_build_failure||cpal_alsa_uncertain_build_close_blocks_successor_capture"
  "alsa_build_failure||cpal_alsa_uncertain_cached_build_close_blocks_successor_capture"
  "alsa_close_failure||cpal_alsa_failed_close_never_reuses_the_uncertain_handle"
  # Start, stop, pause and resume faults.
  "alsa_start_failure||cpal_alsa_failed_start_retains_an_uncertain_active_device"
  "alsa_stop_failure||cpal_alsa_failed_stop_retains_ownership_until_retry_succeeds"
  "alsa_pause_failure||cpal_alsa_unsupported_pause_keeps_recording"
  "alsa_pause_failure||cpal_alsa_failed_pause_marks_partial_capture"
  "alsa_pause_failure||cpal_alsa_failed_resume_marks_partial_capture"
  # Capture read faults.
  "alsa_short_read||cpal_alsa_delivers_only_frames_returned_by_a_short_read"
  "alsa_short_read|MAUS_TEST_READ_STALL=eagain|cpal_alsa_stalled_read_is_interruptible"
  "alsa_short_read|MAUS_TEST_READ_STALL=zero|cpal_alsa_zero_read_is_interruptible"
  "alsa_xrun||cpal_alsa_overrun_marks_the_captured_prefix_incomplete"
  "alsa_poll_xrun||cpal_alsa_pollerr_overrun_is_reported_and_prepared"
  "alsa_read_xrun||cpal_alsa_read_overrun_restarts_and_reports_loss"
  "alsa_disconnect||cpal_alsa_capture_disconnect_stops_worker"
  "alsa_disconnect||cpal_alsa_disconnect_preserves_incomplete_recording"
  "alsa_disconnect|MAUS_TEST_DISCONNECTED_STATE=1|cpal_alsa_capture_disconnected_state_stops_worker"
  # Capture callback delay and the stale poll that follows a resume.
  "alsa_delayed_callback||cpal_alsa_pause_drains_a_read_before_its_callback"
  "alsa_stale_poll||cpal_alsa_stale_poll_xrun_does_not_restart_after_resume"
  # Playback write faults.
  "alsa_short_write||cpal_alsa_partial_playback_preserves_unwritten_frames"
  "alsa_short_write||cpal_alsa_playback_recovers_xrun_after_partial_write"
  "alsa_short_write|MAUS_TEST_WRITE_ALWAYS_EAGAIN=1|cpal_alsa_playback_drop_interrupts_retry"
  "alsa_short_write|MAUS_TEST_WRITE_FATAL=1|cpal_alsa_playback_coalesces_persistent_errors"
)

# Two of the shims interpose `snd_pcm_poll_descriptors_revents` and
# `snd_pcm_readi`/`snd_pcm_writei`; tests that need the POLLHUP path and the
# disconnect path share `alsa_disconnect`, which is why the same fixture appears
# twice above with different environment.
if [[ ${#rows[@]} -eq 0 ]]; then
  echo "run-alsa-fault-tests: no rows defined" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "run-alsa-fault-tests: Linux only (found $(uname -s))" >&2
  exit 1
fi

for tool in "$cc_bin" "$cargo_bin"; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "run-alsa-fault-tests: $tool is not on PATH" >&2
    exit 1
  fi
done

workdir=${MAUS_ALSA_FAULT_WORKDIR:-}
if [[ -z "$workdir" ]]; then
  workdir=$(mktemp -d)
  trap 'rm -rf "$workdir"' EXIT
else
  mkdir -p "$workdir"
fi

# A null PCM answers capture and playback without a kernel device, which is what
# keeps these tests off a real microphone. `ALSA_CONFIG_PATH` replaces the
# system configuration entirely, so the run cannot fall back to the machine's
# own card.
cat >"$workdir/asound.conf" <<'CONFIG'
pcm.!default {
    type null
}
ctl.!default {
    type null
}
CONFIG

shims="$workdir/shims"
mkdir -p "$shims"

# One .so per fixture, built once and preloaded per row.
declare -A built=()
for row in "${rows[@]}"; do
  fixture=${row%%|*}
  [[ "$fixture" == "-" ]] && continue
  [[ -n "${built[$fixture]:-}" ]] && continue
  source="$fixture_dir/$fixture.c"
  if [[ ! -f "$source" ]]; then
    echo "run-alsa-fault-tests: missing fixture $source" >&2
    exit 1
  fi
  "$cc_bin" -std=c11 -shared -fPIC -O1 -o "$shims/$fixture.so" "$source" -ldl
  built[$fixture]=1
done

export ALSA_CONFIG_PATH="$workdir/asound.conf"
# Build once with no preload in the environment: a shim must never be loaded
# into `rustc` or a build script, only into the test binary. The binary is then
# run directly, because a `cargo test` per row re-resolves the whole workspace
# for every one of them -- 32 rows took 19 minutes that way.
# `CARGO_TARGET_DIR` is deliberately left alone: CI has already built this
# crate for the unit-test step, and pointing the build somewhere fresh would
# rebuild every dependency for one extra invocation.
artifacts=$(cd "$desktop_crate" && "$cargo_bin" test --locked --lib --no-run --message-format=json)
test_binary=$(printf '%s\n' "$artifacts" \
  | grep -o '"executable":"[^"]*"' \
  | sed 's/^"executable":"//; s/"$//' \
  | grep -v '^null$' \
  | tail -n 1)
if [[ -z "$test_binary" || ! -x "$test_binary" ]]; then
  echo "run-alsa-fault-tests: cargo produced no test binary" >&2
  printf '%s\n' "$artifacts" | tail -n 20 >&2
  exit 1
fi

filter=${1:-}
passed=0
failed=()
skipped=0

for row in "${rows[@]}"; do
  fixture=${row%%|*}
  rest=${row#*|}
  env_spec=${rest%%|*}
  test=${rest#*|}

  if [[ -n "$filter" && "$test" != *"$filter"* ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  preload=""
  if [[ "$fixture" != "-" ]]; then
    preload="$shims/$fixture.so"
  fi

  echo "::group::$test${preload:+ (preload ${fixture}.so)}"
  status=0
  (
    # The fixture reads these; they are not visible to the Rust test body.
    if [[ -n "$env_spec" ]]; then
      # shellcheck disable=SC2086
      export $env_spec
    fi
    if [[ -n "$preload" ]]; then
      LD_PRELOAD="$preload" "$test_binary" --exact --ignored \
        --test-threads=1 "$test_module::$test"
    else
      "$test_binary" --exact --ignored --test-threads=1 "$test_module::$test"
    fi
  ) || status=$?
  echo "::endgroup::"

  if [[ $status -ne 0 ]]; then
    failed+=("$test")
  else
    passed=$((passed + 1))
  fi
done

echo
echo "run-alsa-fault-tests: $passed passed, ${#failed[@]} failed, $skipped filtered out"
if [[ ${#failed[@]} -gt 0 ]]; then
  for test in "${failed[@]}"; do
    echo "  FAILED $test"
  done
  exit 1
fi
