from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_password: str = ""
    jwt_secret: str = ""

    database_url: str = "postgresql+asyncpg://privatedrop:privatedrop@localhost:5432/privatedrop"

    minio_endpoint: str = "localhost:9000"
    minio_root_user: str = "minioadmin"
    minio_root_password: str = "minioadmin"
    minio_bucket: str = "privatedrop"
    minio_secure: bool = False

    access_token_minutes: int = 15
    refresh_token_days: int = 30
    max_file_size: int = 5 * 1024 * 1024 * 1024
    upload_url_ttl_seconds: int = 900

    cors_origins: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
