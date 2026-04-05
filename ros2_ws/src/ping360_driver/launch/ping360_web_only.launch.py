"""Rosbridge + static HTTP only — use with `ros2 bag play` to view recorded data in the browser (no serial driver)."""

import os

from ament_index_python.packages import PackageNotFoundError, get_package_prefix, get_package_share_directory
from launch import LaunchDescription
from launch.actions import ExecuteProcess, LogInfo
from launch_ros.actions import Node


def generate_launch_description() -> LaunchDescription:
    web_root = os.path.join(get_package_share_directory("ping360_driver"), "web")

    try:
        get_package_prefix("rosbridge_server")
        have_rosbridge = True
    except PackageNotFoundError:
        have_rosbridge = False

    rosapi = Node(
        package="rosapi",
        executable="rosapi_node",
        name="rosapi",
        output="screen",
    )

    rosbridge = Node(
        package="rosbridge_server",
        executable="rosbridge_websocket",
        name="rosbridge_websocket",
        output="screen",
        parameters=[
            {"port": 9090},
            {"max_message_size": 100000000},
        ],
    )

    http_server_cmd = [
        "python3",
        "-m",
        "http.server",
        "8765",
        "--bind",
        "127.0.0.1",
        "--directory",
        web_root,
    ]

    http_server = ExecuteProcess(cmd=http_server_cmd, output="screen")

    actions = [rosapi]
    if have_rosbridge:
        actions.append(rosbridge)
        actions.append(
            LogInfo(
                msg=(
                    "Playback UI: open http://127.0.0.1:8765 then run in another terminal: "
                    "ros2 bag play YOUR_BAG --remap /scan_image:=/ping360/scan_image"
                )
            )
        )
    else:
        actions.append(
            LogInfo(
                msg="Install ros-humble-rosbridge-suite for the web UI, then relaunch this file."
            )
        )
    actions.append(http_server)
    return LaunchDescription(actions)
