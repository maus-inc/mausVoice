/** Keep the current page visible when the rail becomes a horizontal strip. */
export const revealCurrentSettingsPage = (rail: HTMLElement | null) => {
  const current = rail?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!rail || !current || rail.scrollWidth <= rail.clientWidth) return;

  const railBounds = rail.getBoundingClientRect();
  const currentBounds = current.getBoundingClientRect();
  if (currentBounds.left < railBounds.left) {
    rail.scrollLeft += currentBounds.left - railBounds.left;
  } else if (currentBounds.right > railBounds.right) {
    rail.scrollLeft += currentBounds.right - railBounds.right;
  }
};
