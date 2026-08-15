from __future__ import annotations

import os
import shlex
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .auth import ssh_exec


@dataclass
class ProcHandle:
    name: str
    popen: subprocess.Popen
    started_at: float


class RosbagController:
    def __init__(self, base_dir: str) -> None:
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)
        self._record: Optional[ProcHandle] = None
        self._play: Optional[ProcHandle] = None

    def list_bags(self) -> list[str]:
        if not self._base.exists():
            return []
        # rosbag2 creates a folder with metadata.yaml inside
        bags = []
        for p in sorted(self._base.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
            if p.is_dir() and (p / "metadata.yaml").exists():
                bags.append(p.name)
        return bags

    def start_record(self, topics: list[str]) -> str:
        if self._record and self._record.popen.poll() is None:
            raise RuntimeError("record already running")

        stamp = time.strftime("%Y%m%d_%H%M%S")
        out_dir = self._base / f"bag_{stamp}"
        out_dir.parent.mkdir(parents=True, exist_ok=True)

        cmd = ["bash", "-lc", " ".join([
            "source /opt/ros/humble/setup.bash",
            "&&",
            "ros2 bag record",
            "-o", str(out_dir),
            *topics,
        ])]

        p = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env={**os.environ},
        )
        self._record = ProcHandle(name=out_dir.name, popen=p, started_at=time.time())
        return out_dir.name

    def stop_record(self) -> None:
        if not self._record or self._record.popen.poll() is not None:
            self._record = None
            return
        self._terminate(self._record.popen)
        self._record = None

    def record_status(self) -> dict:
        running = bool(self._record and self._record.popen.poll() is None)
        return {
            "running": running,
            "name": self._record.name if running else None,
            "started_at": self._record.started_at if running else None,
        }

    def start_play(self, bag_name: str) -> None:
        if self._play and self._play.popen.poll() is None:
            raise RuntimeError("play already running")

        bag_dir = self._base / bag_name
        if not (bag_dir / "metadata.yaml").exists():
            raise FileNotFoundError(bag_name)

        cmd = ["bash", "-lc", " ".join([
            "source /opt/ros/humble/setup.bash",
            "&&",
            "ros2 bag play",
            str(bag_dir),
        ])]

        p = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env={**os.environ},
        )
        self._play = ProcHandle(name=bag_name, popen=p, started_at=time.time())

    def stop_play(self) -> None:
        if not self._play or self._play.popen.poll() is not None:
            self._play = None
            return
        self._terminate(self._play.popen)
        self._play = None

    def play_status(self) -> dict:
        running = bool(self._play and self._play.popen.poll() is None)
        return {
            "running": running,
            "name": self._play.name if running else None,
            "started_at": self._play.started_at if running else None,
        }

    def _terminate(self, p: subprocess.Popen) -> None:
        try:
            p.send_signal(signal.SIGINT)
        except Exception:
            return
        try:
            p.wait(timeout=5)
            return
        except Exception:
            pass
        try:
            p.terminate()
            p.wait(timeout=3)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass


class RemoteRosbagController:
    """
    Controls rosbag on a remote Jetson over SSH.
    Stores only PIDs for simple start/stop.
    """

    def __init__(self, base_dir: str) -> None:
        self._base = base_dir
        self._record_pid: Optional[int] = None
        self._record_name: Optional[str] = None
        self._record_started_at: Optional[float] = None
        self._play_pid: Optional[int] = None
        self._play_name: Optional[str] = None
        self._play_started_at: Optional[float] = None

    def list_bags(self, host: str, user: str, password: str) -> list[str]:
        inner = f"mkdir -p {shlex.quote(self._base)} && ls -1t {shlex.quote(self._base)} 2>/dev/null || true"
        cmd = f"bash -lc {shlex.quote(inner)}"
        out = ssh_exec(host, user, password, cmd, timeout_s=10.0)
        names = [line.strip() for line in out.splitlines() if line.strip()]
        # Filter to directories that contain metadata.yaml
        bags: list[str] = []
        for name in names:
            check = ssh_exec(
                host,
                user,
                password,
                f"bash -lc {shlex.quote('[ -f ' + shlex.quote(os.path.join(self._base, name, 'metadata.yaml')) + ' ] && echo ok || true')}",
                timeout_s=10.0,
            )
            if check.strip() == "ok":
                bags.append(name)
        return bags

    def start_record(self, host: str, user: str, password: str, topics: list[str]) -> str:
        if self._record_pid is not None:
            raise RuntimeError("record already running (viewer-side)")
        stamp = time.strftime("%Y%m%d_%H%M%S")
        name = f"bag_{stamp}"
        bag_dir = os.path.join(self._base, name)
        topics_s = " ".join(shlex.quote(t) for t in topics)
        cmd_inner = (
            f"mkdir -p {shlex.quote(self._base)} && "
            f"source /opt/ros/humble/setup.bash && "
            f"ros2 bag record -o {shlex.quote(bag_dir)} {topics_s}"
        )
        cmd = f"bash -lc {shlex.quote(f'nohup bash -lc {shlex.quote(cmd_inner)} >/tmp/ping360_viewer_record.log 2>&1 & echo $!')}"
        out = ssh_exec(host, user, password, cmd, timeout_s=10.0)
        pid = int(out.strip().splitlines()[-1])
        self._record_pid = pid
        self._record_name = name
        self._record_started_at = time.time()
        return name

    def stop_record(self, host: str, user: str, password: str) -> None:
        if self._record_pid is None:
            return
        ssh_exec(host, user, password, f"bash -lc {shlex.quote('kill -INT ' + str(self._record_pid) + ' 2>/dev/null || true')}", timeout_s=10.0)
        self._record_pid = None
        self._record_name = None
        self._record_started_at = None

    def record_status(self) -> dict:
        running = self._record_pid is not None
        return {"running": running, "name": self._record_name if running else None, "started_at": self._record_started_at if running else None}

    def start_play(self, host: str, user: str, password: str, bag_name: str) -> None:
        if self._play_pid is not None:
            raise RuntimeError("play already running (viewer-side)")
        bag_dir = os.path.join(self._base, bag_name)
        cmd_inner = f"source /opt/ros/humble/setup.bash && ros2 bag play {shlex.quote(bag_dir)}"
        cmd = f"bash -lc {shlex.quote(f'nohup bash -lc {shlex.quote(cmd_inner)} >/tmp/ping360_viewer_play.log 2>&1 & echo $!')}"
        out = ssh_exec(host, user, password, cmd, timeout_s=10.0)
        pid = int(out.strip().splitlines()[-1])
        self._play_pid = pid
        self._play_name = bag_name
        self._play_started_at = time.time()

    def stop_play(self, host: str, user: str, password: str) -> None:
        if self._play_pid is None:
            return
        ssh_exec(host, user, password, f"bash -lc {shlex.quote('kill -INT ' + str(self._play_pid) + ' 2>/dev/null || true')}", timeout_s=10.0)
        self._play_pid = None
        self._play_name = None
        self._play_started_at = None

    def play_status(self) -> dict:
        running = self._play_pid is not None
        return {"running": running, "name": self._play_name if running else None, "started_at": self._play_started_at if running else None}

