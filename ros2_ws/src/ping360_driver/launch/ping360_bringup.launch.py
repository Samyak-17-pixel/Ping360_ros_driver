"""Launch Ping360 driver, recorder, optional rosbridge, and a static HTTP server for the web UI."""

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

    driver = Node(
        package="ping360_driver",
        executable="ping360_driver_node",
        name="ping360_driver",
        output="screen",
        parameters=[
            {
                "serial_port": "/dev/ttyUSB0",
                "baud_rate": 115200,
                "frame_id": "ping360_link",
                "publish_tf_static": False,
            }
        ],
    )

    recorder = Node(
        package="ping360_driver",
        executable="ping360_recorder_node",
        name="ping360_recorder",
        output="screen",
    )

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

    http_server = ExecuteProcess(
        cmd=["python3", "-m", "http.server", "8765", "--bind", "127.0.0.1", "--directory", web_root],
        output="screen",
    )

    actions = [
        driver,
        recorder,
        rosapi,
    ]
    if have_rosbridge:
        actions.append(rosbridge)
        actions.append(
            LogInfo(
                msg="rosbridge_server: WebSocket on ws://127.0.0.1:9090 — open http://127.0.0.1:8765 for the UI."
            )
        )
    else:
        actions.append(
            LogInfo(
                msg=(
                    "rosbridge_server is not installed — driver and recorder are running, but the browser UI "
                    "needs a bridge. Install: sudo apt install ros-humble-rosbridge-suite "
                    "then relaunch (or run: ros2 run rosbridge_server rosbridge_websocket)."
                )
            )
        )
    actions.append(http_server)
    actions.append(
        LogInfo(msg="Static web UI: http://127.0.0.1:8765 (requires rosbridge for live data).")
    )

    return LaunchDescription(actions)
