## Uni++ EDU Studio 配置文件：Unitree R1 基础程序

本配置文件基于 `unitree_sdk2_python/example/r1`，主要包含 R1 的高层运动控制（LocoClient）。

## 使用须知

1. 运行前确保机器人周围空旷，并随时准备急停。
2. 建议初始化顺序：
   - 开始 → 初始化 R1 通道 → 初始化运动控制客户端
3. `Start` 会进入运动模式，请确保机器人姿态/悬挂等条件符合 SDK 示例要求。

