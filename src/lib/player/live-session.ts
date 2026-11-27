import {
  chooseLiveTransport,
  evictionEnd,
  LIVE_AHEAD_SECONDS,
  liveAttachAllowed,
  liveSectionHold,
  pendingSegmentUris,
  playlistDurationSeconds,
  readHlsPlaylist,
  segmentUrisAhead,
  seekTargetIfCovered,
  shouldResumeLive,
  type LiveSegment,
  type LiveTransport,
} from "@/lib/player/live-playlist";

type SourceBufferLike = {
  mode: string;
  updating: boolean;
  appendBuffer(data: Uint8Array): void;
  abort?(): void;
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
  /** Seek, then play. A pause before that seek lands clears this. */
  play: boolean;
  /** The listener paused. An underrun must not press play. */
  hold: boolean;
  resumed: boolean;
  watching: boolean;
  /** The playlist has ENDLIST. The source stays open until the playhead arrives. */
  complete: boolean;
  closed: boolean;
  revoked: boolean;
  /** Element src before this session replaced it. Restored when no audio lands. */
  previousSrc?: string;
  /** Playhead and play state from before that replacement. A reload starts at 0. */
  previousTime?: number;
  keepPlaying?: boolean;
  onGrow?: () => void;
  onEnd?: () => void;
  onAhead?: () => void;
  /** Segment list from the last playlist read. The append window grows with the playhead. */
  segments: LiveSegment[];
  playlistUrl: string;
  extending: boolean;
};

const sessions = new WeakMap<HTMLAudioElement, Session>();
const turns = new WeakMap<HTMLAudioElement, Promise<unknown>>();
/** Bumped by every release, including one that finds no session yet. */
const attachTokens = new WeakMap<HTMLAudioElement, number>();
/** The job the element is polling. A different job invalidates the previous poll. */
const activeJob = new WeakMap<HTMLAudioElement, string>();
/**
 * Book time a navigation left the live element for, for that job only.
 * A later poll of the same job must not attach at an older playhead, and
 * must not attach until the playlist covers this time.
 */
const departedAt = new WeakMap<
  HTMLAudioElement,
  { jobId: string; at: number; bufferedEnd: number }
>();

export function liveSessionAttached(audio: HTMLAudioElement | null): boolean {
  return Boolean(audio && sessions.has(audio));
}

/** Captured when a poll starts. Release changes it, so that poll must stop. */
export function liveAttachToken(audio: HTMLAudioElement): number {
  return attachTokens.get(audio) ?? 0;
}

function bumpAttachToken(audio: HTMLAudioElement): void {
  attachTokens.set(audio, liveAttachToken(audio) + 1);
}

/**
 * The listener moved on the live element. A later append must not seek back
 * to the position from the first attach. `placed` is false when the target
 * is still past the buffer: the landing seek then uses this time.
 */
export function retargetLiveResume(
  audio: HTMLAudioElement | null,
  at: number,
  placed: boolean
): void {
  if (!audio) return;
  const session = sessions.get(audio);
  if (!session) return;
  session.resumeAt = Number.isFinite(at) ? Math.max(0, at) : 0;
  if (placed) {
    session.resumed = true;
    session.play = false;
  }
}

/** A pause or play that happens before the handoff seek lands. */
export function setLivePlayIntent(audio: HTMLAudioElement | null, play: boolean): void {
  if (!audio) return;
  const session = sessions.get(audio);
  if (!session) return;
  session.play = play;
  session.hold = !play;
}

function mayRestart(session: Session, listenerPaused: boolean, requested: boolean | undefined): boolean {
  if (listenerPaused || session.hold) return false;
  return requested !== false;
}

/**
 * The listener left the live element for a section. `leftAt` is the book
 * time they moved to. An in-flight poll stops. A later poll keeps that
 * section, including when the book time is inside the first 90 seconds.
 */
