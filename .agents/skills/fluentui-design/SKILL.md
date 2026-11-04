---
name: fluentui-design
description: Design, implement, and review coherent Fluent UI React v9 web applications. Use when composing pages, choosing surfaces (page, drawer, or dialog), arranging navigation, commands, forms, DataGrid or Table, tabs, feedback, and empty, loading, and error states for business and admin apps. Cross-links the API-focused fluentui skill for exact props and imports instead of copying API documentation.
license: MIT
---

# Fluent UI Design

This skill is the composition layer for Fluent UI React v9. It answers where a
surface belongs, which regions a page needs, who owns state, and how the parts
work together. It does not restate component props or imports; the sibling
`fluentui` skill owns those exact API facts.

Read this entry point first, then open only the references the task needs.

## Triggers and non-triggers

Use this skill when the task is about composition:

- Choosing a surface: a page, a drawer, a dialog, or an inline editor.
- Arranging navigation, page chrome, commands, and content regions.
- Deciding state ownership, save model, or submit feedback.
- Laying out forms, data grids, tabs, or multi-step task flows.
- Reviewing accessibility, responsive behavior, or visual coherence.

Do not use it for pure API lookup:

- The exact props, types, imports, or slots of one component.
- Token names or theme shape without a design question.
- Version-specific API changes.

For those, use the sibling `fluentui` skill. The entry point states that
dependency in its description on purpose: the two skills are co-installed.

## Reconnaissance

Before proposing a design, inspect the project instead of assuming:

