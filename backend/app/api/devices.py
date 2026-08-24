import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session, require_auth
from app.models import Device
from app.schemas import DeviceOut, DevicePatch

router = APIRouter(prefix="/api/devices", tags=["devices"])


@router.get("", response_model=list[DeviceOut])
async def list_devices(
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> list[Device]:
    result = await session.execute(select(Device).order_by(Device.created_at))
    return list(result.scalars().all())


@router.patch("/{device_id}", response_model=DeviceOut)
async def rename_device(
    device_id: uuid.UUID,
    body: DevicePatch,
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> Device:
    device = await session.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="device not found")
    device.name = body.name
    await session.commit()
    await session.refresh(device)
    return device


@router.delete("/{device_id}", status_code=204)
async def delete_device(
    device_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> None:
    device = await session.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="device not found")
    await session.delete(device)
    await session.commit()
