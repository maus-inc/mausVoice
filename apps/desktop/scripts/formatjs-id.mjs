const NON_LETTER_NUMBER = /[^a-z0-9]+/gi;

const stripEdgeUnderscores = (value) => {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "_") {
    start += 1;
  }
  while (end > start && value[end - 1] === "_") {
    end -= 1;
  }
  return value.slice(start, end);
};

const sanitize = (value) => {
  if (!value) {
    return "";
  }

  return stripEdgeUnderscores(
    value
      .toLowerCase()
      .replace(NON_LETTER_NUMBER, "_")
      .replace(/_{2,}/g, "_"),
  );
};

const truncate = (value, maxLength = 60) => {
  if (value.length <= maxLength) {
    return value;
  }
  return stripEdgeUnderscores(value.slice(0, maxLength));
};

export const createMessageId = (defaultMessage = "") => {
  const sanitized = sanitize(defaultMessage);
  const truncated = truncate(sanitized);
  return truncated || "message";
};

export const formatjsOverrideIdFn = (id, defaultMessage) => {
  if (id || !defaultMessage) {
    return id;
  }
  return createMessageId(defaultMessage);
};
