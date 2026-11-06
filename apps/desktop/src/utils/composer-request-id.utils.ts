/** A separate native-only slot for a composer's unedited transcript. */
export const composerOriginalRequestId = (requestId: string): string =>
  `${requestId}:original`;
