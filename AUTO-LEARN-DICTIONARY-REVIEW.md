# Investigation: automatic dictionary word addition (auto-learn)

Scope: the two "automatic dictionary word addition" features and their
interfaces. **Auto-learn dictionary** runs on corrections made in the History
details dialog. **Learn from corrections** runs on corrections made in the
target app after insertion. The review also covers everything downstream of
them: what a learned term actually does when the user dictates again.

Branch under review: `arena/01a08184-mausvoice`. The investigation describes
commit `f13ab95`. All findings were then fixed on this branch, checked in a
line-by-line review pass, and re-verified against each provider's
documentation. Section 8 records the fixes and section 9 records the review
pass.

## 1. Method and evidence levels

Same scale as `CORRECTIVE-REVIEW.md`:

| Level | Meaning                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------- |
| E1    | Code read in one place. Behaviour follows from reading.                                         |
| E2    | Whole path traced from trigger to effect.                                                       |
| E3    | Path traced and a test that ran confirmed it.                                                   |
| E4    | A probe test reproduced the defect. All probes were deleted afterwards.                         |
| E5    | Checked on a running desktop build. Not reached here. The environment has no microphone or GUI. |

What was done: MausAgent read every file in both flows end to end. That covers
actions, utils, settings UI, pill IPC in Rust, native pills for all three
platforms, provider repos in `packages/voice-ai`, the whisper sidecar prompt
handling, and the SQLite term persistence. The 109 existing unit tests
covering the area were run and pass. Five probe tests were written to check
suspected gaps. Three of them reproduced real defects, recorded in sections
4.1, 4.2 and 4.3. Provider vocabulary capabilities were checked against
Deepgram, AssemblyAI, ElevenLabs and Azure documentation, and every provider
limit used in code was re-verified in the review pass with the sources listed
in section 9.

## 2. How the feature is supposed to work

Intended behaviour, assembled from the settings copy, the docs and the
provider capabilities:

1. **Auto-learn dictionary** is on by default. The settings say: "When you
   correct a transcription, add the corrected names and words to your
   dictionary automatically." The user fixes a name in the History details
   dialog, and the fixed name becomes a glossary term.
2. **Learn from corrections** is off by default and exists on macOS and
   Windows only. The settings say: "After dictation, watch for corrections you
   make in the target app and offer to add the corrected names to your
   dictionary." A pill toast offers Add and Ignore.
3. **The learned term must then improve recognition.** That is the whole point
   of a dictionary in a dictation app. The docs describe step 4 of the
   pipeline as "Glossary context can help recognition where the provider
   supports it" in `apps/docs/.../dictation-workflow.md`, and the
   post-processing system prompt asserts: "When the user's glossary contains a
   term, prefer that exact spelling even if the raw transcript differs."

Reference points from the vendors whose STT APIs mausVoice integrates:

- Deepgram nova-3 supports keyterm prompting. A caller passes plain terms as
  repeated `keyterm=term1&keyterm=term2` query parameters on both the
  pre-recorded and streaming endpoints, with up to 100 keyterms per request.
  The legacy `keywords` feature with `:INTENSIFIER` weights is Nova-2 only.
  Source: developers.deepgram.com/docs/keyterm.
- AssemblyAI supports `word_boost` with up to 1,000 words in the batch API,
  and `keyterms_prompt` in the streaming v3 API with up to 100 terms of at
  most 50 characters each. Requests with more than 100 keyterms are rejected
  with an error. Source: assemblyai.com/docs, keyterms prompting pages.
- ElevenLabs Scribe v2, the model this repo hardcodes, supports `keyterms` as
  repeated form fields for batch and repeated query parameters for realtime.
  Batch accepts up to 1000 keyterms, each under 50 characters and at most 5
  words. Realtime is stricter: up to 50 keyterms of at most 20 characters
  each. Using keyterms adds a 20 percent surcharge, and going past 100
  keyterms in batch triggers a 20-second minimum billable duration per
  request. Source: elevenlabs.io/docs, speech-to-text keyterms pages, and
  the ElevenLabs changelog entry of 2026-04-27 that introduced realtime
  keyterms.
- Azure Speech supports phrase lists for realtime transcription, with a
  documented maximum of 500 phrases. Batch transcription does not support
  phrase lists. Source: Microsoft Q&A and Azure documentation.
