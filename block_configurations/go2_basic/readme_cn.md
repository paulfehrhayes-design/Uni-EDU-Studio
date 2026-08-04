## Uni++ EDU Studio 配置文件：Unitree Go2 基础程序

本配置文件包括：

- Go2 运动控制（SportClient）
- Go2 避障（ObstaclesAvoidClient）
- Go2 机器人服务开关（RobotStateClient）
- Go2 语音灯光（VuiClient）
- UTLidar 开关（Topic: `rt/utlidar/switch`）

## 使用须知

1. 运行前请确保机器人周围空旷、无障碍物，并随时准备急停。
2. 编程前建议按顺序连接初始化块：
   - 开始 → 初始化 Go2 通道 → 加载 Go2 依赖库
   - 然后按需要初始化各个客户端（运动/避障/服务/VUI/雷达）
3. 该配置面向教学场景，优先暴露高层动作接口，未包含低层控制。
