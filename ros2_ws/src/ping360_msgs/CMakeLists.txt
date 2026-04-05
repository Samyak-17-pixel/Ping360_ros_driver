cmake_minimum_required(VERSION 3.8)
project(ping360_msgs)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(std_msgs REQUIRED)
find_package(builtin_interfaces REQUIRED)

rosidl_generate_interfaces(${PROJECT_NAME}
  "msg/Ping360DeviceInformation.msg"
  "msg/Ping360ProtocolVersion.msg"
  "msg/Ping360DeviceData.msg"
  "msg/Ping360AutoDeviceData.msg"
  "msg/Ping360Status.msg"
  "msg/Ping360Derived.msg"
  "msg/Ping360ScanImageMeta.msg"
  "srv/StartRecording.srv"
  "srv/StopRecording.srv"
  DEPENDENCIES std_msgs builtin_interfaces
)

ament_export_dependencies(rosidl_default_runtime)
ament_package()
