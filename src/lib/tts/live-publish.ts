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

export type PlannedSegment = {
  uri: string;
  bytes: Buffer;
  /** False when this object is already the right bytes and must not be rewritten. */
  write: boolean;
};

const SEGMENT_NAME = /^live\/(\d{4})\.mp3$/;

/**
 * Playlist repair. Existing segment objects are kept when they are the next
 * exact slice of the published audio. A missing or mismatched name is skipped
 * so a URI a listener already has is not replaced, and the remaining bytes
 * are written at the first free index. Calling it again with those objects
 * present plans no writes.
 */
export function planLiveSegments(
  remote: Buffer,
  delta: Buffer,
  files: ReadonlyMap<string, Buffer>
): PlannedSegment[] {
  const published = remote.length === 0 ? delta : Buffer.concat([remote, delta]);
  if (published.length === 0) return [];
  const planned: PlannedSegment[] = [];
  let offset = 0;
  let maxExisting = -1;
  for (const name of files.keys()) {
    const match = SEGMENT_NAME.exec(name);
    if (match) maxExisting = Math.max(maxExisting, Number(match[1]));
  }
  for (let index = 0; offset < published.length && index <= maxExisting + 1; index++) {
    const uri = `live/${String(index).padStart(4, "0")}.mp3`;
    const have = files.get(uri);
    if (
      have &&
      have.length > 0 &&
      offset + have.length <= published.length &&
      published.subarray(offset, offset + have.length).equals(have)
    ) {
      planned.push({ uri, bytes: have, write: false });
      offset += have.length;
      continue;
    }
    if (have) continue;
    planned.push({ uri, bytes: published.subarray(offset), write: true });
    offset = published.length;
  }
  if (offset < published.length) {
    let index = maxExisting + 1;
    const taken = (candidate: number) => {
      const uri = `live/${String(candidate).padStart(4, "0")}.mp3`;
      return files.has(uri) || planned.some((segment) => segment.uri === uri);
    };
    while (taken(index)) index += 1;
    planned.push({
      uri: `live/${String(index).padStart(4, "0")}.mp3`,
      bytes: published.subarray(offset),
      write: true,
    });
  }
  return planned;
}
