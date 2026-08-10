# ESP32 joystick input.
#
# The firmware POSTs its raw state to /recive once a second, forever:
#     {"id": "esp32_01", "direction": "up-left", "pressed": true}
#
# That path name (and its misspelling) is baked into the firmware, so it
# stays. /receive is accepted too for anyone typing it by hand.
#
# This router turns that stream into discrete UI events and pushes them to
# the browser over /ws. Three things have to happen in between:
#
#   1. Rename. Firmware says "up-left"; the ring's slots are "up_left".
#   2. Debounce. The board reports its CURRENT state every second whether
#      or not anything changed. Relaying that verbatim would advance the
#      wheel once a second while the stick is simply held. So a tilt fires
#      once and re-arms only when the stick returns to centre, and a press
#      fires only on the false -> true edge.
#   3. Fan-out. Any number of browsers can watch the same device.
#
# The browser owns what an input MEANS (move, select, regenerate) - see
# handleDirection() in client/speak.js. This router only reports gestures.

import asyncio
import json
import time
from typing import Dict, List, Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

router = APIRouter(tags=["joystick"])

# How long a press waits to see whether a second one follows. Every select
# is delayed by this much, so it's a direct trade against responsiveness -
# and it only works if the firmware reports button changes promptly. The
# stock 1-second loop is far too slow; see the fast-loop sketch in
# firmware/joystick.ino.
DOUBLE_PRESS_WINDOW = 0.45


# ---- Schemas -------------------------------------------------------

# Every field has a default: the firmware occasionally posts a partial
# body while Wi-Fi is settling, and a 422 there would look like a dead
# board. Defaults make a malformed post a no-op instead.
class EspData(BaseModel):
    id: str = "esp32_01"
    direction: str = "center"
    pressed: bool = False


# ---- Direction normalisation ---------------------------------------

DIR_ALIASES = {
    "up-left": "up_left",
    "up-right": "up_right",
    "down-left": "down_left",
    "down-right": "down_right",
    "upleft": "up_left",
    "upright": "up_right",
    "downleft": "down_left",
    "downright": "down_right",
}

RING_DIRECTIONS = {
    "up", "up_right", "right", "down_right",
    "down", "down_left", "left", "up_left",
}


def normalise_direction(raw: str) -> str:
    key = (raw or "").strip().lower().replace(" ", "")
    return DIR_ALIASES.get(key, key)


# ---- Hub -----------------------------------------------------------


class Hub:
    """Fans joystick events out to every connected browser."""

    def __init__(self) -> None:
        self.clients: Set[WebSocket] = set()
        self.seq = 0
        self.last_event: Optional[dict] = None
        # Edge-detection state, per device id.
        self.prev_direction: Dict[str, str] = {}
        self.prev_pressed: Dict[str, bool] = {}
        # In-flight press waiting to see if it becomes a double-press.
        self.pending_press: Dict[str, dict] = {}

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.clients.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.clients.discard(websocket)

    async def broadcast(self, message: dict) -> None:
        if not self.clients:
            return
        payload = json.dumps(message)
        dead = []
        for websocket in list(self.clients):
            try:
                await websocket.send_text(payload)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self.clients.discard(websocket)

    def _stamp(self, direction: str, device: str) -> dict:
        self.seq += 1
        event = {"state": "input", "dir": direction, "seq": self.seq, "id": device}
        self.last_event = event
        return event

    async def handle(self, data: EspData) -> List[str]:
        """Raw board state -> broadcast gestures. Returns what it emitted."""
        direction = normalise_direction(data.direction)
        device = data.id

        was_pressed = self.prev_pressed.get(device, False)
        was_direction = self.prev_direction.get(device, "center")

        self.prev_pressed[device] = data.pressed
        self.prev_direction[device] = direction

        emitted: List[str] = []

        # Tilt: fires once. Holding the stick does nothing further; coming
        # back to centre re-arms it. All eight map straight to their slot -
        # the ring's positional promise only holds if pushing a direction
        # lands on that direction.
        if direction in RING_DIRECTIONS and direction != was_direction:
            await self.broadcast(self._stamp(direction, device))
            emitted.append(direction)

        # Press: the rising edge of the switch only.
        if data.pressed and not was_pressed:
            emitted.append(await self._on_press_edge(device))

        return emitted

    async def _on_press_edge(self, device: str) -> str:
        """One press selects; two in quick succession regenerate.

        The stick has eight directions and eight slots, so there's no
        direction left to mean "not what I meant" - it has to be a button
        gesture.
        """
        pending = self.pending_press.pop(device, None)
        if pending and (time.monotonic() - pending["at"]) <= DOUBLE_PRESS_WINDOW:
            pending["task"].cancel()
            await self.broadcast(self._stamp("regenerate", device))
            return "regenerate"

        task = asyncio.create_task(self._fire_press(device))
        self.pending_press[device] = {"at": time.monotonic(), "task": task}
        return "press(pending)"

    async def _fire_press(self, device: str) -> None:
        try:
            await asyncio.sleep(DOUBLE_PRESS_WINDOW)
        except asyncio.CancelledError:
            return
        self.pending_press.pop(device, None)
        await self.broadcast(self._stamp("press", device))


hub = Hub()


# ---- Endpoints -----------------------------------------------------


@router.post("/recive")
@router.post("/receive")
async def receive(data: EspData):
    """Where the ESP32 posts."""
    # Heartbeat on every post, not just on a gesture - it's what lets the
    # DEVICE pill show the board is alive while the stick sits at centre.
    await hub.broadcast(
        {
            "state": "device",
            "online": True,
            "id": data.id,
            "direction": normalise_direction(data.direction),
            "pressed": data.pressed,
        }
    )

    emitted = await hub.handle(data)
    return {"message": "Data Recived!", "events": emitted}


@router.get("/api/input/latest")
def latest():
    """Polling fallback for when the WebSocket can't be used.

    `seq` increments per gesture, so a client can tell a new event from a
    repeat of the one it already handled.
    """
    return hub.last_event or {"state": "idle", "seq": hub.seq}


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """The browser's live feed. Read-only: the page never sends anything."""
    await hub.connect(websocket)
    try:
        while True:
            # We don't act on anything the client sends; this just parks the
            # coroutine until the socket closes.
            await websocket.receive_text()
    except WebSocketDisconnect:
        hub.disconnect(websocket)
    except Exception:
        hub.disconnect(websocket)
