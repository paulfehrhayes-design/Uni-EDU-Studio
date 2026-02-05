#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "Installing dependencies..."
pip3 install -r backend/requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

echo "Starting Server..."
export PYTHONPATH=$PYTHONPATH:$DIR/unitree_sdk2_python
python3 backend/server.py