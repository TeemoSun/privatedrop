import logging
import uuid
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self) -> None:
        self.active: dict[WebSocket, uuid.UUID] = {}

    async def connect(self, websocket: WebSocket, device_id: uuid.UUID) -> None:
        await websocket.accept()
        self.active[websocket] = device_id

    def disconnect(self, websocket: WebSocket) -> None:
        self.active.pop(websocket, None)

    async def broadcast(self, event: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for websocket in self.active:
            try:
                await websocket.send_json(event)
            except Exception:
                dead.append(websocket)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()
