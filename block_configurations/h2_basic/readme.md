## Uni++ EDU Studio Config: Unitree H2 Basic

This configuration is based on `unitree_sdk2_python/example/h2` and provides high-level locomotion control (LocoClient).

## Notes

1. Ensure the area around the robot is clear and be ready to emergency stop.
2. Recommended init sequence:
   - Start → Init H2 Channel → Init Loco Client
3. `SwitchMoveMode` controls the continuous behavior of `Move`.

