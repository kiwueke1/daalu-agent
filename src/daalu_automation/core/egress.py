"""Egress guard for agent-driven outbound HTTP (SSRF protection).

The ``call_external_api`` tool lets the LLM make HTTP requests to
operator-registered integrations. Alert/log content the model reads is
attacker-influenceable (prompt injection), so we keep those requests from
being steered at cloud-metadata / link-local endpoints — the classic SSRF
pivot to instance-credential theft.

Internal / RFC1918 targets are **allowed by default**: managing on-prem
network gear and internal services is a core use case here. An operator who
runs Daalu somewhere that should never reach its own private network can set
``external_api_block_private_networks=true`` to block those too.

Limitation: the check resolves the hostname and validates every returned
address, which closes the "name that resolves to 169.254.169.254" bypass, but
a determined DNS-rebinding attacker controlling an authoritative server could
still return a benign address here and a blocked one at connect time. The
approval gate and least-privilege integration credentials remain the primary
defenses; this is defense-in-depth on top.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

# Cloud instance-metadata endpoints — never a legitimate integration target.
# (Link-local detection already covers 169.254.169.254; listed explicitly so
# the rejection reason is unambiguous, and to name the IMDS IPv6 address.)
_METADATA_ADDRESSES = frozenset({"169.254.169.254", "fd00:ec2::254"})


class EgressBlocked(ValueError):
    """Raised when an outbound URL targets a disallowed address."""


def _ip_block_reason(
    ip: ipaddress.IPv4Address | ipaddress.IPv6Address, *, block_private: bool
) -> str | None:
    """Return a human reason if ``ip`` must not be reached, else ``None``."""
    if str(ip) in _METADATA_ADDRESSES:
        return "cloud metadata endpoint"
    if ip.is_link_local:  # 169.254.0.0/16, fe80::/10 — includes IMDS
        return "link-local address"
    if ip.is_loopback:  # 127.0.0.0/8, ::1
        return "loopback address"
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return "reserved address"
    # IPv4-mapped IPv6 (::ffff:a.b.c.d) — unwrap and re-check so a mapped
    # metadata/loopback address can't sneak past the classifiers above.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        return _ip_block_reason(mapped, block_private=block_private)
    if block_private and ip.is_private:
        return "private network address"
    return None


def check_external_url(url: str, *, block_private: bool = False) -> None:
    """Validate an outbound URL, raising :class:`EgressBlocked` if disallowed.

    Resolves the hostname and rejects the request if *any* resolved address is
    a metadata / link-local / loopback / reserved address (always), or a
    private address when ``block_private`` is set.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise EgressBlocked(f"scheme {parts.scheme or '(none)'!r} not allowed")
    host = parts.hostname
    if not host:
        raise EgressBlocked("URL has no host")

    candidates: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    try:
        # Literal IP host — no DNS lookup needed.
        candidates.append(ipaddress.ip_address(host))
    except ValueError:
        try:
            infos = socket.getaddrinfo(
                host, parts.port or None, proto=socket.IPPROTO_TCP
            )
        except socket.gaierror as e:
            raise EgressBlocked(f"could not resolve host {host!r}: {e}") from e
        for info in infos:
            try:
                candidates.append(ipaddress.ip_address(info[4][0]))
            except ValueError:
                continue
        if not candidates:
            raise EgressBlocked(f"host {host!r} resolved to no usable address")

    for ip in candidates:
        reason = _ip_block_reason(ip, block_private=block_private)
        if reason is not None:
            raise EgressBlocked(f"refusing to call {host!r} ({ip}): {reason}")
