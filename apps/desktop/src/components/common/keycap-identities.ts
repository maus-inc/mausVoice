export const keycapIdentities = (keys: string[]) => {
  const occurrences = new Map<string, number>();
  return keys.map((key) => {
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return { key, identity: `${key}:${occurrence}` };
  });
};
