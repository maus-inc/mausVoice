# Remove the dead provider type duplicates from @maus-inc/types

Date: 2026-11-13
Status: accepted

## Context

`packages/types/src/llm-provider.types.ts` and `packages/types/src/stt-provider.types.ts`
defined `LlmProvider`, `LlmProviderInput`, `LlmProviderInputZod`, `SttProvider`,
`SttProviderInput` and `SttProviderInputZod`. The two files were near-identical, differing
only in the `Llm`/`Stt` prefix.

A repo-wide search found no reference to any of the six symbols outside the two files and
the barrel export. The actual LLM provider contract used by the agent is
`AgentLlmProvider` in `packages/agent/src/types.ts`, not `LlmProvider`. The only other
user of the files was `PullStatus` in `common.types.ts`, referenced solely by these two
files.

`@maus-inc/types` carries a `publishConfig` with `access: public`, so a removal here
would be a breaking change if the package were published. It is not: the npm registry
returns 404 for the package, no workflow runs `npm publish` or `pnpm publish`, and there
is no changeset configuration. The package is workspace-internal, and every consumer is
in this monorepo.

## Decision

Delete both files, drop their two barrel exports from `index.ts`, and delete the now
unreferenced `PullStatus` from `common.types.ts`. This is the consolidation the branch
exists for: two divergent copies of one shape become zero.

Rejected: keeping the files as a "public API" surface. Nothing consumes them, so the
surface is fictional. Rejected: leaving `PullStatus` behind, because after the two files
go it has no referent.

## Consequences

The types package loses six dead exports and one now-orphaned type. A repo-wide
`pnpm run check-types` passes with 9 of 9 turbo tasks. The build output is also cleaner:
`packages/types/dist/` previously carried a stale `provider-common.d.ts` with no
matching source file, and a clean rebuild no longer emits it.

Any future provider type that needs a home belongs beside its consumer, or in the
package that already owns the contract (`packages/agent` for the LLM provider shape),
rather than in the shared types barrel where a second copy can drift.
