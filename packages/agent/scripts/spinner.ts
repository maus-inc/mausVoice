const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A stopped spinner is inert; updates start it again for later work. */
export function createSpinner(
  initialMessage: string,
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
) {
  let message = initialMessage;
  let index = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer !== null) return;
    timer = setInterval(
      () => write(`\r  ${frames[index++ % frames.length]} ${message}`),
      80,
    );
  };
  start();
  return {
    update(next: string) {
      message = next;
      start();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
      write("\r" + " ".repeat(message.length + 10) + "\r");
    },
  };
}
