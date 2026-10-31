from typing import Optional
from supabase import Client, create_client
from app.core.config import settings

_supabase_client: Optional[Client] = None


def get_supabase_client() -> Optional[Client]:
    """Retrieve or initialize singleton Supabase service role client."""
    global _supabase_client
    if _supabase_client is None:
        if settings.SUPABASE_URL and settings.SUPABASE_SERVICE_ROLE_KEY:
            _supabase_client = create_client(
                settings.SUPABASE_URL,
                settings.SUPABASE_SERVICE_ROLE_KEY
            )
    return _supabase_client


def get_db() -> Optional[Client]:
    """FastAPI dependency for accessing Supabase client."""
    return get_supabase_client()
