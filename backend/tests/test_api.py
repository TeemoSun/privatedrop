import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
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
    security._login_attempts.clear()
    security._revoked_jtis.clear()
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


async def test_logout_requires_auth_and_revokes(client: AsyncClient) -> None:
    tokens = await login(client)
    headers = auth_headers(tokens)

    resp = await client.post(
        "/api/auth/logout",
        json={"refresh_token": tokens["refresh_token"]},
    )
    assert resp.status_code in (401, 422)  # 无 token 不可登出

    resp = await client.post(
        "/api/auth/logout",
        json={"refresh_token": tokens["refresh_token"]},
        headers=headers,
    )
    assert resp.status_code == 204

    resp = await client.get("/api/devices", headers=headers)
    assert resp.status_code == 401  # access token 已吊销

    resp = await client.post(
        "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert resp.status_code == 401  # refresh token 已吊销


async def test_pagination_no_lost_items(client: AsyncClient) -> None:
    tokens = await login(client)
    headers = auth_headers(tokens)

    created_ids: list[str] = []
    for i in range(25):
        resp = await client.post(
            "/api/items", json={"kind": "note", "note": f"note-{i}"}, headers=headers
        )
        assert resp.status_code == 201
        created_ids.append(resp.json()["item_id"])
    for i in range(3):
        resp = await client.post(
            "/api/items",
            json={
                "kind": "file",
                "note": None,
                "files": [
                    {
                        "file_name": f"draft-{i}.txt",
                        "mime_type": "text/plain",
                        "size": 1,
                        "sha256": checksum_sha256(b"x"),
                    }
                ],
            },
            headers=headers,
        )
        assert resp.status_code == 201

    collected: list[str] = []
    cursor: str | None = None
    while True:
        params = {"limit": "10"}
        if cursor:
            params["cursor"] = cursor
        resp = await client.get("/api/items", params=params, headers=headers)
        assert resp.status_code == 200
        body = resp.json()
        collected.extend(i["id"] for i in body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert len(collected) == len(set(collected)) == 25  # 无重复、无遗漏（草稿被过滤）


async def test_spa_fallback_serves_index_for_deep_links(tmp_path, monkeypatch) -> None:
    import app.main as main

    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>spa</html>")
    (static / "app.js").write_text("console.log(1)")
    monkeypatch.setattr(main, "STATIC_DIR", static)

    spa_app = main.create_app()
    transport = ASGITransport(app=spa_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/devices")
        assert resp.status_code == 200
        assert resp.text == "<html>spa</html>"

        resp = await ac.get("/")
        assert resp.status_code == 200

        resp = await ac.get("/app.js")
        assert resp.status_code == 200
        assert resp.text == "console.log(1)"

        resp = await ac.get("/api/nonexistent")
        assert resp.status_code == 404


async def test_cleanup_preserves_notes_and_ready_files(client, monkeypatch) -> None:
    import app.cleanup as cleanup
    import app.models as models

    tokens = await login(client)
    headers = auth_headers(tokens)

    old_note = models.DropItem(kind="note", note="old note", created_by_device=tokens["device_id"])
    old_draft = models.DropItem(kind="file", note=None, created_by_device=tokens["device_id"])
    old_ready = models.DropItem(kind="file", note=None, created_by_device=tokens["device_id"])
    async with db_module.SessionLocal() as s:
        s.add_all([old_note, old_draft, old_ready])
        await s.flush()
        s.add(models.DropFile(item_id=old_draft.id, object_key=str(uuid.uuid4()), file_name="d.txt", mime_type="text/plain", size=1, sha256="0" * 64))
        s.add(models.DropFile(item_id=old_ready.id, object_key=str(uuid.uuid4()), file_name="r.txt", mime_type="text/plain", size=1, sha256="0" * 64, uploaded_at=datetime.now(timezone.utc)))
        await s.commit()

    old_ts = datetime.now(timezone.utc) - timedelta(hours=2)
    async with db_module.SessionLocal() as s:
        old_note = await s.merge(old_note)
        old_draft = await s.merge(old_draft)
        old_ready = await s.merge(old_ready)
        old_note.created_at = old_ts
        old_draft.created_at = old_ts
        old_ready.created_at = old_ts
        await s.commit()

    deleted_keys: list[str] = []
    monkeypatch.setattr(cleanup, "SessionLocal", db_module.SessionLocal)
    monkeypatch.setattr(
        "app.cleanup.storage.delete_object",
        lambda key: deleted_keys.append(key),
    )

    removed = await cleanup._cleanup_stale_drafts()
    assert removed == 1  # 只删除过期 file 草稿
    assert len(deleted_keys) == 1

    async with db_module.SessionLocal() as s:
        ids = [row[0] for row in (await s.execute(select(models.DropItem.id))).all()]
        assert old_note.id in ids  # 笔记绝不被清理
        assert old_ready.id in ids  # 已完成条目不被清理
        assert old_draft.id not in ids
