# Accessibility Review

Run this pass after the feature works, and again before release. It covers the
states that are easy to miss, not only the happy path.

## Keyboard

- Reach every action with the keyboard alone, in visual order.
- Enter or Space activates the focused control, and Escape closes an overlay.
- A grid, menu, or tab set behaves as one composite widget (RULE-021): one tab
  stop enters it and arrows move within it.

## Focus

- Focus is always visible and never hidden behind a sticky header or overlay
  (RULE-020).
- Opening an overlay moves focus inside; closing it returns focus to the trigger.
- Deleting or filtering an item moves focus to a sensible neighbour.
- A route change moves focus to the new page heading.

## Names and roles

- Every icon-only control has an accessible name (RULE-022).
- Every input has a programmatic label and, where needed, helper text
  (RULE-005).
- Errors are associated with the field they describe.

## Announcements

- A save, a filter change, and a failed submission are announced (RULE-016).
- A loading state exposes a busy or status indication.

## Visual

- Text and non-text contrast pass in light, dark, and high-contrast themes.
- Motion respects the reduced-motion preference (RULE-019).
- The layout reflows under zoom and at a narrow width (RULE-023).
- Truncated content exposes its full value (RULE-025).

## States to exercise

Test each of these, because each can break an assumption:

- First load with no data.
- Filter with no matches, distinct from no data.
- A failed request with a retry.
- A user without permission for an action.
- A very long value in every column and field.

See [accessibility foundation](../foundation/accessibility.md) for the reasoning
behind each check.
