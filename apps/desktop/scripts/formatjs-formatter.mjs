import { createMessageId } from "./formatjs-id.mjs";

const sortEntries = (entries) =>
  entries.sort(([idA], [idB]) => idA.localeCompare(idB));

export function format(messages) {
  const nextEntries = Object.values(messages).map((descriptor) => {
    const defaultMessage = descriptor.defaultMessage ?? "";
    const nextId = createMessageId(defaultMessage);
    return [
      nextId,
      {
        defaultMessage,
        description: descriptor.description,
      },
    ];
  });

  const sorted = sortEntries(nextEntries);

  return sorted.reduce((acc, [id, descriptor]) => {
    const message = descriptor.defaultMessage ?? "";
    if (Object.hasOwn(acc, id) && acc[id] !== message) {
      throw new Error(
        `Message ID collision for "${id}". Use distinct message text.`,
      );
    }
    acc[id] = message;
    return acc;
  }, {});
}
