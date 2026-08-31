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
os.environ.setdefault("STORAGE_PATH", "./data/test_storage")

import app.db as db_module  # noqa: E402
import app.models as models  # noqa: E402
import app.security as security  # noqa: E402
import app.storage as storage_module  # noqa: E402
from app.config import settings  # noqa: E402
from app.storage import checksum_sha256  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _password_hash() -> None:
    security.APP_PASSWORD_HASH = security.hash_password("test-password-123")


@pytest_asyncio.fixture
async def session(tmp_path, monkeypatch) -> None:
    test_storage = tmp_path / "storage"
    monkeypatch.setattr(settings, "storage_path", str(test_storage))
    storage_module.ensure_storage_dirs()

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
async def client(session) -> AsyncClient:
    from app.main import app

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


async def test_file_item_upload_download_and_deduplication(client: AsyncClient) -> None:
    tokens = await login(client)
    headers = auth_headers(tokens)

    content = b"hello privatedrop content addressable storage test"
    content_sha = checksum_sha256(content)

    # 1. Create file item
    resp = await client.post(
        "/api/items",
        json={
            "kind": "file",
            "note": "test file 1",
            "files": [
                {
                    "file_name": "test.txt",
                    "mime_type": "text/plain",
                    "size": len(content),
                    "sha256": content_sha,
                }
            ],
        },
        headers=headers,
    )
    assert resp.status_code == 201
    res_data = resp.json()
    item_1_id = res_data["item_id"]
    file_1_target = res_data["files"][0]
    assert file_1_target["already_exists"] is False
    assert file_1_target["upload_url"] == f"/api/items/{item_1_id}/files/{file_1_target['file_id']}/upload"

    # 2. Upload file stream
    upload_resp = await client.put(
        file_1_target["upload_url"],
        content=content,
        headers=headers,
    )
    assert upload_resp.status_code == 200

    # 3. Mark complete
    complete_resp = await client.post(f"/api/items/{item_1_id}/upload-complete", headers=headers)
    assert complete_resp.status_code == 200
    item_out = complete_resp.json()
    assert item_out["kind"] == "file"
    assert len(item_out["files"]) == 1

    # 4. Download file via Ticket
    download_url_resp = await client.get(
        f"/api/items/{item_1_id}/files/{file_1_target['file_id']}/download-url",
        headers=headers,
    )
    assert download_url_resp.status_code == 200
    download_rel_url = download_url_resp.json()["url"]

    # Download without Bearer header (using ticket query param)
    download_resp = await client.get(download_rel_url)
    assert download_resp.status_code == 200
    assert download_resp.content == content
    assert "attachment; filename=\"test.txt\"" in download_resp.headers.get("content-disposition", "") or "test.txt" in download_resp.headers.get("content-disposition", "")

    # 5. Deduplication / 秒传 test: create a second item with the exact same sha256
    resp2 = await client.post(
        "/api/items",
        json={
            "kind": "file",
            "note": "test file 2 (deduped)",
            "files": [
                {
                    "file_name": "copy_test.txt",
                    "mime_type": "text/plain",
                    "size": len(content),
                    "sha256": content_sha,
                }
            ],
        },
        headers=headers,
    )
    assert resp2.status_code == 201
    res_data2 = resp2.json()
    item_2_id = res_data2["item_id"]
    file_2_target = res_data2["files"][0]
    assert file_2_target["already_exists"] is True  # 秒传命中！

    # Item 2 is immediately ready without needing upload
    items_list_resp = await client.get("/api/items?limit=10", headers=headers)
    assert items_list_resp.status_code == 200
    assert len(items_list_resp.json()["items"]) == 2

    # 6. Purge item 1: physical file must NOT be deleted because item 2 still references it
    del1_resp = await client.delete(f"/api/items/{item_1_id}/purge", headers=headers)
    assert del1_resp.status_code == 204
    assert storage_module.file_exists(content_sha) is True

    # 7. Purge item 2: physical file should now be unreferenced and removed
    del2_resp = await client.delete(f"/api/items/{item_2_id}/purge", headers=headers)
    assert del2_resp.status_code == 204
    assert storage_module.file_exists(content_sha) is False


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
                        "sha256": checksum_sha256(f"x{i}".encode()),
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
        s.add(models.DropFile(item_id=old_draft.id, file_name="d.txt", mime_type="text/plain", size=1, sha256="0" * 64))
        s.add(models.DropFile(item_id=old_ready.id, file_name="r.txt", mime_type="text/plain", size=1, sha256="0" * 64, uploaded_at=datetime.now(timezone.utc)))
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

    monkeypatch.setattr(cleanup, "SessionLocal", db_module.SessionLocal)

    removed = await cleanup._cleanup_stale_drafts()
    assert removed == 1  # 只删除过期 file 草稿

    async with db_module.SessionLocal() as s:
        ids = [row[0] for row in (await s.execute(select(models.DropItem.id))).all()]
        assert old_note.id in ids  # 笔记绝不被清理
        assert old_ready.id in ids  # 已完成条目不被清理
        assert old_draft.id not in ids