- Whisper's `initial_prompt`, the mechanism the working providers rely on, is
  capped at roughly 224 tokens because the model's context halves for the
  prompt. Source: openai/whisper discussion #1386. It is also known to leak
  into transcripts on quiet audio, which this repo already mitigates with an
  energy gate.

## 3. The pipeline as implemented

```text
Correction made
  ├─ A. History details dialog ──> saveCorrectedTranscript (auto-learn.actions.ts)
  │      diff previous final transcript vs corrected text
  │      extractAutoLearnTerms (auto-learn.utils.ts)
  │      createGlossaryTerms ──> termById + SQLite (term_create)
  └─ B. Target app (edit-watch.actions.ts, driven by EditWatchSideEffects 1.5 s poll)
         get_text_field_info (AX) ──> findEditCorrections (edit-watch.utils.ts)
         pill toast "Add X to your dictionary?" ── toast-action event ──> accept/reject

Next dictation
  ├─ STT prompt: collectDictionaryEntries ──> buildLocalizedTranscriptionPrompt
  │      ("Glossary: a, b, c …") ──> repo.transcribeAudio({ prompt })
  │        ├─ passed:  local whisper, Groq, OpenAI, Azure (phrase list), Gemini,
  │        │           Speaches, OpenRouter, OpenAI-compatible, Gladia (proper vocab API)
  │        └─ dropped: Deepgram, AssemblyAI, ElevenLabs, xAI, Aldea  ← bug 4.3
  ├─ replacement rules: applied deterministically post-STT (works)
  └─ LLM post-processing: system prompt says "prefer glossary spelling"
         but the glossary itself is never included  ← bug 4.5
```

Both correction paths share the same extraction engine, so an engine defect
hits both. A wiring defect hits one path only.

## 4. Findings

Severity ordered. Each finding says what the user experiences, why it happens,
and the evidence level.

### 4.1 F1: "Learn from corrections" permanently stops working after one ignored prompt (E4)

This is the "does not function properly" headline. The watcher deadlocks
itself:

- `pollEditWatch` returns immediately whenever a proposal is pending, at
  `edit-watch.actions.ts:122`.
- A proposal is set the moment a correction is found at `:150`, and the toast
  is shown with a 10-second duration at `:106`.
- The only code that ever cleared a proposal was the accept and reject
  handlers at `:159-183`. The native pills on macOS, GTK and Windows hide the
  flash on their own timer and emit no event when it expires. The
  `toast-action` event fires only on a button click, per
  `platform/macos/overlay.rs:255-260` and `pill_process.rs:393`. Any other
  toast shown afterwards, for example the standard completion toast serialized
  through the same `toastQueue`, silently displaced the proposal toast too.

So if the user ignored the prompt once, or blinked past it, every later poll
was a no-op until the app restarted. A probe test with a proposal set showed
that a new dictation plus a new correction never even reached the
`get_text_field_info` invoke, and nothing cleared the stale proposal. The
existing `EditWatchSideEffects.test.ts` only covered unmount cleanup, so CI
could not see this.

Fix directions: self-expire the proposal by storing the timestamp and dropping
it after the toast's 10 seconds in `pollEditWatch`, clear it in
`beginEditWatch` and `endEditWatch`, and have the pill emit a
`toast-expired` event.

### 4.2 F2: case-only corrections were never learned, in either path (E4)

The extraction engine compared tokens case-insensitively, through
`toTokenCounts` lowercasing every key in `auto-learn.utils.ts:271-296`. A
correction that only fixed capitalisation produced zero added tokens:

- `sonia` → `Sonia`: learned nothing.
- `kanye west` → `Kanye West`: nothing.
- `nasa` → `NASA`: nothing.
- `i spoke to sonia yesterday` → `i spoke to Sonia yesterday`: nothing.

A probe verified each case. The shipped tests never exercised a case-only
edit. This is backwards for the feature's purpose. STT engines, Whisper in
particular, routinely emit proper nouns lowercased, so capitalisation is
exactly what users fix. The engine did require an initial capital to learn
anything through `UPPERCASE_LETTER_PATTERN` at `:28`, so the design clearly
wanted capitalisation to matter. The diff just erased it before that check
ran.

Fix direction: treat a token as added when its lowercase form existed in the
original but its casing changed and it now begins with an uppercase letter,
then let the existing proper-noun and common-word filters decide. Mirror the
same change for the edit-watch path, which shares `computeAddedTokens`.

