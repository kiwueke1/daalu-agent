"""At-rest encryption round-trips and is bound to ``secret_key``."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from daalu_automation.core import crypto


def _use_key(monkeypatch: pytest.MonkeyPatch, key: str) -> None:
    monkeypatch.setattr(crypto, "get_settings", lambda: SimpleNamespace(secret_key=key))


def test_round_trip(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_key(monkeypatch, "k" * 48)
    token = crypto.encrypt_secret("super-secret-value")
    assert token != "super-secret-value"  # actually encrypted
    assert crypto.decrypt_secret(token) == "super-secret-value"


def test_ciphertext_does_not_decrypt_under_a_different_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_key(monkeypatch, "first-key-" + "a" * 40)
    token = crypto.encrypt_secret("device-password")

    # Rotating secret_key without re-encrypting must NOT silently succeed.
    _use_key(monkeypatch, "second-key-" + "b" * 40)
    with pytest.raises(ValueError):
        crypto.decrypt_secret(token)
