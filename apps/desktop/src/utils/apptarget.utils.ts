const stripEdgeUnderscores = (value: string): string => {
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

export const normalizeAppTargetId = (name: string): string => {
  const trimmed = name.trim().toLowerCase();
  const sanitized = stripEdgeUnderscores(
    trimmed.replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_"),
  );

  if (sanitized.length === 0) {
    return `app_target_${crypto.randomUUID().replaceAll("-", "")}`;
  }

  return sanitized;
};
