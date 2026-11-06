/** A missing port selects an automatically assigned native listener port. */
export const parseReceiverPort = (
  input: string,
): { valid: true; value: number | null } | { valid: false } => {
  const raw = input.trim();
  if (raw === "") return { valid: true, value: null };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return { valid: false };
  }
  return { valid: true, value };
};