export function releaseLiveSession(audio: HTMLAudioElement | null, leftAt?: number): void {
  if (!audio) return;
  bumpAttachToken(audio);
  const session = sessions.get(audio);
  const jobId = session?.jobId ?? activeJob.get(audio);
  if (typeof leftAt === "number" && Number.isFinite(leftAt) && jobId) {
    departedAt.set(audio, {
      jobId,
      at: Math.max(0, leftAt),
      bufferedEnd: liveBufferedSeconds(audio),
    });
  }
  if (!session) return;
  dropSession(audio, session);
}

/** The element is now playing a different book. The previous book's poll, departure, and pause do not apply. */
function adoptJob(audio: HTMLAudioElement, jobId: string): void {
  const previous = activeJob.get(audio);
  if (previous === jobId) return;
  if (previous != null) {
    bumpAttachToken(audio);
    const left = departedAt.get(audio);
    if (!left || left.jobId !== jobId) departedAt.delete(audio);
    const session = sessions.get(audio);
    if (session && session.jobId !== jobId) dropSession(audio, session);
  }
  activeJob.set(audio, jobId);
}

function staleAttach(audio: HTMLAudioElement, token: number): boolean {
  return liveAttachToken(audio) !== token;
}

/**
 * Drop a session this poll created after the listener had already left.
 * Leave a src the listener has since replaced.
 */
function abandonStaleAttach(
  audio: HTMLAudioElement,
  session: Session | undefined,
  assignedUrl: string | null,
  previousSrc: string
): void {
  if (session && sessions.get(audio) === session) dropSession(audio, session);
  if (assignedUrl && audio.src === assignedUrl) audio.src = previousSrc;
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

const APPEND_TIMEOUT_MS = 8_000;

function bufferEvent(buffer: SourceBufferLike): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try {
        buffer.abort?.();
      } catch {
        /* the buffer was already idle */
      }
      finish(() => reject(new Error("append timed out")));
    }, APPEND_TIMEOUT_MS);
    buffer.addEventListener("updateend", () => finish(resolve), { once: true });
    buffer.addEventListener("error", () => finish(() => reject(new Error("append failed"))), {
      once: true,
    });
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

