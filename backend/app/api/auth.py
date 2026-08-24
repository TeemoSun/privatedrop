import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session
from app.models import Device
from app.schemas import LoginRequest, RefreshRequest, TokenResponse
from app import security as security_module
from app.security import (
    check_login_rate,
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
    utc_now,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest, request: Request, session: AsyncSession = Depends(get_session)
) -> TokenResponse:
    ip = _client_ip(request)
    if not check_login_rate(ip):
        raise HTTPException(status_code=429, detail="too many attempts, try again later")
    if security_module.APP_PASSWORD_HASH is None or not verify_password(body.password, security_module.APP_PASSWORD_HASH):
        raise HTTPException(status_code=401, detail="invalid password")

    now = utc_now()
    device = await session.get(Device, body.device_id)
    if device is None:
        device = Device(id=body.device_id, name=body.device_name, created_at=now, last_seen_at=now)
        session.add(device)
    else:
        device.name = body.device_name
        device.last_seen_at = now

    jti = uuid.uuid4()
    device.refresh_jti = jti
    await session.commit()

    return TokenResponse(
        access_token=create_access_token(body.device_id),
        refresh_token=create_refresh_token(body.device_id, jti),
        device_id=body.device_id,
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest, session: AsyncSession = Depends(get_session)
) -> TokenResponse:
    try:
        device_id, jti = decode_refresh_token(body.refresh_token)
    except Exception:
        raise HTTPException(status_code=401, detail="invalid refresh token")

    device = await session.get(Device, device_id)
    if device is None or device.refresh_jti is None or device.refresh_jti != jti:
        raise HTTPException(status_code=401, detail="refresh token revoked")

    now = utc_now()
    device.last_seen_at = now
    new_jti = uuid.uuid4()
    device.refresh_jti = new_jti
    await session.commit()

    return TokenResponse(
        access_token=create_access_token(device_id),
        refresh_token=create_refresh_token(device_id, new_jti),
        device_id=device_id,
    )


@router.post("/logout", status_code=204)
async def logout(device_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> None:
    device = await session.get(Device, device_id)
    if device is not None:
        device.refresh_jti = None
        await session.commit()
