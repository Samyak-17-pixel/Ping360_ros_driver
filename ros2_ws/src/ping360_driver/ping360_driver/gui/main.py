from __future__ import annotations

import asyncio
import logging
import os
import re
import socket
from pathlib import Path
from typing import Optional, Tuple

import websockets
from fastapi import Depends, FastAPI, Form, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .auth import SessionSigner, load_or_create_secret, ssh_authenticate
from .rosbag_ctl import RemoteRosbagController


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = (Path.home() / ".local" / "share" / "ping360_gui").resolve()
SECRET_PATH = str(DATA_DIR / "session_secret.bin")
SESSION_COOKIE = "ping360_viewer_session"

HTTP_HOST = os.environ.get("PING360_VIEWER_HOST", "0.0.0.0")
HTTP_PORT = int(os.environ.get("PING360_VIEWER_PORT", "8080"))
# Default rosbridge port if user does not specify host:port at login.
DEFAULT_ROSBRIDGE_PORT = int(os.environ.get("PING360_ROSBRIDGE_PORT", "9090"))
REMOTE_BAGS_DIR = os.environ.get("PING360_REMOTE_BAGS_DIR", "$HOME/ping360_viewer_bags")
DEFAULT_JETSON_USER = os.environ.get("PING360_DEFAULT_JETSON_USER", "mavlab")

signer = SessionSigner(load_or_create_secret(SECRET_PATH))
rosbag = RemoteRosbagController(REMOTE_BAGS_DIR)

SKIP_SSH = os.environ.get("PING360_GUI_SKIP_SSH", "").strip() in ("1", "true", "yes")

app = FastAPI(title="Ping360 Viewer")
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")

log = logging.getLogger("ping360_viewer")
logging.basicConfig(level=os.environ.get("PING360_LOG_LEVEL", "INFO"))


def get_session(request: Request) -> Optional[str]:
    return request.cookies.get(SESSION_COOKIE)


def require_user(request: Request) -> str:
    token = get_session(request)
    if not token:
        raise HTTPException(status_code=401)
    sess = signer.verify(token)
    if not sess:
        raise HTTPException(status_code=401)
    return sess.username


def require_session(request: Request):
    token = get_session(request)
    if not token:
        raise HTTPException(status_code=401)
    sess = signer.verify(token)
    if not sess:
        raise HTTPException(status_code=401)
    return sess


def parse_host_user_and_port(raw: str) -> Tuple[str, str, int]:
    """
    Accept:
      - "ip"
      - "ip:rosbridge_port"
      - "user@ip"
      - "user@ip:rosbridge_port"
    """
    s = raw.strip()
    if "@" in s:
        user, host = s.split("@", 1)
        user = user.strip() or DEFAULT_JETSON_USER
    else:
        user = DEFAULT_JETSON_USER
        host = s

    host = host.strip()
    m = re.match(r"^(?P<h>.+?)(?::(?P<p>\d+))?\s*$", host)
    if not m:
        raise ValueError("invalid host")
    h = (m.group("h") or "").strip()
    p = int(m.group("p")) if m.group("p") else DEFAULT_ROSBRIDGE_PORT
    host = h
    if not host:
        raise ValueError("empty host")
    return host, user, p


def fix_loopback_dot_port_typo(url: str) -> str:
    """
    Fix common typo: 127.0.0.9091 meant 127.0.0.1:9091 (period instead of ':'
    before the port). Produces invalid host 127.0.0.9091 in browsers.
    """
    s = url.strip()
    low = s.lower()
    scheme = ""
    rest = s
    if low.startswith("wss://"):
        scheme = "wss://"
        rest = s[6:]
    elif low.startswith("ws://"):
        scheme = "ws://"
        rest = s[5:]

    hostpart = rest.split("/")[0]
    if ":" in hostpart:
        return url

    parts = hostpart.split(".")
    if len(parts) != 4 or not all(p.isdigit() for p in parts):
        return url
    if parts[0] != "127" or parts[1] != "0" or parts[2] != "0":
        return url
    tail = int(parts[3])
    if tail <= 255 or tail > 65535:
        return url
    return f"{scheme}127.0.0.1:{parts[3]}{rest[len(hostpart):]}"


