/** Restore only one deleted ID, preserving concurrent additions and removals. */
export const restoreDictionaryOrder = (
  ids: string[],
  previousIds: readonly string[],
  id: string,
): void => {
  if (ids.includes(id)) return;
  const oldIndex = previousIds.indexOf(id);
  const next = previousIds
    .slice(oldIndex + 1)
    .find((candidate) => ids.includes(candidate));
  const before = previousIds
    .slice(0, oldIndex)
    .reverse()
    .find((candidate) => ids.includes(candidate));
  let index = Math.min(Math.max(oldIndex, 0), ids.length);
  if (next) index = ids.indexOf(next);
  else if (before) index = ids.indexOf(before) + 1;
  ids.splice(index, 0, id);
};
