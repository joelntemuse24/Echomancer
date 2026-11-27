/**
 * The object already in storage is the published prefix. A new buffer may
 * only add bytes after that prefix. A mismatch is refused so a restarted
 * worker cannot overwrite audio a listener already has.
 */
export function reconcilePublished(remote: Buffer, published: Buffer): Buffer | null {
  if (remote.length === 0) return published;
  if (published.length < remote.length) return null;
  if (!published.subarray(0, remote.length).equals(remote)) return null;
  return published.subarray(remote.length);
}

/** A tagged full file is the finished book. Extending it would shift every offset. */
export function remoteIsFinishedBook(remote: Buffer): boolean {
  return remote.length >= 3 && remote.subarray(0, 3).toString("ascii") === "ID3";
}

/**
 * The PUT is committed only when this worker held the lease for the whole
 * upload. A lost lease or an aborted request leaves the object to the
 * worker that holds it now.
 */
export function commitLiveUpload(input: {
  heldBefore: boolean;
  aborted: boolean;
  heldAfter: boolean;
}): boolean {
  return input.heldBefore && !input.aborted && input.heldAfter;
}
