## Uni++ EDU Studio 配置文件：Unitree H2 基础程序

本配置文件基于 `unitree_sdk2_python/example/h2`，主要包含 H2 的高层运动控制（LocoClient）。

## 使用须知

1. 运行前确保机器人周围空旷，并随时准备急停。
2. 建议初始化顺序：
   - 开始 → 初始化 H2 通道 → 初始化运动控制客户端
3. 可通过“持续运动模式”控制 Move 指令的持续行为（与 SDK 的 `SwitchMoveMode` 一致）。

