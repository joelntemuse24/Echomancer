import {
  chooseLiveTransport,
  pendingSegmentUris,
  readHlsPlaylist,
  type LiveTransport,
} from "@/lib/player/live-playlist";

type SourceBufferLike = {
  mode: string;
  updating: boolean;
  appendBuffer(data: Uint8Array): void;
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
  appended: string[];
  mediaSource?: MediaSourceLike;
  buffer?: SourceBufferLike;
  chain: Promise<void>;
  resumed: boolean;
};

const sessions = new WeakMap<HTMLAudioElement, Session>();

export function liveSessionAttached(audio: HTMLAudioElement | null): boolean {
  return Boolean(audio && sessions.has(audio));
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

function appendChunk(buffer: SourceBufferLike, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    buffer.addEventListener("updateend", () => resolve(), { once: true });
    buffer.addEventListener("error", () => reject(new Error("append failed")), { once: true });
    buffer.appendBuffer(bytes);
  });
}

function restorePlayhead(audio: HTMLAudioElement, session: Session, resumeAt: number): void {
  if (session.resumed || !(resumeAt > 0.05)) return;
  const apply = () => {
    if (session.resumed || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    session.resumed = true;
    audio.currentTime = Math.min(resumeAt, Math.max(0, audio.duration - 0.05));
  };
  audio.addEventListener("loadedmetadata", apply, { once: true });
  audio.addEventListener("canplay", apply, { once: true });
  apply();
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
 * One media source for the whole generation. New sections are appended.
 * The element src is set once and stays through Ready.
 */
export async function syncLivePlayback(opts: {
  audio: HTMLAudioElement;
  playlistUrl: string;
  jobId: string;
  resumeAt: number;
}): Promise<{ attached: boolean; url: string | null }> {
  const response = await fetch(opts.playlistUrl, { credentials: "same-origin" });
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
        chain: Promise.resolve(),
        resumed: false,
      };
      sessions.set(opts.audio, session);
      restorePlayhead(opts.audio, session, opts.resumeAt);
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
      mediaSource: media,
      buffer,
      chain: Promise.resolve(),
      resumed: false,
    };
    sessions.set(opts.audio, session);
  }
  if (session.transport === "hls") {
    restorePlayhead(opts.audio, session, opts.resumeAt);
    return { attached: true, url: session.url };
  }
  const next = pendingSegmentUris(
    session.appended,
    playlist.segments.map((segment) => segment.uri)
  );
  const target = session;
  if (next.length > 0 && target.buffer) {
    const buffer = target.buffer;
    target.chain = target.chain
      .then(async () => {
        for (const uri of next) {
          const absolute = new URL(uri, opts.playlistUrl).toString();
          const part = await fetch(absolute, { credentials: "same-origin" });
          if (!part.ok) return;
          await appendChunk(buffer, new Uint8Array(await part.arrayBuffer()));
          target.appended.push(uri);
        }
        if (playlist.complete) finish(target, opts.audio);
        restorePlayhead(opts.audio, target, opts.resumeAt);
      })
      .catch(() => undefined);
    await target.chain;
  } else if (playlist.complete) {
    finish(target, opts.audio);
  }
  return { attached: true, url: target.url };
}
