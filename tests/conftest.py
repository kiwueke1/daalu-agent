"""Shared pytest setup.

Several modules call ``get_settings()`` at import time (e.g. ``database.py``),
and the settings guard refuses to construct with the placeholder ``SECRET_KEY``
when authentication is enabled. Provide a test-only key + single-operator mode
so importing the app under test doesn't require a real ``.env``. ``setdefault``
keeps any value a developer set in their own environment.
"""

from __future__ import annotations

import os

os.environ.setdefault("SECRET_KEY", "test-secret-key-" + "0" * 32)
os.environ.setdefault("LOCAL_NO_AUTH", "true")
os.environ.setdefault("ENVIRONMENT", "development")