def _parse_ws_url_to_host_port(url: str) -> Optional[Tuple[str, int]]:
    """Extract (host, port) for TCP check from ws:// or wss:// URL."""
    s = fix_loopback_dot_port_typo(url.strip())
    low = s.lower()
    if low.startswith("ws://"):
        rest = s[5:]
    elif low.startswith("wss://"):
        rest = s[6:]
    else:
        return None
    hostpart = rest.split("/")[0].split("?", 1)[0].strip()
    if not hostpart:
        return None
    if hostpart.startswith("["):
        if "]:" in hostpart:
            inner, _, p = hostpart.rpartition(":")
            host = inner.strip("[]")
            try:
                pi = int(p)
                return (host, pi) if 1 <= pi <= 65535 else None
            except ValueError:
                return None
        return None
    if ":" in hostpart:
        h, _, p = hostpart.rpartition(":")
        try:
            pi = int(p)
            if not (1 <= pi <= 65535):
                return None
            return (h, pi)
        except ValueError:
            return None
    return (hostpart, DEFAULT_ROSBRIDGE_PORT)


def _tcp_reachable(host: str, port: int, timeout: float = 2.5) -> bool:
    if not host or port <= 0:
        return False
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def parse_rosbridge_override(raw: str) -> Optional[str]:
    """
    Accept a rosbridge override as:
      - "ws://host:port"
      - "wss://host:port"
      - "host:port"
    Returns a ws(s) URL or None.
    """
    s = (raw or "").strip()
    if not s:
        return None
    if s.startswith("ws://") or s.startswith("wss://"):
        return fix_loopback_dot_port_typo(s)
    return fix_loopback_dot_port_typo(f"ws://{s}")


def _ssh_ok(host: str, user: str, password: str) -> bool:
    if SKIP_SSH or host in ("127.0.0.1", "localhost", "::1"):
        return True
    return ssh_authenticate(host, user, password)


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    token = get_session(request)
    sess = signer.verify(token) if token else None
    if not sess:
        return RedirectResponse(url="/login", status_code=302)
    # Serve the static app shell
    with open(APP_DIR / "static" / "index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read(), headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/login", response_class=HTMLResponse)
def login_page():
    with open(APP_DIR / "static" / "login.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read(), headers={"Cache-Control": "no-store, max-age=0"})


@app.post("/login")
def login(username: str = Form(...), password: str = Form(""), rosbridge: str = Form("")):
    # username field is used as Jetson host (or user@host)
    try:
        host, jetson_user, rosbridge_port = parse_host_user_and_port(username)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid host")

    if not _ssh_ok(host, jetson_user, password):
        raise HTTPException(status_code=401, detail="invalid credentials")

    rosbridge_ws_url = parse_rosbridge_override(rosbridge) or fix_loopback_dot_port_typo(
        f"ws://{host}:{rosbridge_port}"
    )
    token = signer.mint(
        username=username,
        jetson_host=host,
        jetson_user=jetson_user,
        rosbridge_ws_url=rosbridge_ws_url,
    )
    resp = RedirectResponse(url="/", status_code=302)
    resp.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=False,  # set True if you front with HTTPS
        max_age=12 * 60 * 60,
        path="/",
    )
    return resp


@app.post("/logout")
def logout():
    resp = RedirectResponse(url="/login", status_code=302)
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


@app.get("/api/me")
def me(sess=Depends(require_session)):
    rb_url = fix_loopback_dot_port_typo(sess.rosbridge_ws_url)
    ep = _parse_ws_url_to_host_port(rb_url)
    reachable = _tcp_reachable(ep[0], ep[1]) if ep else False
    target = f"{ep[0]}:{ep[1]}" if ep else None
    return {
        "username": sess.username,
        "jetson_host": sess.jetson_host,
        "jetson_user": sess.jetson_user,
        "rosbridge": rb_url,
        "rosbridge_port": ep[1] if ep else None,
        "rosbridge_target": target,
        "rosbridge_reachable": reachable,
    }


@app.post("/api/session/rosbridge")
def session_update_rosbridge(
    password: str = Form(...),
    rosbridge: str = Form(""),
    sess=Depends(require_session),
):
    """
    Re-verify SSH and update the rosbridge WebSocket URL used by this server’s proxy.
    Empty rosbridge resets to ws://<jetson_host>:<default port>.
    """
    if not _ssh_ok(sess.jetson_host, sess.jetson_user, password):
        raise HTTPException(status_code=401, detail="invalid credentials")
    raw = (rosbridge or "").strip()
    if raw:
        new_url = parse_rosbridge_override(raw)
        if not new_url:
            raise HTTPException(status_code=400, detail="invalid rosbridge URL")
    else:
        new_url = fix_loopback_dot_port_typo(f"ws://{sess.jetson_host}:{DEFAULT_ROSBRIDGE_PORT}")
    token = signer.mint(
        username=sess.username,
        jetson_host=sess.jetson_host,
        jetson_user=sess.jetson_user,
        rosbridge_ws_url=new_url,
    )
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=False,
        max_age=12 * 60 * 60,
        path="/",
    )
    return resp


@app.get("/api/bags")
def list_bags(sess=Depends(require_session)):
    # Bag list/remote control requires the Jetson password again (we do not store it).
    return {
        "record": rosbag.record_status(),
        "play": rosbag.play_status(),
        "bags": [],
        "needs_password": True,
    }


