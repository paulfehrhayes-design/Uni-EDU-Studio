## Uni++ EDU Studio Config: Unitree Go2 Basic

This configuration includes:

- Go2 sport control (SportClient)
- Go2 obstacles avoid (ObstaclesAvoidClient)
- Go2 service switches (RobotStateClient)
- Go2 VUI (VuiClient)
- UTLidar switch (Topic: `rt/utlidar/switch`)

## Notes

1. Ensure the area around the robot is clear and be ready to emergency stop.
2. Recommended init sequence:
   - Start → Init Go2 Channel → Load Go2 Dependencies
   - Then init needed clients (sport/avoid/state/vui/lidar)
3. This config is designed for education and uses high-level APIs only.

