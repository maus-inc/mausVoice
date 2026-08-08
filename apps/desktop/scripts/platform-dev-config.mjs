const PLATFORM_SCRIPTS = {
  darwin: "dev:mac",
  linux: "dev:linux",
  win32: "dev:windows",
};

export function resolveDesktopDevScript(platformOverride) {
  const resolvedPlatform = platformOverride?.trim() || process.platform;
  const selectedScript = Object.hasOwn(PLATFORM_SCRIPTS, resolvedPlatform)
    ? PLATFORM_SCRIPTS[resolvedPlatform]
    : null;

  if (!selectedScript) {
    return null;
  }

  return {
    resolvedPlatform,
    selectedScript,
  };
}
