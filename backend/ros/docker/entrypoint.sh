#!/usr/bin/env bash
set -eo pipefail

source /opt/ros/humble/setup.bash
source /opt/livox_ws/install/setup.bash
source /opt/g1_state_ws/install/setup.bash

set -u
exec "$@"
