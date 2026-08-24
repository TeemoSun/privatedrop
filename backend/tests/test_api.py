import hashlib
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

os.environ.setdefault("APP_PASSWORD", "test-password-123")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-456")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite://")
os.environ.setdefault("MAX_FILE_SIZE", "10485760")
os.environ.setdefault("MINIO_ENDPOINT", "localhost:9000")
os.environ.setdefault("MINIO_ROOT_USER", "minioadmin")
os.environ.setdefault("MINIO_ROOT_PASSWORD", "minioadmin")

import app.db as db_module  # noqa: E402
import app.models as models  # noqa: E402
import app.security as security  # noqa: E402
from app.storage import checksum_sha256  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _password_hash() -> None:
    security.APP_PASSWORD_HASH = security.hash_password("test-password-123")


@pytest_asyncio.fixture
async def session() -> None:
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.create_all)
    db_module.SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
    yield
    await engine.dispose()


@pytest_asyncio.fixture
async def client(session, monkeypatch) -> AsyncClient:
    from datetime import datetime, timezone

    from app.main import app

    monkeypatch.setattr(
        "app.api.items.sign_upload_url",
        lambda key, disposition, checksum, content_type: (
            f"http://minio.test/upload/{key}",
            datetime.now(timezone.utc),
        ),
    )
    monkeypatch.setattr("app.api.items.head_object", lambda key: None)
    monkeypatch.setattr(
        "app.api.items.sign_download_url",
        lambda key: (f"http://minio.test/download/{key}", datetime.now(timezone.utc)),
    )
    monkeypatch.setattr("app.api.items.delete_object", lambda key: None)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def login(client: AsyncClient) -> dict:
    device_id = uuid.uuid4()
    resp = await client.post(
        "/api/auth/login",
        json={"password": "test-password-123", "device_id": str(device_id), "device_name": "pytest"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    return {
        "device_id": device_id,
        "access_token": data["access_token"],
        "refresh_token": data["refresh_token"],
    }


def auth_headers(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def test_login_and_reauth(client: AsyncClient) -> None:
    tokens = await login(client)
    assert tokens["access_token"]
    assert tokens["refresh_token"]

    resp = await client.post(
        "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["device_id"] == str(tokens["device_id"])

    resp = await client.post(
        "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert resp.status_code == 401


async def test_login_wrong_password(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/auth/login",
        json={
            "password": "wrong",
            "device_id": str(uuid.uuid4()),
            "device_name": "pytest",
        },
    )
    assert resp.status_code == 401


async def test_notes_flow(client: AsyncClient) -> None:
    tokens = await login(client)
    headers = auth_headers(tokens)

    resp = await client.post(
        "/api/items", json={"kind": "note", "note": "hello world"}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    item_id = resp.json()["item_id"]

    resp = await client.get("/api/items?limit=10", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["items"]) == 1
    assert body["items"][0]["kind"] == "note"
    assert body["items"][0]["note"] == "hello world"

    resp = await client.delete(f"/api/items/{item_id}", headers=headers)
    assert resp.status_code == 204

    resp = await client.get("/api/items?limit=10", headers=headers)
    assert resp.json()["items"] == []


async def test_file_item_draft_hidden_until_complete(client: AsyncClient) -> None:
    tokens = await login(client)
    headers = auth_headers(tokens)

    content = b"hello privatedrop"
    resp = await client.post(
        "/api/items",
        json={
            "kind": "file",
            "note": None,
            "files": [
                {
                    "file_name": "hello.txt",
                    "mime_type": "text/plain",
                    "size": len(content),
                    "sha256": checksum_sha256(content),
                }
            ],
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    item_id = resp.json()["item_id"]
    file_id = resp.json()["files"][0]["file_id"]

    resp = await client.get("/api/items?limit=10", headers=headers)
    assert resp.json()["items"] == []

    resp = await client.post(f"/api/items/{item_id}/upload-complete", headers=headers)
    assert resp.status_code == 409  # 未上传对象

    resp = await client.get(f"/api/items/{item_id}/files/{file_id}/download-url", headers=headers)
    assert resp.status_code == 409  # 未就绪不可下载

    resp = await client.delete(f"/api/items/{item_id}", headers=headers)
    assert resp.status_code == 204


async def test_devices_flow(client: AsyncClient) -> None:
    tokens = await login(client)
    headers = auth_headers(tokens)

    resp = await client.get("/api/devices", headers=headers)
    assert resp.status_code == 200
    devices = resp.json()
    assert len(devices) == 1
    device_id = devices[0]["id"]

    resp = await client.patch(f"/api/devices/{device_id}", json={"name": "renamed"}, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["name"] == "renamed"

    resp = await client.delete(f"/api/devices/{device_id}", headers=headers)
    assert resp.status_code == 204

    resp = await client.post(
        "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert resp.status_code == 401  # 设备删除后 refresh 失效
