from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _env_file() -> str:
    here = Path(__file__).resolve().parent.parent.parent
    root_env = here / ".env"
    if root_env.is_file():
        return str(root_env)
    return ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_env_file(), env_file_encoding="utf-8", extra="ignore")

    app_password: str = ""
    jwt_secret: str = ""

    database_url: str = "postgresql+asyncpg://privatedrop:privatedrop@localhost:5432/privatedrop"

    storage_path: str = "./data/storage"

    access_token_minutes: int = 15
    refresh_token_days: int = 30
    max_file_size: int = 5 * 1024 * 1024 * 1024
    upload_url_ttl_seconds: int = 900

    cors_origins: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
