"""How the app addresses a Modal endpoint.

Modal serves each `@modal.fastapi_endpoint` at the **root of its own hostname**
(`https://<workspace>--<app>-<fn>.modal.run`), not under a shared path prefix.
So `https://…/synthesize_batch` plus `/ready` is not a thing: they are two
different hosts. The old client appended `/synthesize_batch` and `/ready` to one
URL, which 404s against a real deploy even though it passes a mocked test that
fakes those exact paths.

This module keeps that rule in one place, stdlib-only, so both the Python tools
and the Vitest suite can assert on it.
"""

from __future__ import annotations


class EndpointUrlError(ValueError):
    """The configured URL cannot be used to reach a Modal endpoint."""


def normalize_endpoint_url(raw: str | None, *, label: str) -> str:
    """Return a bare origin for one endpoint, or raise.

    A Modal endpoint URL is a host, optionally with a trailing slash. Anything
    with a path beyond `/` is a mistake a human made by pasting a full function
    URL from the dashboard (which includes `/modal_web_endpoint` style tails) or
    by appending our own route on top. Rejecting it here is much cheaper than a
    404 in production.
    """
    text = (raw or "").strip()
    if not text:
        raise EndpointUrlError(f"{label} is not configured")
    if not text.startswith(("http://", "https://")):
        raise EndpointUrlError(f"{label} must be an absolute http(s) URL, got {text!r}")
    from urllib.parse import urlsplit

    parts = urlsplit(text)
    if not parts.netloc:
        raise EndpointUrlError(f"{label} has no host: {text!r}")
    path = parts.path.rstrip("/")
    if path:
        raise EndpointUrlError(
            f"{label} must be a bare Modal endpoint host, but it has path "
            f"{parts.path!r}. Each @modal.fastapi_endpoint is served at its own "
            "hostname root; configure one URL per endpoint instead of appending "
            "a route."
        )
    if parts.query or parts.fragment:
        raise EndpointUrlError(f"{label} must not carry a query or fragment: {text!r}")
    return f"{parts.scheme}://{parts.netloc}"


def endpoint_kind(url: str, *, app_name: str = "") -> str:
    """Best-effort label for a Modal endpoint URL, for logs and errors.

    Modal hostnames look like `<workspace>--<app>-<function>[-<env>].modal.run`
    (function names have underscores replaced by dashes). This is only used to
    make a log line or an error readable; it never decides routing.
    """
    from urllib.parse import urlsplit

    host = urlsplit(url).netloc.split(":")[0]
    if not host.endswith(".modal.run"):
        return "custom"
    label = host[: -len(".modal.run")]
    prefix = f"{app_name}-" if app_name and f"--{app_name}-" in label else ""
    if prefix:
        label = label.split(f"--{app_name}-", 1)[1]
    elif "--" in label:
        label = label.split("--", 1)[1]
    for kind in ("synthesize-batch", "synthesize", "ready"):
        if label == kind or label.startswith(f"{kind}-"):
            return kind
    return label or "unknown"


def endpoints_from_env(env) -> dict:
    """Resolve the three endpoint origins the worker needs.

    Two variables are required and one is derived:

    - `MODAL_S2_TTS_URL`   the `synthesize_batch` endpoint host
    - `MODAL_S2_READY_URL` the `ready` endpoint host (different host!)
    - the single-section `synthesize` host is only needed by the per-section
      path, so `MODAL_S2_SYNTHESIZE_URL` is optional and falls back to the batch
      host when unset (a deploy that exposes both on one function, or a test).

    `ready` is deliberately *not* derived from the batch URL: deriving it is the
    bug this replaces.
    """
    batch = normalize_endpoint_url(env.get("MODAL_S2_TTS_URL"), label="MODAL_S2_TTS_URL")
    single_raw = (env.get("MODAL_S2_SYNTHESIZE_URL") or "").strip()
    single = (
        normalize_endpoint_url(single_raw, label="MODAL_S2_SYNTHESIZE_URL")
        if single_raw
        else batch
    )
    ready_raw = (env.get("MODAL_S2_READY_URL") or "").strip()
    ready = (
        normalize_endpoint_url(ready_raw, label="MODAL_S2_READY_URL")
        if ready_raw
        else None
    )
    if ready and ready == batch:
        raise EndpointUrlError(
            "MODAL_S2_READY_URL points at the synthesize host. The ready probe is "
            "a separate @modal.fastapi_endpoint with its own hostname."
        )
    return {"batch": batch, "single": single, "ready": ready}
