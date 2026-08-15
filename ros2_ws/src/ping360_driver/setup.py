import os

from setuptools import find_packages, setup

package_name = "ping360_driver"


def share_tree(src_dir: str) -> list[tuple[str, list[str]]]:
    entries: list[tuple[str, list[str]]] = []
    for root, _, files in os.walk(src_dir):
        if not files:
            continue
        install_dir = os.path.join("share", package_name, root)
        entries.append((install_dir, [os.path.join(root, name) for name in files]))
    return entries


setup(
    name=package_name,
    version="1.0.0",
    packages=find_packages(exclude=["test"]),
    package_data={
        "ping360_driver.gui": ["static/*"],
        "ping360_driver.gui.static": ["*.html", "*.js", "*.css"],
    },
    include_package_data=True,
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        *share_tree("web"),
        *share_tree("launch"),
        *share_tree("config"),
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
            "ping360_gui = ping360_driver.gui.main:main",
        ],
    },
)
