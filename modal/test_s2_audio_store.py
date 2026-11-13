"""R2 offload for a wide clone batch. No network, no GPU."""

from datetime import datetime, timezone

import pytest

from s2_audio_store import (
    AudioStoreError,
    audio_fields,
    object_key,
    put_mp3,
    signed_put,
    transport_name,
)


def test_missing_credentials_stay_inline():
    assert transport_name({}) == "inline"
    assert transport_name({"R2_ACCOUNT_ID": "acct"}) == "inline"


def test_complete_credentials_use_r2():
    env = {
        "R2_ACCOUNT_ID": "acct",
        "R2_ACCESS_KEY_ID": "key",
        "R2_SECRET_ACCESS_KEY": "secret",
    }
    assert transport_name(env) == "r2"


def test_object_key_drops_path_characters():
    key = object_key("../job", "call/1", "row 2")
    assert key == "s2-takes/job/call1/row2.mp3"
    assert ".." not in key


def test_inline_row_keeps_audio_b64():
    row = audio_fields({}, "0", b"mp3-bytes", "job", "call")
    assert row["key"] == "0"
    assert "audio_b64" in row
    assert "storage_key" not in row


def test_r2_row_returns_a_key_and_not_the_mp3():
    seen = {}

    def opener(url, body, headers):
        seen["url"] = url
        seen["body"] = body
        seen["authorization"] = headers["Authorization"]

    env = {
        "R2_ACCOUNT_ID": "acct",
        "R2_ACCESS_KEY_ID": "AKIA_TEST",
        "R2_SECRET_ACCESS_KEY": "super-secret-value",
        "R2_BUCKET_NAME": "echomancer-audio",
    }
    row = audio_fields(env, "3", b"mp3-bytes", "job", "call", opener=opener)
    assert row["storage_key"] == "s2-takes/job/call/3.mp3"
    assert row["audio_bytes"] == len(b"mp3-bytes")
    assert "audio_b64" not in row
    assert seen["body"] == b"mp3-bytes"
    assert seen["url"].startswith("https://acct.r2.cloudflarestorage.com/")
    assert "super-secret-value" not in seen["url"]
    assert "super-secret-value" not in seen["authorization"]


def test_a_failed_put_does_not_inline_the_mp3():
    def opener(url, body, headers):
        raise OSError("down")

    env = {
        "R2_ACCOUNT_ID": "acct",
        "R2_ACCESS_KEY_ID": "key",
        "R2_SECRET_ACCESS_KEY": "secret",
    }
    row = audio_fields(env, "0", b"x" * 1000, "job", "call", opener=opener)
    assert row["error_code"] == "audio_store"
    assert "audio_b64" not in row


def test_signature_is_stable_and_covers_the_body():
    env = {
        "R2_ACCOUNT_ID": "acct",
        "R2_ACCESS_KEY_ID": "AKIA_TEST",
        "R2_SECRET_ACCESS_KEY": "secret",
        "R2_BUCKET_NAME": "echomancer-audio",
    }
    moment = datetime(2026, 11, 13, 12, 0, 0, tzinfo=timezone.utc)
    url, headers = signed_put(env, "s2-takes/job/call/0.mp3", b"mp3", moment)
    again, again_headers = signed_put(env, "s2-takes/job/call/0.mp3", b"mp3", moment)
    assert url == again
    assert headers["Authorization"] == again_headers["Authorization"]
    assert headers["Authorization"].startswith("AWS4-HMAC-SHA256 ")
    assert "auto/s3/aws4_request" in headers["Authorization"]
    changed, changed_headers = signed_put(env, "s2-takes/job/call/0.mp3", b"other", moment)
    assert changed == url
    assert changed_headers["Authorization"] != headers["Authorization"]


def test_put_mp3_wraps_transport_errors():
    env = {
        "R2_ACCOUNT_ID": "acct",
        "R2_ACCESS_KEY_ID": "key",
        "R2_SECRET_ACCESS_KEY": "secret",
    }
    with pytest.raises(AudioStoreError):
        put_mp3(env, "s2-takes/job/call/0.mp3", b"mp3", opener=lambda *_: (_ for _ in ()).throw(TimeoutError()))
