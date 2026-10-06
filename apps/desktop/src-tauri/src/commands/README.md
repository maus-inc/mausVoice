# Tauri commands

`commands.rs` holds every `#[tauri::command]` in the app. It is a single file by design, so a reader looking for a command can grep one path rather than hunt a module tree. It is large; that is a known cost, not a recommendation.

## Shape of a command

```rust
#[tauri::command]
#[specta::specta]
pub async fn some_thing(
    window: tauri::WebviewWindow,
    value: String,
) -> Result<Out, String> {
    // ...
    Ok(Out { .. })
}
```

Five rules, all of them load-bearing.

**Return `Result<T, String>`.** A `Result` whose error is a string is what the generated TypeScript binding sees as `Promise<T>` throwing with that string. Anything else produces a rejection whose message names a type rather than a cause. Never panic on user input: a panic in a command is a dead task, and the frontend sees a bare "task failed" with no reason.

**Take the window when the command should be scoped to a caller.** `tauri::WebviewWindow` implements `CommandArg`, so Tauri hands the invoking window without the frontend passing anything. Use it and check `window.label()`. See `require_computer_use_window` for the worked example.

**`spawn_blocking` for anything slow.** A capture or a drag can run for tens of milliseconds; a typing burst for seconds. Blocking the async runtime on either starves every other command in the app. Wrap the blocking call and await the join handle, then flatten its `Result<Result<T, String>, JoinError>` into one `Result<T, String>` with a message that says which command's task failed. A single `rdev::simulate` call posts one event and returns, so the single-input commands stay inline; `computer_use_drag` is the exception on the input side because an interpolated drag moves the pointer many times.

**Parse and validate before you spawn.** A command that parses its arguments into an enum first, then dispatches, cannot half-apply a request it later rejects. `computer_use_key_gesture` is the pattern: it turns "repeat 3 times" and "hold 2 seconds" into one enum so the two mutually exclusive forms cannot both be present, and an unparseable key chord is refused before any thread exists.

**Log at the boundary, not the payload.** `log::debug!` and `log::info!` are fine. Never log an API key, a token, or a full command line the user typed. Screen coordinates are safe and worth logging, because a coordinate mistake is silent otherwise.

## What is here

Around 150 commands. They fall into five groups.

| Group | Examples |
| --- | --- |
| Window and pill | `surface_main_window`, `set_pill_visibility`, `request_pill_position`, `reset_pill_position` |
| Recording and input | `start_recording`, `stop_recording`, `simulate_type`, `cancel_typing` |
| Native integration | `get_monitor_at_cursor`, `get_screen_context`, `run_terminal_command` |
| Settings and persistence | `set_phase`, preference reads and writes |
| Computer use | `list_displays`, `capture_screen`, `capture_screen_region`, and the fourteen `computer_use_*` commands |

The full list is the `invoke_handler` array in `app.rs`, which is also the single source of truth for what is actually exposed. A command defined here but absent from `invoke_handler` is dead code that still compiles.

## Computer use

These exist because a vision-capable model can act on a screen, not just describe one. Every coordinate in and out of this group is a **physical pixel** in desktop space, never a logical or CSS pixel, because the models that emit these coordinates were shown an image and reason in image pixels. A DPI-scaling bug here clicks the wrong thing with no error, so the conversion helpers in `platform/computer_use/` log the transformation they apply.

| Command | What it does |
| --- | --- |
| `list_displays` | Every display's id, origin, pixel size, and scale factor |
| `capture_screen` | One display as JPEG at 1280px wide by default, or PNG |
| `capture_screen_region` | A region at native density, for zooming into small text |
| `computer_use_pointer_position` | Where the pointer is, in physical pixels |
| `computer_use_move` | Move the pointer |
| `computer_use_click` | Left, middle, or right; one, two, or three times; with modifiers |
| `computer_use_press_button` / `computer_use_release_button` | Split press and release, for drag and for menus that open on press |
| `computer_use_drag` | Press at one point, move, release at another, always releasing |
| `computer_use_scroll` | Up, down, left, or right, by a pixel distance |
| `computer_use_press_key` | A chord, tapped, repeated, or held |
| `computer_use_press_key_down` / `computer_use_release_key_up` | Split so a chord can span two turns |
| `computer_use_type` | Text into the focused field, through the existing typing path |
| `computer_use_wait` | A bounded pause the model asked for, cancellable |
| `computer_use_cancel` / `computer_use_reset_cancel` | Stop an in-flight long action, then re-arm for the next run |

Three properties are deliberate and worth preserving.

**Cancellation is a flag, not a channel.** `INPUT_CANCELLED` is polled in 20ms slices. A channel would need a receiver on every long path and would still not interrupt a call already inside the OS. The separate cancel and reset commands exist so a cancel that lands after the work finished cannot disarm the next run.

**Mouse releases are unconditional.** A drag that fails between press and release would otherwise leave the button held, which breaks the user's next click. Every mouse release runs on the way out, success or failure. Same for chords, released in reverse order.

A chord *press* is not yet unconditional: `press_chord` returns on the first `simulate` failure, so an OS that accepts `ctrl` and refuses the next key would leave the modifier down. `cancel_input` and `reset_input_cancel` release everything recorded in `HELD_INPUT`, which is what recovers it, and that is the whole recovery path today.

**Wayland capture is refused, not attempted.** On Wayland the X11 path cannot see the screen, and a portal integration is deferred. `capture_screen` returns an error naming the reason rather than returning a black frame or pretending.

## Adding one

1. Define it here, with `#[tauri::command]` and `#[specta::specta]`, returning `Result<T, String>`.
2. Add its name to `examples/gen_bindings.rs`, in the `collect_commands!` list. This list is explicit and alphabetical, and **a command missing from it is silently absent from the TypeScript bindings.** A green `pnpm gen:bindings` says nothing about this.
3. Register it in `app.rs`'s `invoke_handler`.
4. Run `pnpm gen:bindings` and commit the regenerated `packages/desktop-native-apis/src/bindings.ts`.
5. If it needs a plugin permission, add it to `capabilities/default.json` and mirror the host into `security.csp`'s `connect-src` in `tauri.conf.json` when it is a network permission. `capabilities/README.md` has the checklist.
6. Add a row to the table above if it belongs to a group the file already names.

CI runs `scripts/check-bindings.sh`, which fails if step 4 was skipped.