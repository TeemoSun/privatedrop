import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config as AlembicConfig
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.api import auth, devices, items, maintenance, ws
from app.cleanup import cleanup_job
from app.config import settings
from app.security import hash_password
from app import security as security_module
from app.storage import ensure_storage_dirs

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
ALEMBIC_INI = BASE_DIR.parent / "alembic.ini"
ALEMBIC_DIR = BASE_DIR.parent / "alembic"

scheduler = AsyncIOScheduler()

_PLACEHOLDERS = {"", "admin", "change-me", "changeme", "password", "secret"}


def validate_secrets() -> None:
    problems: list[str] = []
    pwd = settings.app_password.strip()
    if not pwd or pwd.lower() in _PLACEHOLDERS:
        problems.append("APP_PASSWORD must be set to a non-placeholder value")
    elif len(pwd) < 6:
        problems.append("APP_PASSWORD must be at least 6 characters long")

    secret = settings.jwt_secret.strip()
    if not secret or secret.lower() in _PLACEHOLDERS:
        problems.append("JWT_SECRET must be set to a non-placeholder value")
    elif len(secret) < 16:
        problems.append("JWT_SECRET must be at least 16 characters long")

    if problems:
        raise RuntimeError("invalid startup configuration:\n  - " + "\n  - ".join(problems))


async def run_migrations() -> None:
    cfg = AlembicConfig(str(ALEMBIC_INI))
    cfg.set_main_option("script_location", str(ALEMBIC_DIR))
    cfg.set_main_option("sqlalchemy.url", settings.database_url)
    await asyncio.to_thread(command.upgrade, cfg, "head")


@asynccontextmanager
async def lifespan(app: FastAPI):
    validate_secrets()
    ensure_storage_dirs()
    await run_migrations()
    security_module.APP_PASSWORD_HASH = hash_password(settings.app_password)
    scheduler.add_job(cleanup_job, "interval", minutes=10)
    scheduler.start()
    logger.info("privatedrop started")
    yield
    scheduler.shutdown(wait=False)


def create_app() -> FastAPI:
    app = FastAPI(title="PrivateDrop", lifespan=lifespan)

    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(auth.router)
    app.include_router(devices.router)
    app.include_router(items.router)
    app.include_router(maintenance.router)
    app.include_router(ws.router)

    if STATIC_DIR.is_dir():

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa_fallback(full_path: str):
            if full_path.startswith("api/"):
                raise HTTPException(status_code=404)
            candidate = (STATIC_DIR / full_path).resolve()
            if candidate.is_file() and STATIC_DIR in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(STATIC_DIR / "index.html")

    return app


app = create_app()
