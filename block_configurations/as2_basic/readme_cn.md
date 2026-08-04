## Uni++ EDU Studio 配置文件：Unitree AS2 基础程序

本配置文件基于 `unitree_sdk2_python/example/as2`，主要包含 AS2 的运动控制（SportClient）。

## 使用须知

1. 运行前确保机器人周围空旷，并随时准备急停。
2. 按顺序连接初始化块：
   - 开始 → 初始化 AS2 通道 → 初始化运动控制客户端
3. `GetState` 会打印状态字典，便于教学查看。

