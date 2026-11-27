import {
  chooseLiveTransport,
  evictionEnd,
  pendingSegmentUris,
  readHlsPlaylist,
  seekTargetIfCovered,
  shouldResumeLive,
  type LiveTransport,
} from "@/lib/player/live-playlist";

type SourceBufferLike = {
  mode: string;
  updating: boolean;
  appendBuffer(data: Uint8Array): void;
  remove?(start: number, end: number): void;
  addEventListener(
    type: "updateend" | "error",
    listener: () => void,
    options?: { once?: boolean }
  ): void;
};

type MediaSourceLike = {
  readyState: string;
  addSourceBuffer(type: string): SourceBufferLike;
  endOfStream(): void;
  addEventListener(type: "sourceopen", listener: () => void, options?: { once?: boolean }): void;
};

type SourceCtor = {
  isTypeSupported?: (type: string) => boolean;
  new (): MediaSourceLike;
};

type Session = {
  jobId: string;
  url: string;
  transport: LiveTransport;
  /** Segment URIs whose append has finished, in order. */
  appended: string[];
  /** Segment URIs reserved by the one append chain, including those still in flight. */
  reserved: string[];
  mediaSource?: MediaSourceLike;
  buffer?: SourceBufferLike;
  chain: Promise<void>;
  resumeAt: number;
  resumed: boolean;
  watching: boolean;
  /** The playlist has ENDLIST. The source stays open until the playhead arrives. */
  complete: boolean;
  closed: boolean;
  revoked: boolean;
  onEnd?: () => void;
};

const sessions = new WeakMap<HTMLAudioElement, Session>();
const turns = new WeakMap<HTMLAudioElement, Promise<unknown>>();

export function liveSessionAttached(audio: HTMLAudioElement | null): boolean {
  return Boolean(audio && sessions.has(audio));
}

/** Drop the session so a later ready poll does not treat the element as live. */
export function releaseLiveSession(audio: HTMLAudioElement | null): void {
  if (!audio) return;
  const session = sessions.get(audio);
  if (!session) return;
  sessions.delete(audio);
  detachEnd(audio, session);
  revokeBlob(session);
}

