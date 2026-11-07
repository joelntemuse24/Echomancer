"""Response headers for one Sowell render. Numbers only. No text."""

from __future__ import annotations


def _ms(seconds: object) -> str:
    try:
        value = float(seconds)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "0"
    if value < 0:
        value = 0.0
    return str(int(round(value * 1000)))


def timing_headers(report: dict) -> dict[str, str]:
    wall = float(report.get("wallSeconds") or 0)
    load = float(report.get("loadSeconds") or 0)
    infer = max(0.0, wall - load)
    return {
        "x-sowell-wall-ms": _ms(wall),
        "x-sowell-load-ms": _ms(load),
        "x-sowell-infer-ms": _ms(infer),
        "x-sowell-first-audio-ms": _ms(report.get("firstAudioSeconds")),
        "x-sowell-audio-ms": _ms(report.get("seconds")),
        "x-sowell-init": "1" if report.get("initializedThisCall") else "0",
        "x-sowell-chars": str(int(report.get("chars") or 0)),
    }
