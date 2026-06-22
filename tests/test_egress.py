"""The SSRF egress guard blocks metadata/link-local while allowing real hosts."""

from __future__ import annotations

import pytest

from daalu_automation.core.egress import EgressBlocked, check_external_url


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",  # AWS/GCP IMDS
        "http://[fe80::1]/x",  # IPv6 link-local
        "http://127.0.0.1:8000/admin",  # loopback
        "http://localhost/x",  # resolves to loopback
        "http://[::1]/x",  # IPv6 loopback
        "http://0.0.0.0/x",  # unspecified
        "http://[::ffff:169.254.169.254]/x",  # IPv4-mapped IMDS
    ],
)
def test_dangerous_targets_are_blocked(url: str) -> None:
    with pytest.raises(EgressBlocked):
        check_external_url(url)


@pytest.mark.parametrize("url", ["ftp://example.com/x", "file:///etc/passwd", "//host/x"])
def test_non_http_schemes_are_blocked(url: str) -> None:
    with pytest.raises(EgressBlocked):
        check_external_url(url)


@pytest.mark.parametrize("url", ["http://8.8.8.8/", "https://93.184.216.34/path"])
def test_public_addresses_are_allowed(url: str) -> None:
    check_external_url(url)  # does not raise


def test_private_allowed_by_default_blocked_when_opted_in() -> None:
    private = "http://10.0.0.5:8080/api"
    # On-prem device management is a core use case → allowed by default.
    check_external_url(private)
    # Operators can lock it down.
    with pytest.raises(EgressBlocked):
        check_external_url(private, block_private=True)
