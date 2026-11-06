/** Forward a child process's outcome without hiding failures or signals. */
export function forwardChildOutcome(child, errorMessage) {
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error(errorMessage, error);
    process.exit(1);
  });
}