/** Seconds the element can play without waiting. Sequence mode's duration is Infinity. */
export function liveBufferedSeconds(audio: HTMLAudioElement | null): number {
  if (!audio) return 0;
  return coveredSeconds(audio);
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

function startKeptPlayback(audio: HTMLAudioElement, session: Session): void {
  if (!session.play) return;
  session.play = false;
  void audio.play().catch(() => undefined);
}

function maybeResume(audio: HTMLAudioElement, session: Session): void {
  if (session.resumed) return;
  const covered = coveredSeconds(audio);
  const at = seekTargetIfCovered(session.resumeAt, covered);
  if (at == null) {
    // The listener was already at the start. Play once the buffer has audio.
    if (session.play && !(session.resumeAt > 0.05) && covered > 0.05) {
      session.resumed = true;
      startKeptPlayback(audio, session);
    }
    return;
  }
  session.resumed = true;
  try {
    audio.currentTime = at;
  } catch {
    session.resumed = false;
    return;
  }
  startKeptPlayback(audio, session);
}

function appendedPlaylistSeconds(session: Session): number {
  let sum = 0;
  for (const segment of session.segments) {
    if (!session.appended.includes(segment.uri)) break;
    sum += Number.isFinite(segment.seconds) ? Math.max(0, segment.seconds) : 0;
  }
  return sum;
}

/**
 * Keep appending a short window ahead of the playhead. A job poll is not
 * required: once the published length stops changing, timeupdate is what
 * fetches the next segments.
 */
function watchAhead(audio: HTMLAudioElement, session: Session): void {
  if (session.onAhead || session.transport === "hls") return;
  const onAhead = () => {
    if (sessions.get(audio) !== session || session.extending || session.closed) return;
    const have = appendedPlaylistSeconds(session);
    const at = Math.max(
      Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      session.resumeAt
    );
    if (have + 0.5 >= at + LIVE_AHEAD_SECONDS) return;
    const published = playlistDurationSeconds(session.segments);
    if (have + 0.5 >= published) return;
    session.extending = true;
    void syncLivePlayback({
      audio,
      playlistUrl: session.playlistUrl,
      jobId: session.jobId,
      resumeAt: Math.max(session.resumeAt, at),
      play: false,
      listenerPaused: session.hold,
    }).finally(() => {
      session.extending = false;
    });
  };
  session.onAhead = onAhead;
  audio.addEventListener("timeupdate", onAhead);
}

function watchResume(audio: HTMLAudioElement, session: Session): void {
  if (session.watching) return;
  session.watching = true;
  const onGrow = () => {
    if (sessions.get(audio) !== session) return;
    maybeResume(audio, session);
  };
  session.onGrow = onGrow;
  audio.addEventListener("loadedmetadata", onGrow);
  audio.addEventListener("canplay", onGrow);
  audio.addEventListener("durationchange", onGrow);
  audio.addEventListener("progress", onGrow);
  onGrow();
}

function unwatch(audio: HTMLAudioElement, session: Session): void {
  if (!session.onGrow) return;
  audio.removeEventListener("loadedmetadata", session.onGrow);
  audio.removeEventListener("canplay", session.onGrow);
  audio.removeEventListener("durationchange", session.onGrow);
  audio.removeEventListener("progress", session.onGrow);
  session.onGrow = undefined;
  session.watching = false;
}

/**
 * The page asks for `/api/storage/.../live.m3u8`. `fetch` accepts that path.
 * `new URL(segment, playlist)` does not: a path is not a base, so every
 * segment fetch threw and the failed attach reloaded the section.
 */
export function absoluteFromPlaylist(
  resource: string,
  playlistUrl: string,
  documentHref: string
): string {
  const playlist = new URL(playlistUrl, documentHref);
  return new URL(resource, playlist).toString();
}

function segmentFetchUrl(resource: string, playlistUrl: string): string {
  const href =
    typeof location !== "undefined" && location.href && !location.href.startsWith("about:")
      ? location.href
      : "http://localhost/";
  return absoluteFromPlaylist(resource, playlistUrl, href);
}

/**
 * Putting the section URL back loads it again. Chrome starts that load at
 * 0:00 and paused, which is the playhead jump the listener hears.
 */
function putSectionBack(audio: HTMLAudioElement, session: Session): void {
  const previous = session.previousSrc;
  const liveUrl = session.url;
  const at = session.previousTime ?? 0;
  const play = session.keepPlaying === true;
  dropSession(audio, session);
  if (!(previous && audio.src === liveUrl)) return;
  const apply = () => {
    if (at > 0.05) {
      try {
        if (Math.abs(audio.currentTime - at) > 0.25) audio.currentTime = at;
      } catch {
        /* the range is not seekable until metadata */
      }
    }
    if (play && audio.paused) void audio.play().catch(() => undefined);
  };
  audio.addEventListener("loadedmetadata", apply, { once: true });
  audio.addEventListener("canplay", apply, { once: true });
  audio.src = previous;
  if (audio.readyState >= 1) apply();
}

function dropSession(audio: HTMLAudioElement, session: Session): void {
  if (sessions.get(audio) === session) sessions.delete(audio);
  unwatch(audio, session);
  detachEnd(audio, session);
  detachAhead(audio, session);
  revokeBlob(session);
}

function detachAhead(audio: HTMLAudioElement, session: Session): void {
  if (!session.onAhead) return;
  audio.removeEventListener("timeupdate", session.onAhead);
  session.onAhead = undefined;
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
  /** The listener was playing. The seek starts playback; a cold element stays paused. */
  play?: boolean;
  /** Set when the listener paused. An underrun leaves this false. */
  listenerPaused?: boolean;
}): Promise<{
  attached: boolean;
  url: string | null;
  complete: boolean;
  transport: LiveTransport | null;
}> {
  adoptJob(opts.audio, opts.jobId);
  const token = liveAttachToken(opts.audio);
  return serial(opts.audio, () => syncOnce(opts, token));
}

function leftBehind(
  audio: HTMLAudioElement,
  jobId: string,
  resumeAt: number,
  playlistSeconds: number
): boolean {
  const left = departedAt.get(audio);
  const same = left != null && left.jobId === jobId;
  if (same && resumeAt + 0.25 < left.at) return true;
  const gate = same ? Math.max(resumeAt, left.at) : resumeAt;
  return !liveAttachAllowed(gate, playlistSeconds);
}

