from fastapi import WebSocket

from .database import User


class WebsocketManager:
    def __init__(self):
        self.active_connections: dict[str, set[WebSocket]] = {}

    def add(self, username: str, websocket: WebSocket):
        if username not in self.active_connections:
            self.active_connections[username] = set()

        self.active_connections[username].add(websocket)

    def remove(self, username: str, websocket: WebSocket):
        self.active_connections[username].remove(websocket)

    async def send_broadcast(self, username: str, text: str):
        print("Sending:", text)
        if username in self.active_connections:
            for connection in self.active_connections[username]:
                await connection.send_text(text)


websocket_manager = WebsocketManager()
