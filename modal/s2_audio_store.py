"""Where a batch's MP3s go.

The deployed container returns every row as `audio_b64`. A 24-row page of
4,000-character sections is about 130 MiB of that JSON, past the 80 MiB
ceiling. This module uploads each MP3 to the same R2 bucket the worker
reads and returns a key instead. No R2 env means the row stays inline, which
is what the container running today does.

Two things here are about wall time, not correctness. A restored H100 is the
most expensive thing in the pipeline, and it sits idle while audio leaves the
box:

* **One TLS handshake per page, not one per row.** `KeepAlivePool` reuses warm
  `http.client` connections, so 24 rows cost at most a handful of handshakes
  instead of 24 serial `urlopen` calls. The connections outlive a call, so
  consecutive pages reuse them too.
* **Uploads overlap the next GPU batch.** `UploadPool` is a bounded thread pool
  that starts a section's PUT the moment its MP3 exists. Nothing on that path
  touches CUDA — the caller hands over plain `bytes` — so it stays clear of the
  GPU-owner-thread rule (see `s2_contract.GpuExecutor`).

A failed upload never silently falls back to base64: a row either carries the
audio inline, carries a key, or carries an error the caller can retry.

stdlib only, so `python3 -m pytest modal/test_s2_audio_store.py` needs no GPU.
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import queue
import re
import ssl
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable
from urllib.parse import quote

INLINE = "inline"
R2 = "r2"
_SAFE_PART = re.compile(r"[^A-Za-z0-9_-]")

#: HTTP statuses worth another attempt on a fresh socket. A 403 or 404 is the
#: request or the credentials and will fail identically every time.
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})
#: Sleep before attempt 2 and attempt 3. Short: the GPU is waiting on this.
RETRY_DELAYS_S = (0.2, 0.6)
#: Total attempts per object, including the first.
MAX_ATTEMPTS = 3
#: Warm sockets kept per host. A page is at most `S2C_MAX_BATCH_ITEMS` (32)
#: PUTs, so a pool this size serves a whole page without ever queueing.
POOL_SIZE = 16
#: CPU threads that may run MP3 → R2 at once. Independent of `POOL_SIZE`: a
#: connection is only held for the duration of one PUT, so a dozen workers
#: saturate the uplink without making the bucket see a burst it would throttle.
UPLOAD_WORKERS = 12


class AudioStoreError(RuntimeError):
    pass


def transport_name(env) -> str:
    account = (env.get("R2_ACCOUNT_ID") or "").strip()
    access = (env.get("R2_ACCESS_KEY_ID") or "").strip()
    secret = (env.get("R2_SECRET_ACCESS_KEY") or "").strip()
    if account and access and secret:
        return R2
    return INLINE


def object_key(job_id: str, call_id: str, item_key: str) -> str:
    def part(value: str, fallback: str) -> str:
        cleaned = _SAFE_PART.sub("", value or "")[:80]
        return cleaned or fallback

    return (
        f"s2-takes/{part(job_id, 'call')}/"
        f"{part(call_id, 'batch')}/{part(item_key, 'row')}.mp3"
    )


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def signed_put(
    env: dict,
    key: str,
    body: bytes,
    now: datetime | None = None,
) -> tuple[str, dict[str, str]]:
    """SigV4 PUT against the R2 S3 endpoint. Returns the URL and headers."""
    account = (env.get("R2_ACCOUNT_ID") or "").strip()
    access = (env.get("R2_ACCESS_KEY_ID") or "").strip()
    secret = (env.get("R2_SECRET_ACCESS_KEY") or "").strip()
    bucket = (env.get("R2_BUCKET_NAME") or "").strip() or "echomancer-audio"
    if not account or not access or not secret:
        raise AudioStoreError("R2 credentials are not set")
    moment = now or datetime.now(timezone.utc)
    amz_date = moment.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = moment.strftime("%Y%m%d")
    host = f"{account}.r2.cloudflarestorage.com"
    canonical_uri = "/" + bucket + "/" + quote(key, safe="/")
    payload_hash = hashlib.sha256(body).hexdigest()
    canonical_headers = (
        "content-type:audio/mpeg\n"
        f"host:{host}\n"
        f"x-amz-content-sha256:{payload_hash}\n"
        f"x-amz-date:{amz_date}\n"
    )
    signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join(
        [
            "PUT",
            canonical_uri,
            "",
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
    )
    scope = f"{date_stamp}/auto/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signing = _sign(
        _sign(_sign(_sign(("AWS4" + secret).encode("utf-8"), date_stamp), "auto"), "s3"),
        "aws4_request",
    )
    signature = hmac.new(signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    headers = {
        "Content-Type": "audio/mpeg",
        "Host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
        "Authorization": (
            "AWS4-HMAC-SHA256 "
            f"Credential={access}/{scope}, "
            f"SignedHeaders={signed_headers}, "
            f"Signature={signature}"
        ),
    }
    return f"https://{host}{canonical_uri}", headers


class _Retryable(Exception):
    """A failure on this socket that a fresh one may not repeat."""

    def __init__(self, reason: str, status: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


#: `(url, body, headers) -> None`. Raises on failure; the pool decides whether
#: that failure is retryable.
Opener = Callable[[str, bytes, dict[str, str]], None]


def _split_host(url: str) -> tuple[str, str]:
    """`https://host/path` -> (`host`, `/path`). No base path exists in R2."""
    without_scheme = url.split("://", 1)[1]
    head, _, tail = without_scheme.partition("/")
    return head, "/" + tail


class KeepAlivePool:
    """Warm TLS connections to one R2 host, shared by every upload.

    `urlopen` opens, handshakes, and closes a socket for every object. On a
    warm page that is 24–32 handshakes of pure idle GPU time. Here each PUT
    borrows a socket and returns it, so a page pays at most `POOL_SIZE`
    handshakes and the next page pays none.

    Thread-safe: `LifoQueue` hands out a socket to one worker at a time, and a
    socket that raised is discarded instead of being returned.
    """

    def __init__(
        self,
        *,
        timeout: float = 60.0,
        size: int = POOL_SIZE,
        connector: Callable[[str, float], http.client.HTTPSConnection] | None = None,
    ) -> None:
        self._timeout = timeout
        self._size = max(1, int(size))
        self._idle: queue.LifoQueue = queue.LifoQueue(maxsize=self._size)
        self._host = ""
        self._connector = connector or self._connect
        self._lock = threading.Lock()
        self._created = 0
        self._handshakes = 0
        self._reused = 0
        self._closed = False

    @staticmethod
    def _connect(host: str, timeout: float) -> http.client.HTTPSConnection:
        return http.client.HTTPSConnection(
            host, timeout=timeout, context=ssl.create_default_context()
        )

    # ── counters (reported in `performance`, asserted by tests) ─────────────

    @property
    def handshakes(self) -> int:
        """Connections actually opened. This is what a page used to cost per row."""
        return self._handshakes

    @property
    def reused(self) -> int:
        return self._reused

    def _borrow(self, host: str):
        with self._lock:
            if self._closed:
                raise AudioStoreError("audio store pool is closed")
            if not self._host:
                self._host = host
            elif host != self._host:
                # One pool is one host. A second account in the same process
                # would be a different bucket; refuse rather than send signed
                # headers to the wrong endpoint.
                raise AudioStoreError(f"pool is bound to {self._host}, not {host}")
        try:
            conn = self._idle.get_nowait()
            with self._lock:
                self._reused += 1
            return conn
        except queue.Empty:
            conn = self._connector(host, self._timeout)
            with self._lock:
                self._created += 1
                self._handshakes += 1
            return conn

    def _release(self, conn) -> None:
        if self._closed:
            try:
                conn.close()
            except Exception:
                pass
            return
        try:
            self._idle.put_nowait(conn)
        except queue.Full:
            try:
                conn.close()
            except Exception:
                pass

    @staticmethod
    def _discard(conn) -> None:
        try:
            conn.close()
        except Exception:
            pass

    def put(self, url: str, body: bytes, headers: dict[str, str]) -> None:
        """One PUT, retried on a fresh socket when the failure is transient."""
        host, path = _split_host(url)
        last: Exception | None = None
        for attempt in range(MAX_ATTEMPTS):
            conn = self._borrow(host)
            try:
                conn.request("PUT", path, body=body, headers=headers)
                response = conn.getresponse()
                response.read()
                if 200 <= response.status < 300:
                    self._release(conn)
                    return
                self._discard(conn)
                if response.status in RETRYABLE_STATUS:
                    last = _Retryable(f"HTTP {response.status}", response.status)
                else:
                    raise AudioStoreError(f"R2 put failed: HTTP {response.status}")
            except AudioStoreError:
                raise
            except _Retryable as err:  # from a custom opener
                self._discard(conn)
                last = err
            except Exception as err:  # socket-level: reset, timeout, TLS, truncated
                self._discard(conn)
                last = err
            if attempt + 1 < MAX_ATTEMPTS:
                _sleep(RETRY_DELAYS_S[min(attempt, len(RETRY_DELAYS_S) - 1)])
        raise AudioStoreError(f"R2 put failed after {MAX_ATTEMPTS} attempts: {last}")

    def close(self) -> None:
        self._closed = True
        while True:
            try:
                conn = self._idle.get_nowait()
            except queue.Empty:
                return
            self._discard(conn)

    def __enter__(self) -> "KeepAlivePool":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def _sleep(seconds: float) -> None:
    import time

    if seconds > 0:
        time.sleep(seconds)


def put_mp3(
    env: dict,
    key: str,
    body: bytes,
    opener: Opener | None = None,
    now: datetime | None = None,
    pool: KeepAlivePool | None = None,
) -> None:
    """Upload one object, reusing `pool` when given.

    `opener` is the injection point the tests use; without it the PUT goes over
    a pooled keep-alive connection and is retried on a transient failure.
    """
    url, headers = signed_put(env, key, body, now)
    if opener is not None:
        send = _retrying(opener)
    elif pool is not None:
        send = pool.put
    else:
        with KeepAlivePool() as fresh:
            fresh.put(url, body, headers)
        return
    try:
        send(url, body, headers)
    except AudioStoreError:
        raise
    except Exception as err:
        raise AudioStoreError("R2 put failed") from err


def _retrying(send: Opener) -> Opener:
    """Retry a custom opener the same way the pooled path retries."""

    def call(url: str, body: bytes, headers: dict[str, str]) -> None:
        last: Exception | None = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                send(url, body, headers)
                return
            except AudioStoreError:
                raise
            except Exception as err:
                last = err
            if attempt + 1 < MAX_ATTEMPTS:
                _sleep(RETRY_DELAYS_S[min(attempt, len(RETRY_DELAYS_S) - 1)])
        raise AudioStoreError(f"R2 put failed after {MAX_ATTEMPTS} attempts") from last

    return call


class UploadPool:
    """Bounded concurrent MP3 → R2 uploads for one batch call.

    The caller submits as soon as a section's MP3 exists, so the upload of the
    first section overlaps the encode of the rest (and, on a streamed call, the
    GPU decode of the following batch). `results()` collects them in call order.

    Every worker thread here is a plain CPU thread that only ever sees `bytes`
    and `dict`s. It never touches a CUDA handle, which is what keeps it clear
    of the GPU-owner-thread rule.
    """

    def __init__(
        self,
        env,
        *,
        workers: int = UPLOAD_WORKERS,
        pool: KeepAlivePool | None = None,
        opener: Opener | None = None,
    ) -> None:
        self.env = env
        self.transport = transport_name(env)
        self._opener = opener
        self._pool = pool if pool is not None else (
            KeepAlivePool() if self.transport == R2 else None
        )
        self._executor = ThreadPoolExecutor(
            max_workers=max(1, int(workers)), thread_name_prefix="s2-r2-put"
        )
        self._closed = False

    def submit(self, item_key: str, mp3: bytes, job_id: str, call_id: str) -> Future:
        return self._executor.submit(
            audio_fields,
            self.env,
            item_key,
            mp3,
            job_id,
            call_id,
            self._opener,
            None,
            self._pool,
        )

    def fields(self, item_key: str, mp3: bytes, job_id: str, call_id: str) -> dict:
        """Synchronous upload on the calling thread (the streaming fallback)."""
        return audio_fields(
            self.env, item_key, mp3, job_id, call_id, self._opener, None, self._pool
        )

    @property
    def handshakes(self) -> int:
        """Connections this batch opened. Inline transport opens none."""
        return self._pool.handshakes if self._pool is not None else 0

    @property
    def reused_connections(self) -> int:
        return self._pool.reused if self._pool is not None else 0

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._executor.shutdown(wait=True)

    def __enter__(self) -> "UploadPool":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def audio_fields(
    env: dict,
    item_key: str,
    mp3: bytes,
    job_id: str,
    call_id: str,
    opener: Opener | None = None,
    now: datetime | None = None,
    pool: KeepAlivePool | None = None,
    forced: str | None = None,
) -> dict:
    """Fields for one batch row. A failed upload does not fall back to base64.

    `forced="inline"` answers base64 for a diagnostic call even on a container
    that has R2 credentials. It is used by the runbook's single-command curl
    check, which then needs no local R2 reader.
    """
    import base64

    transport = forced or transport_name(env)
    if transport != R2:
        return {"key": item_key, "audio_b64": base64.b64encode(mp3).decode()}
    key = object_key(job_id, call_id, item_key)
    try:
        put_mp3(env, key, mp3, opener=opener, now=now, pool=pool)
    except AudioStoreError as err:
        return {
            "key": item_key,
            "error": str(err),
            "error_code": "audio_store",
        }
    return {
        "key": item_key,
        "storage_key": key,
        "audio_bytes": len(mp3),
    }
