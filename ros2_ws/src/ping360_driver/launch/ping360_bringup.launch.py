"""Launch Ping360 driver, recorder, optional rosbridge, and a static HTTP server for the web UI."""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, LogInfo
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node

from ping360_driver.launch_helpers import gui_node, http_server, rosapi_node, rosbridge_or_hint


def generate_launch_description() -> LaunchDescription:
    share = get_package_share_directory("ping360_driver")
    params_file = os.path.join(share, "config", "ping360_driver.yaml")

    serial_port = LaunchConfiguration("serial_port")
    baud_rate = LaunchConfiguration("baud_rate")

    driver = Node(
        package="ping360_driver",
        executable="ping360_driver_node",
        name="ping360_driver",
        output="screen",
        parameters=[
            params_file,
            {
                "serial_port": serial_port,
                "baud_rate": baud_rate,
            },
        ],
    )

    recorder = Node(
        package="ping360_driver",
        executable="ping360_recorder_node",
        name="ping360_recorder",
        output="screen",
    )

    actions = [
        DeclareLaunchArgument("serial_port", default_value="/dev/ttyUSB0"),
        DeclareLaunchArgument("baud_rate", default_value="115200"),
        driver,
        recorder,
        rosapi_node(),
        *rosbridge_or_hint(playback=False),
        gui_node(),
        http_server(),
        LogInfo(msg="Ping360 GUI: http://127.0.0.1:8080  (login host 127.0.0.1; rosbridge ws://127.0.0.1:9090)."),
        LogInfo(msg="Static topic explorer: http://127.0.0.1:8765"),
    ]
    return LaunchDescription(actions)
