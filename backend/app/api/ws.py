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
        # 必须先 accept 再 close：未 accept 直接 close 会被 uvicorn 以 HTTP 403
        # 拒绝握手，浏览器只能触发 onclose(1006)，拿不到 4401 关闭码，
        # 前端也就无法走"刷新 token 后重连"的分支
        await websocket.accept()
        await websocket.close(code=4401, reason="invalid token")
        return
    await manager.connect(websocket, device_id)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
