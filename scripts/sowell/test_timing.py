"""Header numbers only. Does not load Kokoro."""

from timing import timing_headers


def test_warm_call_splits_load_from_inference():
    headers = timing_headers(
        {
            "wallSeconds": 12.116,
            "loadSeconds": 0,
            "firstAudioSeconds": 7.944,
            "seconds": 38.125,
            "initializedThisCall": False,
            "chars": 719,
            "spokenWords": 144,
        }
    )
    assert headers["x-sowell-infer-ms"] == "12116"
    assert headers["x-sowell-load-ms"] == "0"
    assert headers["x-sowell-init"] == "0"
    assert headers["x-sowell-audio-ms"] == "38125"
    assert "144" not in "".join(headers.values())


def test_cold_call_marks_init_and_subtracts_the_load():
    headers = timing_headers(
        {
            "wallSeconds": 15.515,
            "loadSeconds": 3.4,
            "firstAudioSeconds": 7.958,
            "seconds": 38.125,
            "initializedThisCall": True,
            "chars": 719,
        }
    )
    assert headers["x-sowell-init"] == "1"
    assert headers["x-sowell-load-ms"] == "3400"
    assert headers["x-sowell-infer-ms"] == "12115"