### 4.3 F3: for five providers the dictionary never reached the STT engine at all (E2)

`transcribe-audio.repo.ts` batch repos for Deepgram at `:515`, Aldea at
`:412`, AssemblyAI at `:443`, ElevenLabs at `:483` and xAI at `:604` simply
never read `input.prompt`. `deepgramTranscribeAudio` at
`packages/voice-ai/src/deepgram.utils.ts:60` sent only
`model/punctuate/smart_format/language`, and the Deepgram streaming session
likewise sent no `keyterm` or `keywords`. Yet:

- Deepgram is one of the two providers the README tells every new user to grab
  a key for, and nova-3, the hardcoded model, supports `keyterm` prompting on
  both endpoints.
- AssemblyAI supports `word_boost` in batch and `keyterms_prompt` in
  streaming.
- ElevenLabs Scribe v2, hardcoded as `model_id=scribe_v2` in
  `elevenlabs.utils.ts:56`, supports `keyterms`.

Consequence: a Deepgram, AssemblyAI, ElevenLabs, xAI or Aldea user who turned
on auto-learn, corrected a name and saw "Added 'Soniya' to your dictionary"
then heard the same misrecognition on every future dictation, because the term
went nowhere. Combined with 4.5 below, the dictionary was a no-op for these
providers except for deterministic replacement rules, which auto-learn never
creates because it only creates glossary terms.

Fix direction: map `collectDictionaryEntries().sources` to each provider's
vocabulary parameter, with budget caps and surfaced warnings following the
Gladia builder in `gladia.utils.ts`, the in-repo reference implementation.

### 4.4 F4: the Whisper prompt path was uncapped, and Azure got instruction words (E2)

Where the prompt was passed, for local sidecar, Groq, OpenAI, Speaches,
OpenRouter, OpenAI-compatible and Gemini, `buildLocalizedTranscriptionPrompt`
in `prompt.utils.ts:310-315` joined all glossary sources with no count or
length budget. Whisper's `initial_prompt` is effectively capped around 224
tokens, so a large dictionary was silently truncated, and the repo's own
comments note prompt-echo hallucination on near-silent audio, already
mitigated by the energy gate in `BaseTranscribeAudioRepo`.

The Azure streaming path had the inverse problem.
`applyPhraseList` at `packages/voice-ai/src/azure.utils.ts:17-26` split the
whole localized prompt string on whitespace. Besides the actual terms it fed
Azure's phrase list the instruction words themselves, "Glossary:",
"Consider", "this", "glossary", "transcribing", biasing recognition towards
instruction vocabulary. It should pass `entries.sources` only, like the Gladia
builder.

### 4.5 F5: the LLM cleanup was told to prefer the glossary but never shown it (E2)

Every post-processing system prompt ends with
`GLOSSARY_EXACT_SPELLING_INSTRUCTION`: "When the user's glossary contains a
term, prefer that exact spelling even if the raw transcript differs." The
instruction lives in `prompt.utils.ts:119-120` and is appended at `:151` and
`:164`. But `buildPostProcessingRequest` in `transcribe.actions.ts:302-320`
never called `collectDictionaryEntries`. The user prompt contained only the
transcript, and the template variables were `username`, `transcript` and
`language`, with no `glossary` variable for custom style templates either.
The model was instructed to honour a list it could not see. This is also the
cheapest compensating fix for F3: even where the STT provider gets nothing, an
LLM that sees the glossary can fix "sonia" into "Soniya" in cleanup.

### 4.6 F6: the common-word filter was English-only and incomplete, so the dictionary filled with junk (E4)

`COMMON_WORDS` at `auto-learn.utils.ts:36-234` was a hand-rolled English list.
The app ships 100+ dictation languages. Probes verified:

- German: correcting to "Wir haben die **Stadt** Frankfurt besucht" learned
  `Stadt`, the ordinary word for city, alongside `Frankfurt`. Every German
  noun is capitalised, so any inserted or rewritten noun qualified.
- English gaps: "Lets meet **Monday**" and "**Please** send me the report"
  learned `Monday` and `Please`. Weekdays, months and politeness words were
  absent from the list.

The settings copy promises "names and words", but the intent everywhere else
in the code is proper-noun-like terms only. The filter just could not tell in
other languages. Fix directions: per-dictation-language stop lists even for
the top 10 shipped languages, weekday and month lists, and not learning a
case-only fix when the word was already capitalised in the original.

