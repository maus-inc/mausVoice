/** Browser preview policy: never open native applications or external tabs. */
const reportBlockedOpen = (target: string): void => {
  console.info(
    `[mausVoice preview] External navigation is disabled: ${target}`,
  );
};

export const openUrl = async (url: string): Promise<void> =>
  reportBlockedOpen(url);
export const revealItemInDir = async (path: string): Promise<void> =>
  reportBlockedOpen(path);
export const openPath = async (path: string): Promise<void> =>
  reportBlockedOpen(path);
