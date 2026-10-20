FROM ros:humble-ros-base-jammy

ENV DEBIAN_FRONTEND=noninteractive
ENV CMAKE_BUILD_PARALLEL_LEVEL=2
ENV LD_LIBRARY_PATH=/usr/local/lib:/usr/local/lib/aarch64-linux-gnu
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    libapr1-dev \
    libpcl-dev \
    python3-colcon-common-extensions \
    ros-humble-launch-ros \
    ros-humble-pcl-conversions \
    ros-humble-sensor-msgs-py \
    ros-humble-std-msgs \
    ros-humble-tf2-ros \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/Livox-SDK/Livox-SDK2.git /tmp/Livox-SDK2 \
    && cmake -S /tmp/Livox-SDK2 -B /tmp/Livox-SDK2/build \
    && cmake --build /tmp/Livox-SDK2/build --parallel 2 \
    && cmake --install /tmp/Livox-SDK2/build \
    && ldconfig \
    && ldconfig -p | grep -F 'liblivox_lidar_sdk_shared.so' \
    && rm -rf /tmp/Livox-SDK2

RUN mkdir -p /opt/livox_ws/src \
    && git clone --depth 1 https://github.com/Livox-SDK/livox_ros_driver2.git \
        /opt/livox_ws/src/livox_ros_driver2 \
    && cd /opt/livox_ws/src/livox_ros_driver2 \
    && source /opt/ros/humble/setup.bash \
    && bash -e ./build.sh humble \
    && rm -rf /opt/livox_ws/src/livox_ros_driver2/.git

COPY backend/ros/mid360_launch.py /opt/uni-edu/ros/mid360_launch.py
COPY backend/ros_lidar_provider.py /opt/uni-edu/ros_lidar_provider.py
COPY backend/ros/docker/entrypoint.sh /usr/local/bin/uni-edu-ros-entrypoint

RUN chmod 755 /usr/local/bin/uni-edu-ros-entrypoint

ENTRYPOINT ["/usr/local/bin/uni-edu-ros-entrypoint"]