### 4.7 F7: settings and page copy misdescribed scope (E1, interface accuracy)

- "Auto-learn dictionary" said "when you correct a transcription" but meant
  only corrections in the History details dialog. Corrections in the
  review-before-insert pill flow at `pill-review.actions.ts` were never
  learned, and corrections in the target app belonged to the other toggle. A
  user who fixed a name at the review pill got no learning and no feedback.
- Even inside its real scope it learned only initial-capital, non-common
  tokens, at most 5 per correction, for edits of at most 8 tokens, and
  silently did nothing otherwise. The snackbar only appeared when something
  was added, so "it didn't learn" was indistinguishable from "it isn't
  working", which at the time was often true per F1 through F5.
- The Dictionary page subtitle described only replacement rules and never
  mentioned glossary terms, although the Add dialog defaults to glossary mode
  and auto-learn only ever creates glossary terms.

### 4.8 F8: the add-to-dictionary hotkey path was the least robust writer (E1)

`handleAddToDictionary` at `AppSideEffects.tsx:699-731` had no dedup, so
adding the same selection twice created two rows while only the prompt builder
deduped. It had no rollback if `createTerm` failed, so the optimistic term
stayed in state while every other writer in `dictionary.actions.ts` rolls
back. It had no length cap, so a selected paragraph became one giant term that
then ate the Whisper prompt budget per F4. It also did not tick the onboarding
checklist.

### 4.9 F9: the onboarding checklist only ticked for one of three add paths (E1)

The "Add a word to your dictionary" getting-started item is driven by
`mausvoice:checklist-dictionary`, which only `DictionaryPage.addTerm` at
`DictionaryPage.tsx:50` set. Terms added by auto-learn through
`dictionary.actions.ts:createGlossaryTerms` or by the hotkey per F8 never
ticked it.

## 5. What does work (verified)

To be fair to the implementation, MausAgent traced these and they are correct:

- Both toggles persist correctly through the preferences repo. Tests pass,
  defaults are true and false respectively, and per-platform gating of the
  edit-watch setting matches platform support.
- The extraction engine's happy path for spelling-corrected proper nouns,
  punctuation and possessive trimming, supplementary-plane handling, dedup,
  caps and rewrite detection. 34 unit tests, all passing.
- Glossary and replacement persistence via `term_create` and `term_list` with
  migrations, plus optimistic updates with per-term rollback in
  `createGlossaryTerms`.
- The Gladia path is a model implementation: vocabulary and custom spelling
  with explicit budget caps and surfaced warnings.
- Replacement rules are applied deterministically post-STT in both the
  dictation strategy and imported transcripts.
- Pill toast action buttons render on all three platforms and the
  `toast-action` event round-trips to the webview on macOS overlay, GTK and
  Windows.

## 6. Recommended fix order

1. **F1**: self-expire and clear the auto-learn proposal. Small, unblocks the
   whole edit-watch feature. Add the regression test from the probe.
2. **F2**: case-aware token diff. Small, restores the most common learning
   case. Add tests for case-only corrections in both paths.
3. **F5**: include the glossary in the post-processing prompt. Small,
   immediately makes learned terms effective for every provider that has
   post-processing on.
4. **F3**: wire provider vocabulary for Deepgram, AssemblyAI, ElevenLabs and
   Azure, following the Gladia builder's budget pattern. Add per-provider
   tests asserting the parameter is present.
5. **F4**: cap the Whisper prompt budget and pass only term sources to the
   Azure phrase list.
6. **F6**: language-aware stop lists. At minimum stop learning a term when
   only its case changed and it is sentence-initial, using the cheap proxy of
   skipping the first token of a correction.
7. **F7, F8, F9**: copy fixes, checklist ticks from `createGlossaryTerms`, and
   hardening of the hotkey writer.

## 7. Test evidence appendix

Commands run in this session, in `apps/desktop`:

- `pnpm vitest run src/utils/prompt.utils.test.ts src/utils/edit-watch.utils.test.ts
src/utils/auto-learn.utils.test.ts src/components/root/EditWatchSideEffects.test.ts
src/repos/preferences.repo.test.ts src/components/dictionary/DictionaryRow.test.ts
src/repos/transcribe-audio.repo.test.ts`
  gave 7 files, 109 tests, all passing. The shipped spec is satisfied. The
  defects above are gaps the suites did not cover.
