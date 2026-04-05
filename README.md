# Ping360 ROS 2 workspace

Colcon workspace under **`ros2_ws/`** with:

| Package | Path |
|---------|------|
| `ping360_msgs` | `ros2_ws/src/ping360_msgs` |
| `ping360_driver` | `ros2_ws/src/ping360_driver` |

**Full documentation** (topics, parameters, web UI, launch):  
[`ros2_ws/src/ping360_driver/README.md`](ros2_ws/src/ping360_driver/README.md)

**Git:** A [`.gitignore`](.gitignore) in this folder ignores `ros2_ws/build/`, `ros2_ws/install/`, `ros2_ws/log/`, and common Python/IDE noise. Initialize Git **here** if this directory is your repository root.

## Quick build

```bash
cd ros2_ws
source /opt/ros/humble/setup.bash
colcon build --packages-select ping360_msgs ping360_driver
source install/setup.bash
```
