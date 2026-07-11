"""Runtime settings (env-driven, pydantic-settings)."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ITSM_", env_file=".env", extra="ignore")

    port: int = 19753
    # CORS origin allowlist (comma-separated exact origins). Empty (the default)
    # = dev-only permissive WITHOUT credentials (≈ `*` for non-credentialed
    # reads; inert for credentialed — never widens the cookie surface, so the
    # same-origin session cookie is never exposed cross-origin). For any
    # non-localhost deployment, set ITSM_CORS_ORIGINS to enable credentialed
    # cross-origin. NEVER set allow_origins=["*"] with allow_credentials=True —
    # Starlette special-cases that into reflecting ANY origin WITH credentials.
    cors_origins: str = ""


settings = Settings()
