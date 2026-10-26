cmake_minimum_required(VERSION 3.8)
project(g1_bridge_bringup)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
endif()

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(rclcpp REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(std_srvs REQUIRED)
find_package(unitree_api REQUIRED)
find_package(unitree_hg REQUIRED)

add_executable(g1_cmd_vel_bridge src/g1_cmd_vel_bridge.cpp)
target_include_directories(g1_cmd_vel_bridge PRIVATE include)
ament_target_dependencies(
  g1_cmd_vel_bridge
  geometry_msgs
  rclcpp
  std_srvs
  unitree_api
)

add_executable(g1_low_state_bridge src/g1_low_state_bridge.cpp)
target_include_directories(g1_low_state_bridge PRIVATE include)
ament_target_dependencies(
  g1_low_state_bridge
  rclcpp
  sensor_msgs
  unitree_hg
)

install(
  TARGETS
    g1_cmd_vel_bridge
    g1_low_state_bridge
  DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY launch config DESTINATION share/${PROJECT_NAME})

ament_package()
