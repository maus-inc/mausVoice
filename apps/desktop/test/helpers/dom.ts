/**
 * Small DOM helpers shared by the jsdom component tests.
 */

/**
 * The element a test asked for, or a failure that names it.
 *
 * Tests that query the rendered tree hands-free (`querySelector`, the
 * `querySelectorAll` plus `find` pair) get a nullable result, and unwrapping it
 * with a non-null assertion turns a missing element into "cannot read
 * properties of null" at the line that used it, which reads like a component
 * bug rather than a query that found nothing. This throws with the name of the
 * thing the test expected, so the failure says what went wrong.
 */
export const requireElement = <T extends Element>(
  element: T | null | undefined,
  description: string,
): T => {
  if (!element) {
    throw new Error(`Expected ${description} to be rendered`);
  }
  return element;
};
