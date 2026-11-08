# NEXT (atomic steps)

1. Wait for Build Desktop (Windows) + (macOS) on `0df29189f94240520f3805690e8d6b88ca1f522c` (PR #319 round 8) to leave pending; poll `gh pr checks 319` every ~2 min.
2. If either build fails: `gh run view --log-failed` (annotations fallback — blob logs unreachable from sandbox), fix, push (new round row), keep the body head SHA current.
3. When all checks are green for ~10 min with 4 calm polls and no new threads/comments: mark round-8 disposition `resolved` in the body round log via `gh api -X PATCH` (jq payload), then report once.
4. Do NOT merge. If asked to merge, require the exact wording: "Yes Merge Branch arena/2ec3ad6b-mausvoice into Branch arena/0.1.6-consolidation".
