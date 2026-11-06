"""How the app (and these tools) address a Modal endpoint.

Modal serves each `@modal.fastapi_endpoint` at the **root of its own hostname**.
The old contract — one base URL plus `/synthesize_batch` and `/ready` — 404s
against a real deploy, while a mocked fetch that fakes those exact paths passes.
So the rule is tested here rather than assumed.
"""

from __future__ import annotations

import pytest

from s2_endpoints import (
    EndpointUrlError,
    endpoint_kind,
    endpoints_from_env,
    normalize_endpoint_url,
)


class TestNormalize:
    def test_accepts_a_bare_modal_host(self):
        url = "https://acme--echomancer-s2-clone-synthesize-batch.modal.run"
        assert normalize_endpoint_url(url, label="X") == url

    def test_strips_a_trailing_slash(self):
        url = "https://acme--app-synthesize.modal.run"
        assert normalize_endpoint_url(f"{url}/", label="X") == url
        assert normalize_endpoint_url(f"{url}///", label="X") == url

    def test_rejects_an_empty_value_by_name(self):
        with pytest.raises(EndpointUrlError, match="MODAL_S2_TTS_URL"):
            normalize_endpoint_url("", label="MODAL_S2_TTS_URL")
        with pytest.raises(EndpointUrlError, match="MODAL_S2_TTS_URL"):
            normalize_endpoint_url(None, label="MODAL_S2_TTS_URL")

    def test_rejects_a_path_because_each_endpoint_is_its_own_host(self):
        # This is the exact historical bug: appending our own route.
        with pytest.raises(EndpointUrlError, match="bare Modal endpoint host"):
            normalize_endpoint_url(
                "https://acme--app-synthesize.modal.run/synthesize_batch",
                label="MODAL_S2_TTS_URL",
            )

    def test_rejects_a_query_or_fragment(self):
        with pytest.raises(EndpointUrlError, match="query or fragment"):
            normalize_endpoint_url(
                "https://acme--app-ready.modal.run?x=1", label="MODAL_S2_READY_URL"
            )

    def test_rejects_a_relative_url(self):
        with pytest.raises(EndpointUrlError, match="absolute"):
            normalize_endpoint_url("app.modal.run/ready", label="X")


class TestEndpointKind:
    def test_labels_the_three_endpoints(self):
        base = "https://acme--echomancer-s2-clone"
        assert (
            endpoint_kind(
                f"{base}-synthesize-batch.modal.run", app_name="echomancer-s2-clone"
            )
            == "synthesize-batch"
        )
        assert (
            endpoint_kind(f"{base}-synthesize.modal.run", app_name="echomancer-s2-clone")
            == "synthesize"
        )
        assert (
            endpoint_kind(f"{base}-ready.modal.run", app_name="echomancer-s2-clone")
            == "ready"
        )

    def test_falls_back_to_the_host_label(self):
        assert endpoint_kind("https://example.com") == "custom"
        assert endpoint_kind("https://acme--other-app.modal.run") == "other-app"


class TestEndpointsFromEnv:
    def test_requires_the_batch_host(self):
        with pytest.raises(EndpointUrlError, match="MODAL_S2_TTS_URL"):
            endpoints_from_env({})

    def test_ready_is_its_own_host_and_is_not_derived(self):
        batch = "https://acme--app-synthesize-batch.modal.run"
        ready = "https://acme--app-ready.modal.run"
        got = endpoints_from_env({"MODAL_S2_TTS_URL": batch, "MODAL_S2_READY_URL": ready})
        assert got["batch"] == batch
        assert got["ready"] == ready
        assert got["single"] == batch  # falls back to the batch host

    def test_refuses_a_ready_url_pointing_at_the_batch_host(self):
        batch = "https://acme--app-synthesize-batch.modal.run"
        with pytest.raises(EndpointUrlError, match="separate @modal.fastapi_endpoint"):
            endpoints_from_env({"MODAL_S2_TTS_URL": batch, "MODAL_S2_READY_URL": batch})

    def test_single_section_host_is_optional(self):
        batch = "https://acme--app-synthesize-batch.modal.run"
        single = "https://acme--app-synthesize.modal.run"
        got = endpoints_from_env(
            {"MODAL_S2_TTS_URL": batch, "MODAL_S2_SYNTHESIZE_URL": single}
        )
        assert got["single"] == single
        assert got["batch"] == batch
        assert got["ready"] is None

    def test_no_ready_configured_means_no_probe(self):
        got = endpoints_from_env(
            {"MODAL_S2_TTS_URL": "https://acme--app-synthesize-batch.modal.run"}
        )
        assert got["ready"] is None
