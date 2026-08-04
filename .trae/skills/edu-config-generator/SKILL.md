---
name: "edu-config-generator"
description: "从 unitree_sdk2py 的 API Python 文件与 example 脚本生成 Uni++ EDU Studio 的 block_configurations JSON。Invoke when user asks to add/refresh robot block configs from SDK examples/APIs."
---

# EDU Config Generator

用于把 `unitree_sdk2py` 的 API 客户端文件（例如 `sport_client.py`）与示例脚本（例如 `go2_sport_client.py`）转成 Uni++ EDU Studio 可导入的机器人配置 JSON。

## 适用场景

- 需要新增机器人型号的配置（as2/r1/h2 等）
- SDK 升级后需要快速对齐 API 方法列表
- 希望基于示例脚本自动推断 client 变量名（例如 `sport_client`、`avoid_client`）

## 生成脚本

仓库内置生成脚本：

- [edu_config_gen.py](file:///home/unitree/brigham/DEV/Uni-EDU-Studio/tools/edu_config_gen.py)

## 使用方法

在仓库根目录执行：

```bash
python tools/edu_config_gen.py \
  --robot-prefix go2 \
  --api unitree_sdk2_python/unitree_sdk2py/go2/sport/sport_client.py \
  --api unitree_sdk2_python/unitree_sdk2py/go2/obstacles_avoid/obstacles_avoid_client.py \
  --example unitree_sdk2_python/example/go2/high_level/go2_sport_client.py \
  --out /tmp/go2_generated.json
```

## 输出说明

- 输出文件是一个可直接导入 EDU Studio 的 JSON
- 顶层自动包含 `System` 分类：
  - `Start`（基础 import）
  - `Init Channel`（ChannelFactoryInitialize）
  - `Load Modules`（自动生成 `from unitree_sdk2py... import ClassName`）
- 每个 API Client 类会生成一个分类：
  - `Init <ClassName>`：初始化 client 并调用 `SetTimeout(10.0)` + `Init()`
  - 为类内所有公开方法生成一个 statement block（方法参数会转成 field_input/field_number/field_dropdown）