- Probe suite A for auto-learn accuracy ran 7 cases and reproduced F2, where a
  case-only correction produced an empty list in both paths, and F6, where
  `Stadt`, `Monday` and `Please` were learned.
- Probe suite B for edit-watch reproduced F1, where a stale proposal blocked
  the `get_text_field_info` invoke and the proposal was never cleared.

All probe files were removed after running.

## 8. Fix log (applied on this branch)

All fixes below were implemented after the investigation above. Verification:
desktop `test:unit` runs 124 files with 1326 tests green, voice-ai `test` runs
21 files with 159 tests green, `check-types` and `lint`, which is prettier
plus oxlint, are clean, and the i18n catalog re-sync is idempotent so the CI
format-and-i18n job passes locally.

### F1: proposal lifecycle

The edit-watch watcher no longer deadlocks after an ignored toast.

- `state/auto-learn.state.ts`: the proposal now carries `proposedAt`.
- `actions/edit-watch.actions.ts`: a proposal self-expires after 12 seconds,
  which is the 10-second toast plus grace for the IPC queue, instead of
  blocking every future poll. `beginEditWatch` and `endEditWatch` clear any
  pending proposal, because a new dictation supersedes it and with the watcher
  torn down the accept and reject listener is gone anyway.
- New regression suite `actions/edit-watch.actions.test.ts` covers: stale
  proposal cleared and polling continues, live proposal still blocks, new
  dictation supersedes, `endEditWatch` clears, accept still persists a term.

### F2: case-only corrections are learned

- `utils/auto-learn.utils.ts`: `computeAddedTokens` keeps an exact-form,
  case-sensitive multiset alongside the case-insensitive one. A corrected
  token that matches case-insensitively but not exactly is a casing
  correction, so "sonia" becomes "Sonia" and surfaces as an added token. The
  proper-noun and common-word filters still gate learnability, and a
  decapitalization still learns nothing.
- Tests cover a case-only name, an acronym with `nasa` becoming `NASA`, a
  full name with `kanye west` becoming `Kanye West`, rejected
  decapitalization, and repeated tokens deduped. The same case-only path is
  tested through `findEditCorrections` for edit-watch.

### F3: provider vocabulary wiring

Deepgram, AssemblyAI, ElevenLabs and Azure now all receive the user's
dictionary as recognition hints.

- `packages/voice-ai`: `deepgramTranscribeAudio` sends repeated `keyterm`
  query parameters. `elevenlabsTranscribeAudio` sends repeated `keyterms`
  form fields. `assemblyaiTranscribeAudio` sends `word_boost` in the
  transcript payload. `azureTranscribeAudio` and `createAzureStreamingSession`
  take a `phrases` array for the phrase-list grammar.
  `azureTranscribeAudio` runs one-shot recognition through the Speech SDK,
  whose PhraseListGrammar supports phrase lists. It is not Azure Batch
  Transcription, the separate asynchronous REST service, which does not
  support phrase lists at all. The vocabulary handling stays in the Azure
  batch repository because that repository is what batch-mode dictation
  uses.
- Desktop batch repos in `repos/transcribe-audio.repo.ts` and `repos/index.ts`:
  the four repos receive the user's vocabulary at construction, capped by
  per-provider budgets with a surfaced warning when entries had to be dropped.
- Streaming sessions: the Deepgram WebSocket URL gains repeated `keyterm`
  parameters, ElevenLabs realtime gains repeated `keyterms` parameters, the
  AssemblyAI v3 WebSocket gains `keyterms_prompt` as a JSON array, and Azure
  streaming passes clean phrases.
- New provider contract tests assert the parameters are actually present in
  `deepgram.utils.test.ts`, `elevenlabs.utils.test.ts` and
  `azure.utils.test.ts`, plus `word_boost` cases in
  `assemblyai.utils.test.ts`.
- xAI and Aldea remain without vocabulary because neither documents a
  biasing parameter.

### F4: prompt hygiene

- `utils/prompt.utils.ts`: `buildLocalizedTranscriptionPrompt` caps the
  glossary so the joined term string stays at or under 650 characters
  including separators, keeping the whole `initial_prompt` under whisper's
  roughly 224-token ceiling.
