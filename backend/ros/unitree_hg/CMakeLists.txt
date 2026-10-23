cmake_minimum_required(VERSION 3.8)
project(unitree_hg)

find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(rosidl_generator_dds_idl REQUIRED)

rosidl_generate_interfaces(${PROJECT_NAME}
  "msg/IMUState.msg"
  "msg/LowState.msg"
  "msg/MotorState.msg"
)

rosidl_generate_dds_interfaces(
  ${PROJECT_NAME}__dds_connext_idl
  IDL_TUPLES ${rosidl_generate_interfaces_IDL_TUPLES}
  OUTPUT_SUBFOLDERS "dds_connext"
)
add_dependencies(
  ${PROJECT_NAME}
  ${PROJECT_NAME}__dds_connext_idl
)

ament_export_dependencies(rosidl_default_runtime)
ament_package()
