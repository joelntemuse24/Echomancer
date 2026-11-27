import {
  chooseLiveTransport,
  evictionEnd,
  pendingSegmentUris,
  readHlsPlaylist,
  seekTargetIfCovered,
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
};

const sessions = new WeakMap<HTMLAudioElement, Session>();
const turns = new WeakMap<HTMLAudioElement, Promise<unknown>>();

export function liveSessionAttached(audio: HTMLAudioElement | null): boolean {
  return Boolean(audio && sessions.has(audio));
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

function finish(session: Session, audio: HTMLAudioElement): void {
  if (session.mediaSource?.readyState === "open") {
    try {
      session.mediaSource.endOfStream();
    } catch {
      /* already closed */
    }
  }
  if (audio.ended) void audio.play().catch(() => undefined);
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
}): Promise<{ attached: boolean; url: string | null }> {
  return serial(opts.audio, () => syncOnce(opts));
}

async function syncOnce(opts: {
  audio: HTMLAudioElement;
  playlistUrl: string;
  jobId: string;
  resumeAt: number;
}): Promise<{ attached: boolean; url: string | null }> {
  const response = await fetch(opts.playlistUrl, { credentials: "same-origin", cache: "no-store" });
  const current = sessions.get(opts.audio);
  if (!response.ok) return { attached: Boolean(current), url: current?.url ?? null };
  const playlist = readHlsPlaylist(await response.text());
  if (playlist.segments.length === 0) {
    return { attached: Boolean(current), url: current?.url ?? null };
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
      };
      sessions.set(opts.audio, session);
      watchResume(opts.audio, session);
      return { attached: true, url: session.url };
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
    };
    sessions.set(opts.audio, session);
    watchResume(opts.audio, session);
  } else {
    session.resumeAt = session.resumed ? session.resumeAt : opts.resumeAt;
  }
  if (session.transport === "hls") {
    maybeResume(opts.audio, session);
    return { attached: true, url: session.url };
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
        for (const uri of next) {
          if (target.appended.includes(uri)) continue;
          const absolute = new URL(uri, opts.playlistUrl).toString();
          const part = await fetch(absolute, { credentials: "same-origin", cache: "no-store" });
          if (!part.ok) return;
          await appendChunk(buffer, new Uint8Array(await part.arrayBuffer()), opts.audio);
          target.appended.push(uri);
          maybeResume(opts.audio, target);
        }
        if (playlist.complete) finish(target, opts.audio);
      })
      .catch(() => undefined);
    await target.chain;
  } else if (playlist.complete) {
    finish(target, opts.audio);
  }
  maybeResume(opts.audio, target);
  return { attached: true, url: target.url };
}