@app.post("/api/bags/refresh")
def list_bags_with_password(password: str = Form(...), sess=Depends(require_session)):
    if not ssh_authenticate(sess.jetson_host, sess.jetson_user, password):
        raise HTTPException(status_code=401, detail="invalid credentials")
    return {
        "record": rosbag.record_status(),
        "play": rosbag.play_status(),
        "bags": rosbag.list_bags(sess.jetson_host, sess.jetson_user, password),
    }


@app.post("/api/record/start")
def record_start(password: str = Form(...), sess=Depends(require_session)):
    # Record just the scan image for now (can be extended in UI)
    if not ssh_authenticate(sess.jetson_host, sess.jetson_user, password):
        raise HTTPException(status_code=401, detail="invalid credentials")
    name = rosbag.start_record(
        sess.jetson_host,
        sess.jetson_user,
        password,
        ["/ping360/scan_image", "/ping360/auto_device_data", "/ping360/derived"],
    )
    return {"ok": True, "name": name}


@app.post("/api/record/stop")
def record_stop(password: str = Form(...), sess=Depends(require_session)):
    if not ssh_authenticate(sess.jetson_host, sess.jetson_user, password):
        raise HTTPException(status_code=401, detail="invalid credentials")
    rosbag.stop_record(sess.jetson_host, sess.jetson_user, password)
    return {"ok": True}


@app.post("/api/play/start")
def play_start(bag: str = Form(...), password: str = Form(...), sess=Depends(require_session)):
    if not ssh_authenticate(sess.jetson_host, sess.jetson_user, password):
        raise HTTPException(status_code=401, detail="invalid credentials")
    rosbag.start_play(sess.jetson_host, sess.jetson_user, password, bag)
    return {"ok": True}


@app.post("/api/play/stop")
def play_stop(password: str = Form(...), sess=Depends(require_session)):
    if not ssh_authenticate(sess.jetson_host, sess.jetson_user, password):
        raise HTTPException(status_code=401, detail="invalid credentials")
    rosbag.stop_play(sess.jetson_host, sess.jetson_user, password)
    return {"ok": True}


@app.websocket("/ws/rosbridge")
async def ws_proxy(websocket: WebSocket):
    await websocket.accept()

    token = websocket.cookies.get(SESSION_COOKIE)
    sess = signer.verify(token) if token else None
    if not sess:
        await websocket.close(code=4401)
        return

    upstream_url = fix_loopback_dot_port_typo(sess.rosbridge_ws_url)
    if upstream_url != sess.rosbridge_ws_url:
        log.info("Normalized rosbridge URL %s -> %s", sess.rosbridge_ws_url, upstream_url)

    try:
        log.info("Proxy WS connect upstream %s", upstream_url)
        # Large SonarEcho/Image JSON can exceed 1 MiB; rosbridge may also use binary WS frames (e.g. CBOR).
        async with websockets.connect(
            upstream_url,
            ping_interval=20,
            ping_timeout=20,
            open_timeout=5,
            max_size=None,
        ) as upstream:
            async def client_to_upstream() -> None:
                try:
                    while True:
                        msg = await websocket.receive_text()
                        await upstream.send(msg)
                except WebSocketDisconnect:
                    pass
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    log.debug("Proxy client→upstream task ended: %r", e)

            async def upstream_to_client() -> None:
                try:
                    async for msg in upstream:
                        if isinstance(msg, bytes):
                            await websocket.send_bytes(msg)
                        else:
                            await websocket.send_text(msg)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    log.debug("Proxy upstream→client task ended: %r", e)

            # If rosbridge drops first, the other task would block forever on gather(), and the browser
            # socket might never close — no onclose → GUI reconnect logic never runs.
            t_up = asyncio.create_task(client_to_upstream())
            t_down = asyncio.create_task(upstream_to_client())
            _, pending = await asyncio.wait({t_up, t_down}, return_when=asyncio.FIRST_COMPLETED)
            for p in pending:
                p.cancel()
            await asyncio.gather(t_up, t_down, return_exceptions=True)
    except Exception as e:
        log.warning(
            "Proxy upstream failed/closed for %s: %r "
            "(from this host: confirm rosbridge listens on 0.0.0.0 or use a URL reachable here, not only 127.0.0.1 on the robot)",
            upstream_url,
            e,
        )
    finally:
        try:
            await websocket.close(code=1011)
        except Exception:
            pass


def main():
    import uvicorn

    uvicorn.run("ping360_driver.gui.main:app", host=HTTP_HOST, port=HTTP_PORT, reload=False)


if __name__ == "__main__":
    main()

