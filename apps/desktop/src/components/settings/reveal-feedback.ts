/**
 * Scrolls a save result into view, without stealing the user's place.
 *
 * Two rules, and both are why this is a function rather than five inline
 * branches inside the component's effect:
 *
 * - Never move the viewport while the user is working inside the dialog. A save
 *   is often still in flight when they start typing into the tester, and
 *   scrolling out from under them costs more than the alert it reveals. The
 *   alert still announces itself, so nothing is lost by staying put.
 * - A feedback box taller than the container is aligned to its top rather than
 *   its bottom, because aligning the bottom would hide the first line of the
 *   message, the part that says what went wrong.
 */
export const revealFeedback = (
  content: HTMLElement | null,
  feedback: HTMLElement | null,
): void => {
  if (!content || !feedback) return;
  if (content.contains(document.activeElement)) return;
  const containerRect = content.getBoundingClientRect();
  const errorRect = feedback.getBoundingClientRect();
  if (
    errorRect.top < containerRect.top ||
    errorRect.height > containerRect.height
  ) {
    content.scrollTop += errorRect.top - containerRect.top;
    return;
  }
  if (errorRect.bottom > containerRect.bottom) {
    content.scrollTop += errorRect.bottom - containerRect.bottom + 8;
  }
};