function clearDeparture(audio: HTMLAudioElement, jobId: string): void {
  const left = departedAt.get(audio);
  if (left && left.jobId === jobId) departedAt.delete(audio);
}

async function syncOnce(
  opts: {
    audio: HTMLAudioElement;
    playlistUrl: string;
    jobId: string;
    resumeAt: number;
    play?: boolean;
    listenerPaused?: boolean;
  },
  token: number
): Promise<{
  attached: boolean;
  url: string | null;
  complete: boolean;
  transport: LiveTransport | null;
}> {
  const missed = (): {
    attached: false;
    url: null;
    complete: false;
    transport: null;
  } => ({ attached: false, url: null, complete: false, transport: null });
  const response = await fetch(opts.playlistUrl, { credentials: "same-origin", cache: "no-store" });
  if (staleAttach(opts.audio, token)) return missed();
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
  const body = await response.text();
  if (staleAttach(opts.audio, token)) return missed();
  const playlist = readHlsPlaylist(body);
  const left = departedAt.get(opts.audio);
  const chosen = left != null && left.jobId === opts.jobId;
  if (
    !current &&
    liveSectionHold({
      src: opts.audio.currentSrc || opts.audio.src || "",
      ended: opts.audio.ended,
      resumeAt: Number.isFinite(opts.resumeAt) ? opts.resumeAt : 0,
      chosen,
      bufferedEnd: chosen ? left.bufferedEnd : 0,
    })
  ) {
    return { attached: false, url: null, complete: playlist.complete, transport: null };
  }
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
    dropSession(opts.audio, session);
    const left = departedAt.get(opts.audio);
    if (left && left.jobId !== opts.jobId) departedAt.delete(opts.audio);
    session = undefined;
  }
  if (!session) {
    const resumeAt = Number.isFinite(opts.resumeAt) ? Math.max(0, opts.resumeAt) : 0;
    const covered = playlistDurationSeconds(playlist.segments);
    if (leftBehind(opts.audio, opts.jobId, resumeAt, covered)) {
      return { attached: false, url: null, complete: playlist.complete, transport: null };
    }
    if (staleAttach(opts.audio, token)) return missed();
    const play = opts.play === true;
    const available = constructors();
    const nativeHls =
      typeof opts.audio.canPlayType === "function" &&
      opts.audio.canPlayType("application/vnd.apple.mpegurl") !== "";
    const transport = chooseLiveTransport({
      managed: Boolean(available.managed),
      managedMpeg: available.managed?.isTypeSupported?.("audio/mpeg") === true,
      mediaSource: Boolean(available.media),
      mediaSourceMpeg: available.media?.isTypeSupported?.("audio/mpeg") === true,
      nativeHls,
    });
    // Safari can play the playlist once it exists and lists a segment.
    // This call is already past that check. Chrome and Firefox stay on the
    // file they have.
    if (transport === "hls") {
      const previousSrc = opts.audio.src;
      opts.audio.src = opts.playlistUrl;
      if (staleAttach(opts.audio, token)) {
        opts.audio.src = previousSrc;
        return missed();
      }
      session = {
        jobId: opts.jobId,
        url: opts.playlistUrl,
        transport,
        appended: [],
        reserved: [],
        chain: Promise.resolve(),
        resumeAt,
        play,
        hold: false,
        resumed: false,
        watching: false,
        complete: playlist.complete,
        closed: false,
        revoked: false,
        previousSrc,
        segments: playlist.segments,
        playlistUrl: opts.playlistUrl,
        extending: false,
      };
      sessions.set(opts.audio, session);
      if (staleAttach(opts.audio, token)) {
        abandonStaleAttach(opts.audio, session, opts.playlistUrl, previousSrc);
        return missed();
      }
      clearDeparture(opts.audio, opts.jobId);
      watchResume(opts.audio, session);
      maybeResume(opts.audio, session);
      return {
        attached: true,
        url: session.url,
        complete: playlist.complete,
        transport: session.transport,
      };
    }
    if (transport !== "mms" && transport !== "mse") return missed();
    const Ctor = (transport === "mms" ? available.managed : available.media) as SourceCtor;
    const media = new Ctor();
    const url = URL.createObjectURL(media as unknown as MediaSource);
    if (staleAttach(opts.audio, token)) return missed();
    const previousSrc = opts.audio.src;
    const previousTime = Number.isFinite(opts.audio.currentTime) ? opts.audio.currentTime : 0;
    const keepPlaying = !opts.audio.paused && !opts.audio.ended;
    opts.audio.src = url;
    await waitOpen(media);
    if (staleAttach(opts.audio, token)) {
      abandonStaleAttach(opts.audio, undefined, url, previousSrc);
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already revoked */
      }
      return missed();
    }
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
      resumeAt,
      play,
      hold: false,
      resumed: false,
      watching: false,
      complete: false,
      closed: false,
      revoked: false,
      previousSrc,
      previousTime,
      keepPlaying,
      segments: playlist.segments,
      playlistUrl: opts.playlistUrl,
      extending: false,
    };
    sessions.set(opts.audio, session);
    if (staleAttach(opts.audio, token)) {
      abandonStaleAttach(opts.audio, session, url, previousSrc);
      return missed();
    }
    clearDeparture(opts.audio, opts.jobId);
    watchResume(opts.audio, session);
  } else if (staleAttach(opts.audio, token)) {
    return missed();
  } else {
    session.segments = playlist.segments;
    session.playlistUrl = opts.playlistUrl;
    if (!session.resumed) {
      session.resumeAt = Number.isFinite(opts.resumeAt) ? Math.max(0, opts.resumeAt) : 0;
      session.play = opts.play === true;
    }
  }
  watchAhead(opts.audio, session);
  if (session.transport === "hls") {
    maybeResume(opts.audio, session);
    if (!playlist.complete && mayRestart(session, listenerPaused, opts.play)) {
      resumeIfStalled(opts.audio, listenerPaused, false);
    }
    return {
      attached: true,
      url: session.url,
      complete: playlist.complete,
      transport: session.transport,
    };
  }
  const through = Math.max(
    Number.isFinite(opts.audio.currentTime) ? opts.audio.currentTime : 0,
    session.resumeAt
  );
  const next = pendingSegmentUris(
    session.reserved,
    segmentUrisAhead(playlist.segments, through + LIVE_AHEAD_SECONDS)
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
            const absolute = segmentFetchUrl(uri, opts.playlistUrl);
            const part = await fetch(absolute, {
              credentials: "same-origin",
              cache: "no-store",
              signal: AbortSignal.timeout(20_000),
            });
            if (staleAttach(opts.audio, token) || sessions.get(opts.audio) !== target) return;
            if (!part.ok) {
              releaseUnplayed(uri);
              return;
            }
            const bytes = new Uint8Array(await part.arrayBuffer());
            if (staleAttach(opts.audio, token) || sessions.get(opts.audio) !== target) return;
            await appendChunk(buffer, bytes, opts.audio);
            if (staleAttach(opts.audio, token) || sessions.get(opts.audio) !== target) return;
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
    if (staleAttach(opts.audio, token) || sessions.get(opts.audio) !== target) return missed();
    if (target.appended.length === 0) {
      // The playlist answered and the segment did not. Leave the section
      // file in place. The next poll can try the segment again.
      putSectionBack(opts.audio, target);
      return missed();
    }
  } else if (playlist.complete) {
    if (staleAttach(opts.audio, token) || sessions.get(opts.audio) !== target) return missed();
    markComplete(target, opts.audio);
  }
  if (staleAttach(opts.audio, token) || sessions.get(opts.audio) !== target) return missed();
  if (!playlist.complete && mayRestart(target, listenerPaused, opts.play)) {
    resumeIfStalled(opts.audio, listenerPaused, false);
  }
  maybeResume(opts.audio, target);
  return {
    attached: true,
    url: target.url,
    complete: playlist.complete,
    transport: target.transport,
  };
}
