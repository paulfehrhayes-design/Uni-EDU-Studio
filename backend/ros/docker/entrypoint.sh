#!/usr/bin/env bash
set -eo pipefail

source /opt/ros/humble/setup.bash
if [[ -f /opt/livox_ws/install/setup.bash ]]; then
  source /opt/livox_ws/install/setup.bash
fi
source /opt/g1_state_ws/install/setup.bash

set -u
exec "$@"
