---
id: PAT-007
title: Multi-step task with review and preserved state
decisions: [save-model, submit-feedback]
rules: [RULE-029, RULE-030]
components: [Button, Field, Input, Textarea, Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, MessageBar, MessageBarBody, Spinner, Divider]
derived: [application-owned step machine, application-owned draft persistence]
---

# Multi-step task with review and preserved state

## User task

Complete a task that spans several steps, be able to go back, and submit the whole result once at
the end.

## When to use / when not

Use it when a task is genuinely ordered and too large for one screen, such as onboarding or a
guided setup. Do not split a short form into steps, and do not use this pattern when the steps are
independent, which the settings pattern covers.

## Region order

1. Step indicator showing position and total.
2. Current step heading and fields.
3. Back and Continue actions, with the primary action last.
4. A review step summarizing all entered values.
5. Final submit action.

## Component mapping

Button, Field, Input, Textarea, Dialog and its parts, MessageBar, MessageBarBody, Spinner, and
Divider are verified exports. The step machine, the draft persistence, and the review summary are
application-owned. Persistence and the final submit are application responsibilities.

## Interaction flow

Moving forward validates only the current step. Moving back preserves entered values without
revalidating. The review step lets the user jump back to a step by name. Final submit disables its
action, shows a pending state, and prevents a duplicate submission.

## State ownership

The application owns the step index, the accumulated draft, per-step validation, and the final
submission status. The draft must survive back navigation and, where the product requires it, a
reload.

## Responsive behavior

The step indicator becomes compact at narrow widths but still shows position and total. Actions wrap
to a stable row rather than scrolling off screen.

## Accessibility

The current step is announced when it changes and focus moves to the step heading. The step
indicator is not the only way to learn position; the heading states it in text. Submit progress is
announced without moving focus.

## Edge cases

Leaving the task with unsaved progress triggers a confirmation. A failed step validation keeps the
user on that step with field messages. A submit failure keeps all steps intact and offers retry.
Refreshing mid-task restores the draft when persistence is enabled.

## Rules applied

RULE-029, RULE-030

## Derived decisions

The step machine, the choice to validate per step, and the decision to persist a draft are
application decisions. Persistence and authorization are application responsibilities. Server-side
validation is mandatory; client-side validation is advisory only.

## Tests

Fixture step navigation test, back-preserves-values test, duplicate-submit test, and a review-jump
test.
