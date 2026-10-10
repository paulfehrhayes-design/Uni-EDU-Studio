import sys
import os
import time
import math

sys.path.append(os.getcwd())

class Robot:
    def stand(self):
        print("Robot stand")

    def moveTo(self, x, y):
        print(f"Robot moveTo x={x} y={y}")

    def walkForward(self, speed=1.0):
        print(f"Robot walkForward speed={speed}")

    def walkBackward(self, speed=1.0):
        print(f"Robot walkBackward speed={speed}")

    def walkSidewaysLeft(self, speed=1.0):
        print(f"Robot walkSidewaysLeft speed={speed}")

    def walkSidewaysRight(self, speed=1.0):
        print(f"Robot walkSidewaysRight speed={speed}")

    def turnLeft(self, degrees=90):
        print(f"Robot turnLeft degrees={degrees}")

    def turnRight(self, degrees=90):
        print(f"Robot turnRight degrees={degrees}")

    def raiseLeftArm(self, position="mid", degrees=90):
        print(f"Robot raiseLeftArm position={position} degrees={degrees}")

    def raiseRightArm(self, position="mid", degrees=90):
        print(f"Robot raiseRightArm position={position} degrees={degrees}")

    def raiseLeftLeg(self, position="mid", degrees=90):
        print(f"Robot raiseLeftLeg position={position} degrees={degrees}")

    def raiseRightLeg(self, position="mid", degrees=90):
        print(f"Robot raiseRightLeg position={position} degrees={degrees}")

    def raiseLeftKnee(self):
        print("Robot raiseLeftKnee")

    def raiseRightKnee(self):
        print("Robot raiseRightKnee")

    def wait(self, seconds=0.5):
        time.sleep(float(seconds))

    def waveLeft(self):
        print("Robot waveLeft")

    def raiseBothArms(self):
        print("Robot raiseBothArms")

    def kick(self, level="low"):
        print(f"Robot kick level={level}")

    def danceRoutine(self):
        print("Robot danceRoutine")

    def walk(self, steps=1):
        print(f"Robot walk steps={steps}")

    def backward(self, steps=1):
        print(f"Robot backward steps={steps}")

    def turn(self, direction="left", angle=90):
        print(f"Robot turn direction={direction} angle={angle}")

    def sidestep(self, direction="left"):
        print(f"Robot sidestep direction={direction}")

robot = Robot()
robot.stand()
robot.turn("left", 5)
robot.walktime(4.736)
robot.turn("left", 146.56)
robot.walktime(9.997)
robot.walktime(3.594)
robot.turn("right", 25.91)
robot.walktime(4.459)
robot.turn("left", 95.11)
robot.walktime(7.138)
robot.turn("right", 88.33)
robot.walktime(4.889)
robot.stand()