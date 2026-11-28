# Responsive and Localization

A layout that only works at one width and one language is unfinished. This
reference supports
[PAT-002 list page](../patterns/PAT-002-list-page.md) and
[PAT-008 dashboard](../patterns/PAT-008-dashboard.md).

For the exact breakpoint and direction props, use the sibling `fluentui` skill:
[FluentProvider](fluentui:references/components/fluentprovider.md).

## Reflow, do not shrink

Reflow content rather than shrinking it (RULE-023). Shrinking produces illegible
text and unreachable controls. Reflowing changes the arrangement:

- Columns collapse into a stacked detail view.
- A filter bar collapses into a single control that opens a panel.
- A wide grid becomes a list of records with a details region.

Choose the collapse behaviour when you design the region, not when you discover
the narrow width.

## Logical properties for direction

Use logical properties so a layout mirrors under right-to-left direction
(RULE-024). Prefer inline-start and inline-end over left and right in margins,
padding, and borders. A layout built with physical sides looks correct in one
direction and broken in the other.

Set the text direction once, at the root provider (RULE-026). Do not flip
individual components; mirroring at the root is what keeps icons, alignment, and
scrollbars consistent.

## Long content and truncation

Plan for long content and truncation with an accessible full value (RULE-025). A
long name, a long email, and a long description all happen in real data. Decide
per column:

- Wrap when the value is short and the row can grow.
- Truncate with an accessible full value when the row height must stay fixed.
- Move the full value into a details view when the column cannot show it.

Truncation without a way to read the full value is data loss, not a layout fix.

## Content length across languages

Translated text is often longer than the English source. Leave room for growth,
and avoid layouts that depend on an exact string width. A button, a tab, or a
column sized to the English label will break in another language. Size to the
container and let the content wrap or truncate deliberately.

## Verify at the edges

Check at least two widths in every theme, and check the direction opposite to
the one you designed in. The
[visual review checklist](../checklists/visual-review.md) lists the states to
cover, including the narrow and mirrored ones.

## Related references

- [Styling and tokens](styling-and-tokens.md) for theme-level values.
- [Accessibility](accessibility.md) for zoom and reflow obligations.
