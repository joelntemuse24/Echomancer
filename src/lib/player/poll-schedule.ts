/**
 * A hidden tab does not poll, except while the listener is in the book.
 * Screen lock and a background tab would otherwise sit on the last section
 * until the next visit, because the following section only arrives on a poll.
 */
export function shouldPollJob(input: {
  visibility: "visible" | "hidden";
  playing: boolean;
  waitingForNext: boolean;
}): boolean {
  if (input.visibility !== "hidden") return true;
  return input.playing || input.waitingForNext;
}
