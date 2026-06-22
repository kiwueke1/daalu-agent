"""The SECRET_KEY guard fails closed where a forgeable key would matter."""

from __future__ import annotations

import warnings

import pytest
from pydantic import ValidationError

from daalu_automation.config import Settings, _is_insecure_secret_key

REAL_KEY = "a" * 48


@pytest.mark.parametrize(
    "value",
    ["", "   ", "change-me", "change-me-to-a-long-random-string"],
)
def test_placeholder_keys_are_insecure(value: str) -> None:
    assert _is_insecure_secret_key(value) is True


@pytest.mark.parametrize("value", [REAL_KEY, "x7f2-not-a-placeholder"])
def test_real_keys_are_ok(value: str) -> None:
    assert _is_insecure_secret_key(value) is False


def test_default_key_with_auth_enabled_is_rejected() -> None:
    # local_no_auth=False means auth is on → a default key forges JWTs.
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            secret_key="change-me",
            local_no_auth=False,
            environment="development",
        )


def test_default_key_in_production_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            secret_key="change-me-to-a-long-random-string",
            local_no_auth=True,
            environment="production",
        )


def test_default_key_in_local_no_auth_dev_only_warns() -> None:
    # Single-operator laptop mode: tokens aren't issued, so we warn, not raise.
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        Settings(
            _env_file=None,
            secret_key="change-me",
            local_no_auth=True,
            environment="development",
        )
    assert any("SECRET_KEY" in str(w.message) for w in caught)


def test_real_key_with_production_auth_is_accepted() -> None:
    s = Settings(
        _env_file=None,
        secret_key=REAL_KEY,
        local_no_auth=False,
        environment="production",
    )
    assert s.secret_key == REAL_KEY
