"""Shared launch helpers: static HTTP UI and optional rosbridge."""

from __future__ import annotations

import os

from ament_index_python.packages import PackageNotFoundError, get_package_prefix, get_package_share_directory
from launch.actions import ExecuteProcess, LogInfo
from launch_ros.actions import Node


def web_root() -> str:
    return os.path.join(get_package_share_directory("ping360_driver"), "web")


def have_rosbridge() -> bool:
    try:
        get_package_prefix("rosbridge_server")
        return True
    except PackageNotFoundError:
        return False


def rosapi_node() -> Node:
    return Node(
        package="rosapi",
        executable="rosapi_node",
        name="rosapi",
        output="screen",
    )


def rosbridge_node() -> Node:
    return Node(
        package="rosbridge_server",
        executable="rosbridge_websocket",
        name="rosbridge_websocket",
        output="screen",
        parameters=[
            {"port": 9090},
            {"max_message_size": 100000000},
        ],
    )


def gui_node() -> Node:
    return Node(
        package="ping360_driver",
        executable="ping360_gui",
        name="ping360_gui",
        output="screen",
        additional_env={
            "PING360_VIEWER_HOST": "127.0.0.1",
            "PING360_VIEWER_PORT": "8080",
            "PING360_GUI_SKIP_SSH": "1",
        },
    )


def http_server() -> ExecuteProcess:
    return ExecuteProcess(
        cmd=["python3", "-m", "http.server", "8765", "--bind", "127.0.0.1", "--directory", web_root()],
        output="screen",
    )


def rosbridge_or_hint(*, playback: bool) -> list:
    if have_rosbridge():
        if playback:
            msg = (
                "Playback UI: open http://127.0.0.1:8765 then run in another terminal: "
                "ros2 bag play YOUR_BAG --remap /scan_image:=/ping360/scan_image"
            )
        else:
            msg = (
                "rosbridge_server: WebSocket on ws://127.0.0.1:9090 — "
                "GUI http://127.0.0.1:8080, explorer http://127.0.0.1:8765."
            )
        return [rosbridge_node(), LogInfo(msg=msg)]
    if playback:
        hint = "Install ros-humble-rosbridge-suite for the web UI, then relaunch this file."
    else:
        hint = (
            "rosbridge_server is not installed — driver and recorder are running, but the browser UI "
            "needs a bridge. Install: sudo apt install ros-humble-rosbridge-suite "
            "then relaunch (or run: ros2 run rosbridge_server rosbridge_websocket)."
        )
    return [LogInfo(msg=hint)]
