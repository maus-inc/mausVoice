export const formatSize = (bytes: number | undefined) => {
  if (!Number.isFinite(bytes)) {
    return "0 B";
  }
  const value = Number(bytes);
  if (value < 1024) {
    return `${value.toFixed(0)} B`;
  }
  const kilobytes = value / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(1)} KB`;
  }
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) {
    return `${megabytes.toFixed(2)} MB`;
  }
  const gigabytes = megabytes / 1024;
  return `${gigabytes.toFixed(2)} GB`;
};
