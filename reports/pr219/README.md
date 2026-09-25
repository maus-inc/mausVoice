# PR 219 evidence

This folder answers the review request for before and after evidence on PR 219. It compares the PR base (`d1f06ec`, what v0.1.6 ships) with this branch on fixed fixtures, using the real code from both commits. It does not contain recorded audio or live provider output; see "What this does not show" for why and what that leaves open.

- `harness/evidence.ts` runs every fixture through the base and branch code. `harness/build.mjs` bundles it so that `old:` imports load the base commit's files (and their whole relative import graph) through `git show`, and `new:` imports load the working tree.
- `evidence.generated.md` holds the tables and `evidence.json` holds every input and output.

Regenerate from the repository root:

```sh
node reports/pr219/harness/build.mjs
node node_modules/.cache/pr219-evidence.mjs
```

`reports/` is listed in `.prettierignore`, so these files are not formatted or checked by Prettier.

## Findings

<details>
<summary>Spoken commands: 19 of 23 ordinary sentences were rewritten by the base, none by the branch</summary>

The base turns any "period", "comma", "colon", "new line", or "scratch that" into formatting, so "The billing period ends on Friday." became "The billing. ends on Friday." and "Let's scratch that idea and start over." lost everything before "idea". The branch keeps all 23 literal and still applies 11 of 12 intended commands.

The one miss is deliberate: "hello period how are you", said with no pause, now stays literal because a lowercase word straight after "period" is read as the noun. A pause usually gives the transcript a comma or a capital, and then the command applies ("hello period, how are you" becomes "hello. how are you").

</details>

<details>
<summary>Segment silence gate: recovers speech, and admits confident hallucinations that are not on the phrase list</summary>

This is the trade-off the review asked to have measured. The fixtures are hand-written segments, not provider recordings, so the counts show which cases change, not how often each case happens in real use.

- Speech in a window Whisper scored as mostly silent, but decoded confidently: the base drops all 3 cases, the branch keeps all 3.
- Canonical hallucinations decoded confidently ("Thank you for watching!", the Amara subtitle credit): both pass the new gate and are removed by the known-phrase filter, so the user sees nothing, as before.
- Confident hallucinations that are not on the list ("I'll see you in the next video.", "Thanks."): the base drops them, the branch shows them. These are the new failure mode.
- Low-confidence decodes of silence, and providers that send no `avg_logprob`: unchanged, still dropped.

The branch matches Whisper's reference decoder, which skips a window only when `no_speech_prob > 0.6` and `avg_logprob <= -1.0`. Losing real speech cannot be undone by the user, while a stray "Thanks." is visible and easy to delete, so the branch accepts the second risk to remove the first.

</details>

<details>
<summary>Post-processing replies: a cut-off reply no longer pastes a shortened transcript</summary>

For a 46-word dictation, a reply cut off at 60% made the base paste 26 words and one cut off at 90% pasted 43, with no warning. The base's repair step closed the JSON at the last complete word. The branch pastes the full raw transcript and shows a warning that names token-limit truncation, including for a fenced reply cut off before its closing fence.

</details>

<details>
<summary>Output-token budget: 600 for every request before, 2,048 to 8,192 now</summary>

v0.1.5 sent no limit, so providers used their own defaults (1,024 on the self-hosted OpenAI-compatible path). v0.1.6 capped every request at 600, which a reasoning model can spend before writing any answer. The branch sizes the budget from the transcript: 1,024 tokens of reasoning room plus three times the estimated transcript tokens, clamped to 2,048 to 8,192. The cap is a ceiling, not a charge: providers bill the tokens they actually generate. The cost that does rise with the floor is rate-limit headroom, because some providers count the requested cap against a per-minute token limit.

</details>

<details>
<summary>Local RMS gate: quiet speech inside a long clip is no longer skipped</summary>

This table uses a JavaScript port of the base and branch versions of `is_near_silent`, because Rust cannot be built in the environment that produced this report. The Rust unit tests in `packages/rust_transcription/src/transcription.rs` assert the same cases on the real function in CI.

The base averaged energy over the whole clip, so 0.5 s of quiet speech at the end of 20 s, or 1 s of soft speech in 30 s, was skipped as silence. The branch looks at 300 ms windows, so both now reach the model. Room tone alone is still skipped. A single 10 ms click in room tone is now sent to the model too; the segment gate and phrase filter then apply as for any other clip.

</details>

<details>
<summary>Non-speech token suppression: what `suppress_nst(true)` banned</summary>

v0.1.5 did not set this option. v0.1.6 turned it on; the branch turns it off again, which is whisper.cpp's default. With it on, whisper.cpp sets these tokens (and each with a leading space) to negative infinity at every decoding step, plus a leading-space `-` and `'`. List from `src/whisper.cpp` in whisper.cpp 1.9.1:

```
" # ( ) * + / : ; < = > @ [ \ ] ^ _ ` { | } ~ 「 」 『 』
<< >> <<< >>> -- --- -( -[ (' (" (( )) ((( ))) [[ ]] {{ }}
♪♪ ♪♪♪ ♩ ♪ ♫ ♬ ♭ ♮ ♯
```

Any dictation whose correct transcript uses one of those tokens loses it or gets a substitute: times ("10:30"), email addresses ("@"), paths and URLs ("/"), quotes, parentheses, and plus or equals signs. The pinned `whisper-rs-sys` 0.14.1 vendors its own whisper.cpp build; the list has been stable across recent releases, but it was read from 1.9.1 and not from the vendored copy.

No test asserts the flag, because `whisper-rs` exposes no getter for it and asserting a decode needs model weights.

</details>

## What this does not show

The review asked for reference recordings per provider and model, with the base and branch transcript for each and counts of speech recovered against hallucinations admitted. That was not possible here:

- No Whisper weights could be downloaded (Hugging Face, the OpenAI CDN, and GitHub release assets are blocked), so the local engines could not be run.
- There are no provider API keys in this environment, so Groq, OpenAI, and the other cloud paths could not be called.
- There is no Rust toolchain, so the Rust changes are checked only by CI.

The fixtures above show exactly which inputs change behaviour and in which direction. They cannot show how often those inputs occur. A before and after run over real recordings on each provider is still the right follow-up, and the harness can take recorded provider responses as fixtures without changes to the code under test.