async def test_ephemeral_items_flow(client) -> None:
    tokens = await login(client)
    headers = auth_headers(tokens)

    # 1. Create ephemeral note
    resp = await client.post(
        "/api/items",
        json={"kind": "note", "note": "ephemeral secret note", "is_ephemeral": True},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    ephemeral_id = resp.json()["item_id"]

    # 2. Create permanent note
    resp = await client.post(
        "/api/items",
        json={"kind": "note", "note": "permanent note", "is_ephemeral": False},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    permanent_id = resp.json()["item_id"]

    # 3. Filter by is_ephemeral=true
    resp = await client.get("/api/items?is_ephemeral=true", headers=headers)
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert any(i["id"] == ephemeral_id for i in items)
    assert not any(i["id"] == permanent_id for i in items)
    ephemeral_item = next(i for i in items if i["id"] == ephemeral_id)
    assert ephemeral_item["is_ephemeral"] is True
    assert ephemeral_item["expires_at"] is not None

    # 4. Filter by is_ephemeral=false
    resp = await client.get("/api/items?is_ephemeral=false", headers=headers)
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert any(i["id"] == permanent_id for i in items)
    assert not any(i["id"] == ephemeral_id for i in items)


async def test_cleanup_removes_expired_ephemeral_items(client, monkeypatch) -> None:
    import app.cleanup as cleanup
    import app.models as models

    tokens = await login(client)

    now = datetime.now(timezone.utc)
    expired_ephemeral = models.DropItem(
        kind="note",
        note="expired note",
        created_by_device=tokens["device_id"],
        is_ephemeral=True,
        expires_at=now - timedelta(hours=1),
    )
    active_ephemeral = models.DropItem(
        kind="note",
        note="active note",
        created_by_device=tokens["device_id"],
        is_ephemeral=True,
        expires_at=now + timedelta(hours=23),
    )
    permanent_note = models.DropItem(
        kind="note",
        note="permanent note",
        created_by_device=tokens["device_id"],
        is_ephemeral=False,
        expires_at=None,
    )

    async with db_module.SessionLocal() as s:
        s.add_all([expired_ephemeral, active_ephemeral, permanent_note])
        await s.commit()

    monkeypatch.setattr(cleanup, "SessionLocal", db_module.SessionLocal)

    removed = await cleanup._cleanup_expired_ephemeral_items()
    assert removed == 1

    async with db_module.SessionLocal() as s:
        ids = [row[0] for row in (await s.execute(select(models.DropItem.id))).all()]
        assert expired_ephemeral.id not in ids
        assert active_ephemeral.id in ids
        assert permanent_note.id in ids


async def test_trash_flow_soft_delete_restore_purge(client) -> None:
    tokens = await login(client)
    headers = auth_headers(tokens)

    # 1. Create a note
    resp = await client.post(
        "/api/items",
        json={"kind": "note", "note": "recycle bin test note"},
        headers=headers,
    )
    assert resp.status_code == 201
    item_id = resp.json()["item_id"]

    # 2. Soft delete item
    resp = await client.delete(f"/api/items/{item_id}", headers=headers)
    assert resp.status_code == 204

    # 3. Item is hidden from active items
    resp = await client.get("/api/items", headers=headers)
    assert resp.status_code == 200
    assert not any(i["id"] == item_id for i in resp.json()["items"])

    # 4. Item appears in trash
    resp = await client.get("/api/items/trash", headers=headers)
    assert resp.status_code == 200
    trash_items = resp.json()
    assert any(i["id"] == item_id for i in trash_items)
    trash_item = next(i for i in trash_items if i["id"] == item_id)
    assert trash_item["deleted_at"] is not None

    # 5. Restore item
    resp = await client.post(f"/api/items/{item_id}/restore", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["deleted_at"] is None

    # 6. Item is back in active items and gone from trash
    resp = await client.get("/api/items", headers=headers)
    assert any(i["id"] == item_id for i in resp.json()["items"])

    resp = await client.get("/api/items/trash", headers=headers)
    assert not any(i["id"] == item_id for i in resp.json())

    # 7. Soft delete and purge item
    await client.delete(f"/api/items/{item_id}", headers=headers)
    resp = await client.delete(f"/api/items/{item_id}/purge", headers=headers)
    assert resp.status_code == 204

    # 8. Gone from everywhere
    resp = await client.get("/api/items/trash", headers=headers)
    assert not any(i["id"] == item_id for i in resp.json())


async def test_empty_trash(client) -> None:
    tokens = await login(client)
    headers = auth_headers(tokens)

    # Create 2 notes
    r1 = await client.post("/api/items", json={"kind": "note", "note": "n1"}, headers=headers)
    r2 = await client.post("/api/items", json={"kind": "note", "note": "n2"}, headers=headers)
    id1, id2 = r1.json()["item_id"], r2.json()["item_id"]

    await client.delete(f"/api/items/{id1}", headers=headers)
    await client.delete(f"/api/items/{id2}", headers=headers)

    resp = await client.get("/api/items/trash", headers=headers)
    assert len(resp.json()) >= 2

    # Empty trash
    resp = await client.delete("/api/items/trash/empty", headers=headers)
    assert resp.status_code == 204

    resp = await client.get("/api/items/trash", headers=headers)
    assert len(resp.json()) == 0


async def test_cleanup_removes_30_day_expired_trash_items(client, monkeypatch) -> None:
    import app.cleanup as cleanup
    import app.models as models

    tokens = await login(client)
    now = datetime.now(timezone.utc)

    expired_trash = models.DropItem(
        kind="note",
        note="expired trash",
        created_by_device=tokens["device_id"],
        deleted_at=now - timedelta(days=31),
    )
    active_trash = models.DropItem(
        kind="note",
        note="active trash",
        created_by_device=tokens["device_id"],
        deleted_at=now - timedelta(days=5),
    )

    async with db_module.SessionLocal() as s:
        s.add_all([expired_trash, active_trash])
        await s.commit()

    monkeypatch.setattr(cleanup, "SessionLocal", db_module.SessionLocal)

    removed = await cleanup._cleanup_expired_trash_items()
    assert removed == 1

    async with db_module.SessionLocal() as s:
        ids = [row[0] for row in (await s.execute(select(models.DropItem.id))).all()]
        assert expired_trash.id not in ids
        assert active_trash.id in ids


async def test_secret_timeline_flow(client) -> None:
    tokens = await login(client)
    headers = auth_headers(tokens)

    # 1. Create a regular note and a secret note
    resp_reg = await client.post(
        "/api/items",
        json={"kind": "note", "note": "public timeline note", "is_secret": False},
        headers=headers,
    )
    assert resp_reg.status_code == 201
    reg_id = resp_reg.json()["item_id"]

    resp_sec = await client.post(
        "/api/items",
        json={"kind": "note", "note": "secret timeline note", "is_secret": True},
        headers=headers,
    )
    assert resp_sec.status_code == 201
    sec_id = resp_sec.json()["item_id"]

    # 2. Default GET /api/items only returns non-secret items
    resp = await client.get("/api/items", headers=headers)
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert any(i["id"] == reg_id for i in items)
    assert not any(i["id"] == sec_id for i in items)

    # 3. GET /api/items?is_secret=true only returns secret items
    resp_s = await client.get("/api/items?is_secret=true", headers=headers)
    assert resp_s.status_code == 200
    sec_items = resp_s.json()["items"]
    assert any(i["id"] == sec_id for i in sec_items)
    assert not any(i["id"] == reg_id for i in sec_items)
    assert sec_items[0]["is_secret"] is True

    # 4. Soft delete secret item -> enters general trash
    del_resp = await client.delete(f"/api/items/{sec_id}", headers=headers)
    assert del_resp.status_code == 204

    trash_resp = await client.get("/api/items/trash", headers=headers)
    assert trash_resp.status_code == 200
    assert any(i["id"] == sec_id for i in trash_resp.json())

    # 5. Restore secret item from trash -> back to secret timeline
    restore_resp = await client.post(f"/api/items/{sec_id}/restore", headers=headers)
    assert restore_resp.status_code == 200
    assert restore_resp.json()["is_secret"] is True
    assert restore_resp.json()["deleted_at"] is None

    # Verify back in secret timeline and not in regular timeline
    resp = await client.get("/api/items", headers=headers)
    assert not any(i["id"] == sec_id for i in resp.json()["items"])

    resp_s = await client.get("/api/items?is_secret=true", headers=headers)
    assert any(i["id"] == sec_id for i in resp_s.json()["items"])



