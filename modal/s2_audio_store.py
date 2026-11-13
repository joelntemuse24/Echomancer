"""Where a batch's MP3s go.

The deployed container returns every row as `audio_b64`. A 24-row page of
4,000-character sections is about 130 MiB of that JSON, past the 80 MiB
ceiling. This module uploads each MP3 to the same R2 bucket the worker
reads and returns a key instead. No R2 env means the row stays inline, which
is what the container running today does.

stdlib only, so `python3 -m pytest modal/test_s2_audio_store.py` needs no GPU.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from datetime import datetime, timezone
from typing import Callable
from urllib.parse import quote

INLINE = "inline"
R2 = "r2"
_SAFE_PART = re.compile(r"[^A-Za-z0-9_-]")


class AudioStoreError(RuntimeError):
    pass


def transport_name(env: dict) -> str:
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


Opener = Callable[[str, bytes, dict[str, str]], None]


def put_mp3(
    env: dict,
    key: str,
    body: bytes,
    opener: Opener | None = None,
    now: datetime | None = None,
) -> None:
    url, headers = signed_put(env, key, body, now)
    send = opener or _urlopen_put
    try:
        send(url, body, headers)
    except AudioStoreError:
        raise
    except Exception as err:
        raise AudioStoreError("R2 put failed") from err


def _urlopen_put(url: str, body: bytes, headers: dict[str, str]) -> None:
    import urllib.request

    request = urllib.request.Request(url, data=body, headers=headers, method="PUT")
    with urllib.request.urlopen(request, timeout=60) as response:
        response.read()


def audio_fields(
    env: dict,
    item_key: str,
    mp3: bytes,
    job_id: str,
    call_id: str,
    opener: Opener | None = None,
) -> dict:
    """Fields for one batch row. A failed upload does not fall back to base64."""
    import base64

    if transport_name(env) != R2:
        return {"key": item_key, "audio_b64": base64.b64encode(mp3).decode()}
    key = object_key(job_id, call_id, item_key)
    try:
        put_mp3(env, key, mp3, opener=opener)
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
