## Spoken commands

Base `d1f06ec` vs this branch, English. Correct means the output equals the hand-written expectation.

| Set | Cases | Correct before | Correct after |
| --- | --- | --- | --- |
| Ordinary speech (must stay literal) | 23 | 4 | 23 |
| Intended commands | 12 | 12 | 11 |

<details><summary>Every case</summary>

| Input | Expected | Before | After |
| --- | --- | --- | --- |
| The billing period ends on Friday. | The billing period ends on Friday. | `The billing. ends on Friday.` | ok |
| The sprint period ends Friday. | The sprint period ends Friday. | `The sprint. ends Friday.` | ok |
| The observation period lasted six weeks. | The observation period lasted six weeks. | `The observation. lasted six weeks.` | ok |
| During the period we saw strong growth. | During the period we saw strong growth. | `During the. we saw strong growth.` | ok |
| My period was late. | My period was late. | `My. was late.` | ok |
| A time period of rest. | A time period of rest. | ok | ok |
| Each period has its own budget. | Each period has its own budget. | `Each. has its own budget.` | ok |
| The waiting period is thirty days. | The waiting period is thirty days. | `The waiting. is thirty days.` | ok |
| We're launching a new line today. | We're launching a new line today. | `We're launching a\ntoday.` | ok |
| Can you read the next line for me? | Can you read the next line for me? | `Can you read the\nfor me?` | ok |
| Write a new paragraph about pricing. | Write a new paragraph about pricing. | `Write a\n\nabout pricing.` | ok |
| Put a comma after the name. | Put a comma after the name. | `Put a, after the name.` | ok |
| Remove that comma. | Remove that comma. | `Remove that,` | ok |
| I always use the Oxford comma. | I always use the Oxford comma. | ok | ok |
| Where does the question mark go? | Where does the question mark go? | `Where does the? go?` | ok |
| Add a semicolon there. | Add a semicolon there. | `Add a; there.` | ok |
| The colon is part of the large intestine. | The colon is part of the large intestine. | `The: is part of the large intestine.` | ok |
| He was diagnosed with colon cancer. | He was diagnosed with colon cancer. | ok | ok |
| We need a new line of credit. | We need a new line of credit. | ok | ok |
| That was a full stop for the project. | That was a full stop for the project. | `That was a. for the project.` | ok |
| Let's scratch that idea and start over. | Let's scratch that idea and start over. | `idea and start over.` | ok |
| I'll scratch that off my list. | I'll scratch that off my list. | `off my list.` | ok |
| We should scratch that from the agenda. | We should scratch that from the agenda. | `from the agenda.` | ok |
| first item new line second item | first item\nsecond item | ok | ok |
| Hello comma world | Hello, world | ok | ok |
| That is final period | That is final. | ok | ok |
| I'm done period See you | I'm done. See you | ok | ok |
| Send it today period | Send it today. | ok | ok |
| call me tomorrow full stop | call me tomorrow. | ok | ok |
| Stop period next line Go | Stop.\nGo | ok | ok |
| Is it ready question mark | Is it ready? | ok | ok |
| Note colon bring snacks | Note: bring snacks | ok | ok |
| Hello world scratch that new paragraph Goodbye | \n\nGoodbye | ok | ok |
| Hello world scratch that period | . | ok | ok |
| hello period how are you | hello. how are you | ok | `hello period how are you` |

</details>

## Segment silence gate

The full `applyHallucinationFiltering` pipeline (probability gate, then the known-phrase filter), old vs new, on the same segments.

| | Before | After |
| --- | --- | --- |
| Speech cases with words kept (of 5) | 2 | 5 |
| Hallucination cases that reach the user (of 6) | 0 | 2 |

2 confident hallucinations pass the new gate and are then removed by the known-phrase filter.

<details><summary>Every case</summary>

| Case | Truth | no_speech_prob / avg_logprob | Before | After |
| --- | --- | --- | --- | --- |
| Quiet opening after a pause, decoded confidently | speech | 0.93 / -0.25 | `(empty)` | `Can you send the report by Friday?` |
| Short reply at the end of a long pause | speech | 0.91 / -0.4 | `(empty)` | `Yes, that works.` |
| Soft-spoken name in a mostly silent window | speech | 0.95 / -0.6 | `(empty)` | `Meeting with Adaeze at noon.` |
| Ordinary speech, low no-speech probability | speech | 0.05 / -0.2 | `Let's ship it on Monday.` | `Let's ship it on Monday.` |
| Unsure decode of silence | hallucination | 0.97 / -1.3 | `(empty)` | `(empty)` |
| Canonical hallucination, decoded confidently | hallucination | 0.96 / -0.2 | `(empty)` | `(empty)` |
| Subtitle credit, decoded confidently | hallucination | 0.98 / -0.15 | `(empty)` | `(empty)` |
| Confident hallucination not on the known-phrase list | hallucination | 0.95 / -0.35 | `(empty)` | `I'll see you in the next video.` |
| Confident 'Thanks.' on silence (not on the list) | hallucination | 0.92 / -0.5 | `(empty)` | `Thanks.` |
| Provider without avg_logprob, silent window | hallucination | 0.95 / - | `(empty)` | `(empty)` |
| Speech then trailing silence hallucination | speech | 0.1 / -0.3; 0.94 / -0.25 | `Please call me back.` | `Please call me back.` |

</details>

## Post-processing replies

What gets pasted for a 46-word dictation when the model reply is complete or cut off.

| Reply | Before: words pasted | After: words pasted | After: warning |
| --- | --- | --- | --- |
| Complete JSON | 46 | 46 | none |
| Complete JSON in a code fence | 46 | 46 | none |
| Cut off at 60% | 26 | 46 (raw) | parse failed; truncation hint shown |
| Cut off at 90% | 43 | 46 (raw) | parse failed; truncation hint shown |
| Fenced, cut off before the closing fence | 46 (raw) | 46 (raw) | parse failed; truncation hint shown |

## Output-token budget

| Words | Estimated tokens | Before | After |
| --- | --- | --- | --- |
| 20 | 23 | 600 | 2048 |
| 100 | 112 | 600 | 2048 |
| 250 | 281 | 600 | 2048 |
| 500 | 563 | 600 | 2712 |
| 1000 | 1125 | 600 | 4399 |
| 1500 | 1687 | 600 | 6086 |
| 2000 | 2250 | 600 | 7774 |
| 3000 | 3375 | 600 | 8192 |

## Local RMS gate (JS port)

Gated means the clip is treated as silence and never transcribed.

| Clip (16 kHz, synthetic) | Truth | Gated before | Gated after |
| --- | --- | --- | --- |
| Room tone only, 5 s | silence | yes | yes |
| Normal speech 2 s in 5 s | speech | no | no |
| Quiet 'yes' 0.5 s at the end of 20 s | speech | yes | no |
| Soft speech 1 s inside 30 s of hold | speech | yes | no |
| Single click 10 ms in 5 s of room tone | silence | yes | no |
