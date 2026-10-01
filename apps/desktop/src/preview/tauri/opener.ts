/** Browser preview policy: never open native applications or external tabs. */
const reportBlockedOpen = (target: string): void => {
  console.info(
    `[mausVoice preview] External navigation is disabled: ${target}`,
  );
};

// The real opener plugin resolves only once the OS has handled the request, so
// these stay promise-returning even though the preview only logs the block.
export const openUrl = (url: string): Promise<void> => {
  reportBlockedOpen(url);
  return Promise.resolve();
};
export const revealItemInDir = (path: string): Promise<void> => {
  reportBlockedOpen(path);
  return Promise.resolve();
};
export const openPath = (path: string): Promise<void> => {
  reportBlockedOpen(path);
  return Promise.resolve();
};