- The installed `@fluentui/react-components` version, and whether it matches
  the baseline in [Compatibility](#compatibility).
- The React version. v9 peers on React `>=16.14.0` and `<20.0.0`.
- Where `FluentProvider` is mounted and which theme it applies.
- Existing page shells, layout patterns, and naming the app already uses.
- Whether the sibling `fluentui` skill is available for exact API facts.

If a project deviates from the baseline, say so and re-verify the rules you use.

## Task classification

Classify the request by the decision it contains, then load that reference.
The generated [reference index](references/index.md) maps every decision to the
patterns that resolve it.

| The task sounds like | Load |
| --- | --- |
| "Build a new area of the app" | [PAT-001 application shell](references/patterns/PAT-001-application-shell.md) |
| "Show a filterable list" | [PAT-002 list page](references/patterns/PAT-002-list-page.md) |
| "Show one record and its actions" | [PAT-003 record detail](references/patterns/PAT-003-record-detail.md) |
| "Create or edit an entity" | [PAT-004 form page](references/patterns/PAT-004-form-page.md) |
| "Edit without leaving the list" | [PAT-005 contextual edit](references/patterns/PAT-005-contextual-edit.md) |
| "Configure options" | [PAT-006 settings page](references/patterns/PAT-006-settings-page.md) |
| "Walk through a wizard" | [PAT-007 multi-step task](references/patterns/PAT-007-multi-step-task.md) |
| "Show metrics and trends" | [PAT-008 dashboard](references/patterns/PAT-008-dashboard.md) |

Cross-cutting questions have their own references: composition and state in
[foundation/composition-and-state.md](references/foundation/composition-and-state.md),
styling in [foundation/styling-and-tokens.md](references/foundation/styling-and-tokens.md),
accessibility in [foundation/accessibility.md](references/foundation/accessibility.md),
and responsive and localization behavior in
[foundation/responsive-and-localization.md](references/foundation/responsive-and-localization.md).

When a request names an exact component prop, that part is a `fluentui` skill
question. Answer the composition here, then hand off the API detail.

## Design-before-code checklist

Run the short sequence in
[checklists/design-before-code.md](references/checklists/design-before-code.md)
before writing components. In brief:

1. Name the user task in one sentence.
2. Choose the surface and say why the alternatives are worse.
3. List the page regions in reading order.
4. Decide state ownership and the save model.
5. Decide the feedback for loading, empty, error, and success.
6. Decide the responsive collapse and the permission state.
7. Confirm the accessibility path for every action.

A design that cannot answer all seven is not ready to implement.

## Surface decision workflow

Work from the task outward, not from a component inward.

- **Page versus drawer versus dialog.** A full page owns a stable URL and
  survives a refresh. A drawer keeps list context and suits a short edit. A
  dialog interrupts for a small, focused decision. State the reason in the
  pattern you choose.
- **Data surface.** A `DataGrid` is for interactive, columnar data with
  selection and sorting. A `Table` is for a small, mostly read-only set. The
  rule ids are listed in the [rule index](references/rules/index.md).
- **Region order.** Order regions as the user reads them: page header, command
  bar, filters, content, then details. Each pattern states its region order.
- **State ownership.** Keep server state in the data layer and view state in the
  page. Lift state only to the lowest common owner. The patterns state where
  each piece of state lives.
- **Derived decisions.** Every pattern lists what the application still owns,
  such as routing, validation, fetching, authorization, and persistence.

## Implementation constraints

- Use only exports that exist in the pinned package. The
  [rule index](references/rules/index.md) is grounded in a verified allowlist;
  when in doubt, confirm the export before using it.
- Prefer semantic HTML and the component's own slots over DOM overrides.
- Style with tokens and `makeStyles`. Do not hardcode colors, spacing, or
  shadows that the theme should own.
- Do not inject unsanitized HTML, and never suggest bypassing validation.
- Keep API specifics out of this package. Link the `fluentui` skill instead of
  copying a prop table.

## Accessibility and visual review

Accessibility is part of the design, not a later pass.

- Every interactive element is reachable and operable by keyboard.
- Opening and closing an overlay returns focus to the trigger.
- Async results are announced, not only drawn.
- Contrast, motion, zoom, and reflow are checked in the active theme.
- Run the focused review in
  [checklists/accessibility-review.md](references/checklists/accessibility-review.md)
  and the visual pass in
  [checklists/visual-review.md](references/checklists/visual-review.md).

The [accessibility foundation](references/foundation/accessibility.md) explains
the reasoning shared by every pattern.

## Tradeoff explanation

When a design choice has a real cost, say so plainly:

- State the choice and the alternative you rejected.
- Give the reason and the evidence, naming the rule that supports it.
- State confidence and the condition that would change the answer.
- Never present a convention as a requirement when it is only a preference.

A pattern file lists the derived decisions so a tradeoff is attributed to the
application, not to the component library.

## Evidence fallback

Evidence can be missing, outdated, or contradictory. Handle each case:

- **Missing.** Say which fact is unverified, answer from the bundled rules and
  patterns, and do not invent props.
- **Outdated.** Compare the project version with [Compatibility](#compatibility)
  and treat a newer install as unverified until re-pinned.
- **Contradictory.** Prefer the rule with a higher confidence and a named
  source, and surface the conflict instead of hiding it.
- **Sibling skill absent.** Answer composition from this package, and state that
  exact API facts could not be confirmed.

To refresh the bundled facts, follow
[maintenance/refresh-and-repin.md](references/maintenance/refresh-and-repin.md).

## Compatibility

| Item | Baseline |
| --- | --- |
| `@fluentui/react-components` | 9.74.7 |
| React peer range | `>=16.14.0 <20.0.0` |
| Pinned API-fact commit | `d595d79` |

Rules and patterns are written against this baseline. A different installed
version may still work, but its exports are not verified here until re-pinned.

## When to re-browse and re-verify

Re-verify when the installed Fluent UI version differs from the baseline, when a
rule is disputed in review, or when a design depends on a fact that this package
marks as unverified. Follow
[maintenance/refresh-and-repin.md](references/maintenance/refresh-and-repin.md):
refresh the sources, re-pin the facts commit, regenerate the indexes, and re-run
the gates. Do not silently adjust a rule to match a newer library.