function serial<T>(audio: HTMLAudioElement, fn: () => Promise<T>): Promise<T> {
  const prev = turns.get(audio) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  turns.set(
    audio,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function constructors(): { managed: SourceCtor | null; media: SourceCtor | null } {
  const host = globalThis as typeof globalThis & {
    ManagedMediaSource?: SourceCtor;
    MediaSource?: SourceCtor;
  };
  return {
    managed: host.ManagedMediaSource ?? null,
    media: host.MediaSource ?? null,
  };
}

function waitOpen(source: MediaSourceLike): Promise<void> {
  if (source.readyState === "open") return Promise.resolve();
  return new Promise((resolve) => {
    source.addEventListener("sourceopen", () => resolve(), { once: true });
  });
}

function isQuotaError(err: unknown): boolean {
  return err instanceof Error && (err.name === "QuotaExceededError" || /quota/i.test(err.message));
}

function bufferEvent(buffer: SourceBufferLike): Promise<void> {
  return new Promise((resolve, reject) => {
    buffer.addEventListener("updateend", () => resolve(), { once: true });
    buffer.addEventListener("error", () => reject(new Error("append failed")), { once: true });
  });
}

async function removePlayed(buffer: SourceBufferLike, audio: HTMLAudioElement): Promise<void> {
  const end = evictionEnd(audio.currentTime);
  if (end == null || typeof buffer.remove !== "function") {
    throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
  }
  const done = bufferEvent(buffer);
  buffer.remove(0, end);
  await done;
}

async function appendChunk(
  buffer: SourceBufferLike,
  bytes: Uint8Array,
  audio: HTMLAudioElement
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const done = bufferEvent(buffer);
    try {
      buffer.appendBuffer(bytes);
      await done;
      return;
    } catch (err) {
      if (!isQuotaError(err) || attempt === 3) throw err;
      await removePlayed(buffer, audio);
    }
  }
}

function coveredSeconds(audio: HTMLAudioElement): number {
  const buffered = audio.buffered;
  if (buffered && buffered.length > 0) {
    try {
      return buffered.end(buffered.length - 1);
    } catch {
      /* a detached range list */
    }
  }
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
}

function maybeResume(audio: HTMLAudioElement, session: Session): void {
  if (session.resumed) return;
  const at = seekTargetIfCovered(session.resumeAt, coveredSeconds(audio));
  if (at == null) return;
  session.resumed = true;
  try {
    audio.currentTime = at;
  } catch {
    session.resumed = false;
  }
}

function watchResume(audio: HTMLAudioElement, session: Session): void {
  if (session.watching) return;
  session.watching = true;
  const onGrow = () => maybeResume(audio, session);
  audio.addEventListener("loadedmetadata", onGrow);
  audio.addEventListener("canplay", onGrow);
  audio.addEventListener("durationchange", onGrow);
  audio.addEventListener("progress", onGrow);
  onGrow();
}

function detachEnd(audio: HTMLAudioElement, session: Session): void {
  if (!session.onEnd) return;
  audio.removeEventListener("timeupdate", session.onEnd);
  audio.removeEventListener("waiting", session.onEnd);
  session.onEnd = undefined;
}

function revokeBlob(session: Session): void {
  if (session.revoked || !session.url.startsWith("blob:")) return;
  session.revoked = true;
  try {
    URL.revokeObjectURL(session.url);
  } catch {
    /* already revoked */
  }
}

/**
 * The playlist is finished. Leave the source open while the playhead is
 * still inside the buffer. The element closes it: a job poll does not run
 * after Ready, so timeupdate and waiting are what reach the last byte.
 */
function markComplete(session: Session, audio: HTMLAudioElement): void {
  session.complete = true;
  if (session.onEnd) {
    closeIfHeard(session, audio);
    return;
  }
  const onEnd = () => closeIfHeard(session, audio);
  session.onEnd = onEnd;
  audio.addEventListener("timeupdate", onEnd);
  audio.addEventListener("waiting", onEnd);
  onEnd();
}

function closeIfHeard(session: Session, audio: HTMLAudioElement): void {
  if (!session.complete || session.closed) return;
  const covered = coveredSeconds(audio);
  const at = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  if (!(covered > 0) || at + 1 < covered) return;
  session.closed = true;
  detachEnd(audio, session);
  if (session.mediaSource?.readyState === "open") {
    try {
      session.mediaSource.endOfStream();
    } catch {
      /* already closed */
    }
  }
  revokeBlob(session);
}

function resumeIfStalled(
  audio: HTMLAudioElement,
  listenerPaused: boolean,
  complete: boolean
): void {
  if (
    !shouldResumeLive({
      listenerPaused,
      complete,
      paused: audio.paused,
      ended: audio.ended,
      currentTime: audio.currentTime,
      covered: coveredSeconds(audio),
    })
  ) {
    return;
  }
  const at = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  if (audio.ended && at > 0.05) {
    try {
      audio.currentTime = at;
    } catch {
      /* the next canplay still has the position */
    }
  }
  void audio.play().catch(() => undefined);
}

/**
 * One media source for the whole generation. New sections are appended by
 * a single chain, and a segment URI is reserved before that append so a
 * second poll cannot play it again. The element src is set once.
 */
export function syncLivePlayback(opts: {
  audio: HTMLAudioElement;
  playlistUrl: string;
  jobId: string;
  resumeAt: number;
  /** Set when the listener paused. An underrun leaves this false. */
  listenerPaused?: boolean;
}): Promise<{
  attached: boolean;
  url: string | null;
  complete: boolean;
  transport: LiveTransport | null;
}> {
  return serial(opts.audio, () => syncOnce(opts));
}

async function syncOnce(opts: {
  audio: HTMLAudioElement;
  playlistUrl: string;
  jobId: string;
  resumeAt: number;
  listenerPaused?: boolean;
}): Promise<{
  attached: boolean;
  url: string | null;
  complete: boolean;
  transport: LiveTransport | null;
}> {
  const response = await fetch(opts.playlistUrl, { credentials: "same-origin", cache: "no-store" });
  const listenerPaused = opts.listenerPaused === true;
  const current = sessions.get(opts.audio);
  if (!response.ok) {
    return {
      attached: Boolean(current),
      url: current?.url ?? null,
      complete: false,
      transport: current?.transport ?? null,
    };
  }
  const playlist = readHlsPlaylist(await response.text());
  if (playlist.segments.length === 0) {
    return {
      attached: Boolean(current),
      url: current?.url ?? null,
      complete: false,
      transport: current?.transport ?? null,
    };
  }
  let session = current;
  if (session && session.jobId !== opts.jobId) {
    sessions.delete(opts.audio);
    session = undefined;
  }
  if (!session) {
    const available = constructors();
    const transport = chooseLiveTransport({
      managed: Boolean(available.managed),
      managedMpeg: available.managed?.isTypeSupported?.("audio/mpeg") === true,
      mediaSource: Boolean(available.media),
      mediaSourceMpeg: available.media?.isTypeSupported?.("audio/mpeg") === true,
    });
    if (transport === "hls") {
      opts.audio.src = opts.playlistUrl;
      session = {
        jobId: opts.jobId,
        url: opts.playlistUrl,
        transport,
        appended: playlist.segments.map((segment) => segment.uri),
        reserved: playlist.segments.map((segment) => segment.uri),
        chain: Promise.resolve(),
        resumeAt: opts.resumeAt,
        resumed: false,
        watching: false,
        complete: false,
        closed: false,
        revoked: false,
      };
      sessions.set(opts.audio, session);
      watchResume(opts.audio, session);
      if (!playlist.complete) resumeIfStalled(opts.audio, listenerPaused, false);
      return {
        attached: true,
        url: session.url,
        complete: playlist.complete,
        transport,
      };
    }
    const Ctor = (transport === "mms" ? available.managed : available.media) as SourceCtor;
    const media = new Ctor();
    const url = URL.createObjectURL(media as unknown as MediaSource);
    opts.audio.src = url;
    await waitOpen(media);
    const buffer = media.addSourceBuffer("audio/mpeg");
    try {
      buffer.mode = "sequence";
    } catch {
      /* the implementation's default is already sequence */
    }
    session = {
      jobId: opts.jobId,
      url,
      transport,
      appended: [],
      reserved: [],
      mediaSource: media,
      buffer,
      chain: Promise.resolve(),
      resumeAt: opts.resumeAt,
      resumed: false,
      watching: false,
      complete: false,
      closed: false,
      revoked: false,
    };
    sessions.set(opts.audio, session);
    watchResume(opts.audio, session);
  } else {
    session.resumeAt = session.resumed ? session.resumeAt : opts.resumeAt;
  }
  if (session.transport === "hls") {
    maybeResume(opts.audio, session);
    if (!playlist.complete) resumeIfStalled(opts.audio, listenerPaused, false);
    return {
      attached: true,
      url: session.url,
      complete: playlist.complete,
      transport: session.transport,
    };
  }
  const next = pendingSegmentUris(
    session.reserved,
    playlist.segments.map((segment) => segment.uri)
  );
  session.reserved.push(...next);
  const target = session;
  if (next.length > 0 && target.buffer) {
    const buffer = target.buffer;
    target.chain = target.chain
      .then(async () => {
        const releaseUnplayed = (uri: string) => {
          const at = target.reserved.indexOf(uri);
          if (at < 0) return;
          const drop = new Set(
            target.reserved.slice(at).filter((item) => !target.appended.includes(item))
          );
          target.reserved = target.reserved.filter((item) => !drop.has(item));
        };
        for (const uri of next) {
          if (target.appended.includes(uri)) continue;
          try {
            const absolute = new URL(uri, opts.playlistUrl).toString();
            const part = await fetch(absolute, { credentials: "same-origin" });
            if (!part.ok) {
              releaseUnplayed(uri);
              return;
            }
            await appendChunk(buffer, new Uint8Array(await part.arrayBuffer()), opts.audio);
            target.appended.push(uri);
            maybeResume(opts.audio, target);
          } catch {
            releaseUnplayed(uri);
            return;
          }
        }
        if (playlist.complete) markComplete(target, opts.audio);
      })
      .catch(() => undefined);
    await target.chain;
  } else if (playlist.complete) {
    markComplete(target, opts.audio);
  }
  if (!playlist.complete) resumeIfStalled(opts.audio, listenerPaused, false);
  maybeResume(opts.audio, target);
  return {
    attached: true,
    url: target.url,
    complete: playlist.complete,
    transport: target.transport,
  };
}
