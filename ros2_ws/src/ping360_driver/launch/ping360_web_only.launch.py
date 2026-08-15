"""Rosbridge + static HTTP only — use with `ros2 bag play` (no serial driver)."""

from launch import LaunchDescription

from ping360_driver.launch_helpers import gui_node, http_server, rosapi_node, rosbridge_or_hint


def generate_launch_description() -> LaunchDescription:
    return LaunchDescription(
        [
            rosapi_node(),
            *rosbridge_or_hint(playback=True),
            gui_node(),
            http_server(),
        ]
    )
