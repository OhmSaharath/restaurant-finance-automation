"""Shared slowapi rate-limiter singleton.

Centralized in one module so ``main.py`` (which installs the
``SlowAPIMiddleware`` and binds ``app.state.limiter``) and route modules (which
apply explicit per-route ``@limiter.limit(...)`` decorators) import the SAME
``Limiter`` instance. Keeping the default limits identical to the previous
inline definition in ``main.py`` preserves runtime behavior exactly.
"""
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import settings

limiter = Limiter(
    key_func=get_remote_address,
    default_limits=[settings.RATE_LIMIT_PER_MINUTE],
)