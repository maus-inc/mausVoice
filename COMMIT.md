# Commit messages

Every commit in this repository uses the same subject shape. The `commit-msg` hook in `lefthook.yml` rejects anything else, so reading this file once saves a failed commit.

## Subject

```
area: what changed
```

- Lowercase area, then a colon, then a space, then a summary of at least five characters.
- The summary describes the change, not the activity. `transcription: stop replaying an aborted request` is a commit. `transcription: fix stuff` is not.
- One concern per commit. If the summary needs the word "and", split the commit.
- No trailing full stop. No ticket number in the subject.
- Aim for 72 characters or less.

## Areas

Use the area that owns the file you touched.

| Area            | Scope                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `desktop`       | `apps/desktop` renderer code, actions, repos, state, components                                                 |
| `tauri`         | `apps/desktop/src-tauri` commands, state, database, sidecars                                                    |
| `transcription` | `packages/rust_transcription`, models, audio pipeline                                                           |
| `voice-ai`      | `packages/voice-ai`, provider adapters, prompts, output routing                                                 |
| `agent`         | `packages/agent`                                                                                                |
| `pill`          | `packages/rust_gtk_pill`, `packages/rust_macos_pill`, `packages/rust_windows_pill`, `packages/rust_pill_shared` |
| `bindings`      | `pnpm gen:bindings` output in `packages/desktop-native-apis`                                                    |
| `preview`       | `apps/preview`, specs, demo pages                                                                               |
| `docs`          | `apps/docs`, `docs/`, `README.md`, `AGENTS.md`, `CONTRIBUTING.md`                                               |
| `i18n`          | locale catalogs and extracted messages                                                                          |
| `ci`            | `.github/workflows`, `scripts/ci`                                                                               |
| `release`       | version bumps, release notes, installer, cask                                                                   |
| `deps`          | lockfile and dependency bumps                                                                                   |
| `repo`          | everything else, including tooling and root config                                                              |

## Conventional prefixes

The hook also accepts `feat`, `fix`, `chore`, `docs`, `ci`, `refactor`, `test`, `perf`, `build`, `style`, `security`, and `release`, with an optional scope, for example `fix(transcription): close the sidecar on abort`. Prefer a plain area. Reach for a type prefix only when the change is genuinely cross-cutting.

## Body

- Explain why the change is needed and what the previous behaviour did wrong.
- Describe the verification you ran when it is not obvious from the diff.
- Write `Closes #N` only when the number is real. Never invent one.
- Co-author lines must carry the real name and email of the human in the loop. Never guess one.

## Trailers

```
Co-authored-by: Real Name <real.email@example.com>
Refs: #N
```

## What the hook allows

The `commit-msg` job in `lefthook.yml` accepts:

1. `area: summary` with at least five characters after the colon.
2. `type(scope): summary` for the conventional types above.
3. A subject starting with `Merge `, which GitHub writes on its own.

Everything else fails the commit with the expected shape printed, so the fix is a retype rather than a hunt.

## Turn the template on

```bash
git config commit.template .gitmessage
git config core.hooksPath .   # only if you want lefthook's hooks from the repo root
lefthook install              # after npm install -g lefthook or npx lefthook install
```

`.gitmessage` is the commented template git will show in your editor. Leaving the comments in the editor keeps them out of the message, because git strips lines that start with `#`.