- The Azure phrase list no longer receives the localized prompt sentence,
  which fed instruction words like "Glossary:" and "transcribing" into the
  recognizer. It now receives the dictionary terms verbatim, multi-word
  phrases intact.

### F5: the LLM cleanup now sees the glossary

- `PostProcessingPromptInput` carries the dictionary entries. Every
  post-processing system prompt, in both the style and template branches,
  appends a "User glossary" block with preferred spellings and spelling
  rules, budgeted, directly before the exact-spelling instruction. A new
  `glossary` template variable is available to custom style templates.
- `actions/transcribe.actions.ts` passes `collectDictionaryEntries(state)`
  into the request builder.

### F6: stop-list extension

- `COMMON_WORDS` gains English politeness words, greetings and connectives,
  weekdays and months with abbreviations, and a documented stopgap set of
  frequent capitalized nouns, pronouns and politeness words for German,
  French, Spanish, Italian, Portuguese and Dutch. Tests pin the German
  "Stadt", weekday and "Please" cases while real names still pass.

### F7: interface copy

- The "Auto-learn dictionary" description now states its real scope,
  corrections of saved transcriptions in History, and points at "Learn from
  corrections" for in-app edits.
- The Dictionary page subtitle now explains glossary terms as well as
  replacement rules.
- New messages were extracted and translated across all nine locales. The
  catalog passes the translation-completeness test and the CI idempotency
  check.

### F8: add-to-dictionary hotkey hardening

- `AppSideEffects.handleAddToDictionary` now routes through
  `createGlossaryTerms`, which does the optimistic update with per-term
  rollback, instead of hand-rolling a second term write. It dedupes against
  existing terms and says "already in your dictionary", rejects selections
  over 200 characters, reports persistence failures, and ticks the onboarding
  checklist.

### F9: checklist ticks for every add path

- `createGlossaryTerms` sets `mausvoice:checklist-dictionary` on success, so
  auto-learn, edit-watch proposals and the hotkey all satisfy the "add a word
  to your dictionary" item. Previously only the Dictionary page's own dialog
  did.

### Deliberately not changed

- The pill still emits no `toast-expired` event. The frontend TTL is
  sufficient and avoids touching three Rust crates for this fix.
- Per-language stop lists keyed by dictation language, the durable F6 fix,
  and multi-word term learning remain open improvements. The stop list here is
  an explicit stopgap.
- Review-before-insert edits and the transcription-details edit still do not
  share one learning entry point. F7's copy now makes the split visible
  instead of hiding it.

## 9. Review pass: line-by-line check and corrections

After the fixes above were committed, MausAgent re-read the full diff line by
line and re-verified every provider claim against the provider's own
documentation. The review confirmed the implementation approach but found
three budget constants that contradicted documented limits and three cases of
duplicated logic. All were corrected.

### 9.1 Budget corrections

| Budget                                             | Before | After | Why, with source                                                                                                 |
| -------------------------------------------------- | ------ | ----- | ---------------------------------------------------------------------------------------------------------------- |
| `AZURE_PHRASE_LIST_BUDGET.maxEntries`              | 1000   | 500   | Microsoft documents a maximum of 500 phrases per phrase list.                                                    |
| `DEEPGRAM_KEYTERM_BUDGET.maxCharacters`            | 4000   | 1500  | Deepgram's docs say to stay well under a 500-token total keyterm budget. 1500 characters is roughly 375 tokens.  |
| `ELEVENLABS_BATCH_KEYTERMS_BUDGET.maxEntries`      | 1000   | 100   | The API accepts 1000, but past 100 each request incurs a 20-second minimum billable duration.                    |
| `ELEVENLABS_BATCH_KEYTERMS_BUDGET.maxTermLength`   | absent | 50    | Each keyterm must be under 50 characters.                                                                        |
| `ELEVENLABS_BATCH_KEYTERMS_BUDGET.maxWordsPerTerm` | absent | 5     | Each keyterm can contain at most 5 words.                                                                        |
| `ELEVENLABS_REALTIME_KEYTERMS_BUDGET`              | shared | 50/20 | The realtime WebSocket accepts up to 50 keyterms of at most 20 characters each, split out from the batch budget. |

`capVocabularyTerms` now enforces the per-term word limit through a new
optional `maxWordsPerTerm` field on `VocabularyBudget`. Terms that exceed a
per-term limit are skipped and reported as truncated, matching how over-length
terms were already handled.

