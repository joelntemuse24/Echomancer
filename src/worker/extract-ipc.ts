/**
 * Messages between the take-home parent and a warm extract child.
 * The child must not exit until listen-prep has been handed to the parent
 * (or the fallback kick has finished).
 */

export const LISTEN_PREP_ACK_MS = 5_000;

export interface ListenPrepRequest {
  type: "listen-prep";
  uploadId: string;
  requestId: number;
}

export interface ListenPrepAck {
  type: "listen-prep-ack";
  requestId: number;
}

/**
 * Ask the parent to start listen-prep and wait until it acks.
 * If the parent never acks, `fallback` runs in this process so the
 * request is not dropped when the child later goes idle.
 */
export function requestListenPrepHandoff(opts: {
  uploadId: string;
  requestId: number;
  send: (message: ListenPrepRequest) => boolean;
  onAck: (requestId: number, settle: () => void) => void;
  fallback: (uploadId: string) => Promise<void>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? LISTEN_PREP_ACK_MS;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      void opts.fallback(opts.uploadId).finally(finish);
    }, timeoutMs);
    opts.onAck(opts.requestId, () => {
      clearTimeout(timer);
      finish();
    });
    let sent = false;
    try {
      sent = opts.send({
        type: "listen-prep",
        uploadId: opts.uploadId,
        requestId: opts.requestId,
      });
    } catch {
      sent = false;
    }
    if (!sent) {
      clearTimeout(timer);
      void opts.fallback(opts.uploadId).finally(finish);
    }
  });
}
