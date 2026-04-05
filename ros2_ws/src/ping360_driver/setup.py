from setuptools import find_packages, setup

package_name = "ping360_driver"

setup(
    name=package_name,
    version="1.0.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        (
            "share/" + package_name + "/web",
            [
                "web/index.html",
                "web/app.js",
                "web/styles.css",
                "web/viz.js",
                "web/turbo_lut.js",
                "web/topic_explorer.js",
                "web/message_viz.js",
            ],
        ),
        (
            "share/" + package_name + "/launch",
            ["launch/ping360_bringup.launch.py", "launch/ping360_web_only.launch.py"],
        ),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="user",
    maintainer_email="user@example.com",
    description="Ping360 ROS 2 driver and web UI assets",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "ping360_driver_node = ping360_driver.driver_node:main",
            "ping360_recorder_node = ping360_driver.recorder_node:main",
        ],
    },
)
