#!/usr/bin/env python3
"""ROS 2 service node: start/stop ros2 bag record for Ping360 topics."""

from __future__ import annotations

import datetime as dt
import os
import signal
import subprocess
from pathlib import Path
from typing import Optional

import rclpy
from rclpy.node import Node

from ping360_msgs.srv import StartRecording, StopRecording

DEFAULT_TOPICS = [
    "/ping360/auto_device_data",
    "/ping360/device_data",
    "/ping360/derived",
    "/ping360/scan_image",
    "/ping360/scan_image_meta",
    "/ping360/status",
    "/ping360/device_information",
    "/ping360/protocol_version",
    "/tf",
    "/tf_static",
]


class Ping360RecorderNode(Node):
    def __init__(self) -> None:
        super().__init__("ping360_recorder")
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._srv_start = self.create_service(StartRecording, "/ping360/recorder/start", self._cb_start)
        self._srv_stop = self.create_service(StopRecording, "/ping360/recorder/stop", self._cb_stop)
        self.get_logger().info("Ping360 recorder ready (/ping360/recorder/start|stop)")

    def _cb_start(self, req: StartRecording.Request, resp: StartRecording.Response) -> StartRecording.Response:
        if self._proc is not None and self._proc.poll() is None:
            resp.success = False
            resp.message = "Recording already running"
            return resp

        out_dir = req.output_directory.strip() or str(Path.home() / "rosbags")
        Path(out_dir).mkdir(parents=True, exist_ok=True)

        prefix = req.bag_name_prefix.strip()
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d_%H%M%S")
        bag_stem = f"{prefix}_{stamp}" if prefix else f"ping360_{stamp}"
        bag_path = str(Path(out_dir) / bag_stem)

        topics = list(req.topics) if req.topics else DEFAULT_TOPICS

        cmd = ["ros2", "bag", "record", "-o", bag_path, *topics]
        self.get_logger().info(f"Starting: {' '.join(cmd)}")
        try:
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except FileNotFoundError:
            resp.success = False
            resp.message = "ros2 CLI not found (source ROS setup?)"
            return resp
        except Exception as exc:  # noqa: BLE001
            resp.success = False
            resp.message = str(exc)
            return resp

        resp.success = True
        resp.message = "Recording"
        resp.bag_path = bag_path
        return resp

    def _cb_stop(self, _req: StopRecording.Request, resp: StopRecording.Response) -> StopRecording.Response:
        if self._proc is None or self._proc.poll() is not None:
            self._proc = None
            resp.success = False
            resp.message = "No active recording"
            return resp
        try:
            os.killpg(self._proc.pid, signal.SIGINT)
            self._proc.wait(timeout=15)
        except Exception as exc:  # noqa: BLE001
            self._proc.kill()
            resp.success = False
            resp.message = f"Stop error: {exc}"
            return resp
        finally:
            self._proc = None
        resp.success = True
        resp.message = "Stopped"
        return resp

    def destroy_node(self) -> bool:
        if self._proc is not None and self._proc.poll() is None:
            try:
                os.killpg(self._proc.pid, signal.SIGINT)
                self._proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            self._proc = None
        return super().destroy_node()


def main() -> None:
    rclpy.init()
    node = Ping360RecorderNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
