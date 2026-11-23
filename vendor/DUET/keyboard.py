"""keyboard_to_wireless.py — keyboard → rt/wirelesscontroller DDS publisher.

Keys:
  1           : F1 pulse → FixStand.  From Passive this arms the robot; from
                Velocity it is the HARNESS HOLD: the legs ease into a fixed
                stance over 3 s and hold it under PD. Press this BEFORE lifting
                the robot -- with the feet off the floor the policy has no
                ground reaction and will thrash. Press 2 to hand back afterwards.
  2           : F2 pulse (FixStand → Velocity, policy active)
  Enter       : no DUET FSM mapping (use the app's explicit Stop control)
  W / S       : vx forward / backward       (ly)
  A / D       : vy left / right             (lx)
  Q / E       : wz yaw left / right         (rx)
  Space       : zero stick velocities
  Y / X       : raise / lower the bounded stand-height target
  Arrow keys  : no DUET action; the documented R1+D-pad offsets are unsupported
  Gamepad A/B : no standalone direct DUET handheld action (keyboard A/D strafe)
  Ctrl-C      : quit
"""
import time, threading, sys, termios, tty, select
from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelPublisher
from unitree_sdk2py.idl.unitree_go.msg.dds_ import WirelessController_
from unitree_sdk2py.idl.default import unitree_go_msg_dds__WirelessController_

# NETWORK_IFACE = "enp132s0"
NETWORK_IFACE = "lo"
PUBLISH_HZ = 100

VX_MAX = 0.4
VY_MAX = 0.3
WZ_MAX = 0.6
# Bit positions — verified uint16-safe
KEY_F1    = 1 << 6   # bit 6
KEY_F2    = 1 << 7   # bit 7
KEY_Y     = 1 << 11   # bit 11 — Y button
KEY_X     = 1 << 10   # bit 10 — X button

PULSE_FRAMES = 15

state = {
    "lx": 0.0, "ly": 0.0, "rx": 0.0,
    "ry": 0.0,  # DUET does not use this axis for stand height.
    "pulse_bits": 0,
    "pulse_remaining": 0,
    "running": True,
}
lock = threading.Lock()

def fire_pulse(bits, label):
    with lock:
        state["pulse_bits"] |= bits      # OR with existing bits
        state["pulse_remaining"] = max(state["pulse_remaining"], PULSE_FRAMES)
    print(f"  [{label}]")

def keyboard_loop():
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        print("Keyboard publisher running.")
        print("  1=F1(FixStand)  2=F2(Velocity)  Enter=unmapped")
        print("  WASD=move  Q/E=yaw  Space=stop")
        print("  Y=raise stand height  X=lower stand height  (policy-bounded)")
        print("  Arrow keys and gamepad A/B have no standalone DUET action")
        print("  (keyboard A/D still strafe)")
        print("  Ctrl-C=quit\n")
        while state["running"]:
            r, _, _ = select.select([sys.stdin], [], [], 0.05)
            if not r:
                continue
            ch = sys.stdin.read(1)

            # Consume terminal arrow sequences; DUET does not implement the
            # reference controller's R1+D-pad body offsets.
            if ch == '\x1b':
                sys.stdin.read(2)
                continue

            low = ch.lower()

            # Velocity / height
            if   low == 'w':
                state["ly"] = VX_MAX;   print(f"  [W] ly={VX_MAX:+.2f}")
            elif low == 's':
                state["ly"] = -VX_MAX;  print(f"  [S] ly={-VX_MAX:+.2f}")
            elif low == 'a':
                state["lx"] = -VY_MAX;  print(f"  [A] lx={-VY_MAX:+.2f}")
            elif low == 'd':
                state["lx"] = VY_MAX;   print(f"  [D] lx={VY_MAX:+.2f}")
            elif low == 'q':
                state["rx"] = -WZ_MAX;  print(f"  [Q] rx={-WZ_MAX:+.2f}")
            elif low == 'e':
                state["rx"] = WZ_MAX;   print(f"  [E] rx={WZ_MAX:+.2f}")
            elif low == ' ':
                with lock:
                    state["lx"] = state["ly"] = state["rx"] = 0.0
                print("  [SPACE] zero velocity")
            # Y/X are bounded stand-height adjustments in the policy observation.
            elif low == 'y':
                fire_pulse(KEY_Y, "Y → stand height +")
            elif low == 'x':
                fire_pulse(KEY_X, "X → stand height -")

            # FSM transitions
            elif ch == '1':
                fire_pulse(KEY_F1, "1 → F1 (FixStand)")
            elif ch == '2':
                fire_pulse(KEY_F2, "2 → F2 (Velocity)")
            elif ch == '\x03':
                state["running"] = False
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)

def main():
    ChannelFactoryInitialize(0, NETWORK_IFACE)
    pub = ChannelPublisher("rt/wirelesscontroller", WirelessController_)
    pub.Init()

    t = threading.Thread(target=keyboard_loop, daemon=True)
    t.start()

    period = 1.0 / PUBLISH_HZ
    try:
        while state["running"]:
            msg = unitree_go_msg_dds__WirelessController_()
            with lock:
                msg.lx = state["lx"]
                msg.ly = state["ly"]
                msg.rx = state["rx"]
                msg.ry = state["ry"]
                msg.keys = state["pulse_bits"]
                if state["pulse_remaining"] > 0:
                    state["pulse_remaining"] -= 1
                else:
                    state["pulse_bits"] = 0
            pub.Write(msg)
            time.sleep(period)
    except KeyboardInterrupt:
        pass
    state["running"] = False
    time.sleep(0.2)
    print("\nStopped.")

if __name__ == "__main__":
    main()