Verified and unchanged:

- `GLOSSARY_PROMPT_BUDGET` at 100 entries and 2000 characters is an internal
  prompt-size choice, not a provider limit.
- `TRANSCRIPTION_GLOSSARY_BUDGET` at 650 characters now counts separators in
  the joined string, so the number in the comment is the number the code
  enforces. The localized instruction sits on top of it and both stay under
  whisper's roughly 224-token ceiling.
- `ASSEMBLYAI_WORD_BOOST_BUDGET` at 1000 entries matches the documented
  word_boost capacity. The review kept `word_boost` for batch because
  `keyterms_prompt` adds a surcharge on newer models, while the legacy
  parameter stays free.
- `ASSEMBLYAI_STREAMING_KEYTERMS_BUDGET` at 100 entries and 50 characters per
  term matches the streaming docs exactly. Requests with more than 100
  keyterms are rejected with an error, so the cap is required, not advisory.

New tests in `prompt.utils.test.ts` pin every documented limit, so a future
change to these constants has to consciously update the test.

### 9.2 Duplicated logic removed

The review found three duplications introduced by the fixes themselves. All
were extracted into shared helpers.

- **Provider vocabulary composition.** The collect, cap and warn sequence was
  repeated in five places: `repos/index.ts` for batch and each of the four
  streaming sessions. `buildProviderVocabulary` in `prompt.utils.ts` now owns
  that sequence, and all five call sites use it. Every site produces the same
  warning text for the same condition.
- **Dictionary value collection.** The flatMap that lists every source and
  destination value in the user's dictionary existed in
  `auto-learn.actions.ts`, `edit-watch.actions.ts` and
  `AppSideEffects.tsx`. `collectTermValues` in `app.utils.ts` now owns it, and
  all three callers use it.
- **Glossary prompt formatting.** `buildGlossaryPromptLines` and
  `formatGlossaryTemplateVar` each capped the same glossary in parallel, and
  neither capped replacement rules by characters. `collectBudgetedGlossary`
  now caps once, terms and rules both under the character budget, and the two
  formatters only decide how to join the result.

### 9.3 Sources used in the review

- Deepgram keyterm prompting:
  developers.deepgram.com/docs/keyterm. Repeated plain `keyterm` parameters,
  up to 100 keyterms, stay well under the 500-token limit.
- ElevenLabs batch speech to text:
  elevenlabs.io/docs/api-reference/speech-to-text/convert, plus the
  elevenlabs-python issue #819 and the official keyterm prompting guide, which
  together confirm repeated form fields for batch and repeated query
  parameters for realtime, the 50-character and 5-word per-term limits, the
  20 percent surcharge, and the 20-second minimum billing above 100 keyterms.
- ElevenLabs realtime keyterm limits: the ElevenLabs changelog entry of
  2026-04-27 and the speech-to-text capability overview, which both state a
  maximum of 50 realtime keyterms of up to 20 characters each.
- AssemblyAI streaming prompting and keyterms:
  assemblyai.com/docs/streaming/prompting-and-keyterms. Maximum 100 keyterms
  per session, each 50 characters or less, more than 100 returns an error.
- AssemblyAI keyterms and pricing:
  assemblyai.com/docs/pre-recorded-audio/keyterms-prompting and
  assemblyai.com/pricing. Batch keyterms prompting costs extra on newer
  models, which is why batch keeps `word_boost`.
- Azure phrase lists: Microsoft Q&A answers and Azure documentation mirror.
  A phrase list should not have more than 500 phrases. Batch transcription
  does not support phrase lists.
- Whisper initial_prompt: openai/whisper discussion #1386. The prompt is
  capped at roughly 224 tokens.

### 9.4 Known limits of this review

- MausAgent verified every claim against documentation, not against live API
  endpoints. The environment has no provider keys. The contract tests assert
  the exact wire format the docs specify.
- The AssemblyAI streaming session connects without a `speech_model`
  parameter and uses the account default. The docs list keyterms support for
  the universal streaming models. If an account default is pinned to an older
  model, `keyterms_prompt` may be ignored, and the session still works.
- Using ElevenLabs keyterms adds a 20 percent transcription surcharge. This
  is the cost of the feature working at all on that provider, and it applies
  only when the user's dictionary is non-empty. The request sends no keyterms
  when the dictionary is empty.
