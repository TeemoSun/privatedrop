import uuid

import jwt
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.security import decode_access_token
from app.ws import manager

router = APIRouter(prefix="/api", tags=["ws"])


@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket, token: str = Query(default="")
) -> None:
    try:
        device_id = decode_access_token(token)
    except (jwt.InvalidTokenError, ValueError, KeyError) as exc:
        await websocket.close(code=4401, reason="invalid token")
        return
    await manager.connect(websocket, device_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
