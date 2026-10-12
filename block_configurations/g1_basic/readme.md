## Uni++ EDU Studio Configuration File: Unitree G1 Basic Program

This legacy configuration file describes:

* **Unitree G1 High-level Control** (only safe actions are accessible)
* **Arm Motion Control**
  * Supports pre-recorded teaching actions
* **Audio and Light Interface Control**

This configuration was originally intended for K-12 programming and beginners. It does not certify that its actions are safe for a particular robot.

> The current web IDE and Blocks toolbox use the shared executable command catalog, not this legacy JSON. Physical runs expose bounded locomotion commands, the 16 fixed built-in arm presets, read-only arm-action diagnostics, and selected audio controls through the app's SDK adapter. Arbitrary recorded-action names, raw FSM controls, and binary audio streaming are not exposed. The G1 SDK does not provide an arm-action cancel API; the app's Stop control stops locomotion only.

---

## Supported Models

* Unitree G1 EDU Flagship (U1 only supports partial actions)
* Unitree G1 EDU Professional

**Not Compatible With:**

* Unitree G1 Basic / Air
* Unitree G1-D Data Collection Kit

---

## Usage Notice

Before programming, please ensure the Unitree G1 is powered on normally, standing up, and has entered any motion control mode. **Usage is not supported while the robot is in a lying position.**

To use motion control, arm actions, or audio/light features, you must first initialize the respective dependencies and the robot. The initialization process is shown in the image below:

![1770293913959](image/readme/1770293913959.png)

If you are deploying Uni++ EDU Studio on the Unitree G1's  **PC2** , there is no need to modify the **Domain** or  **Network Interface Card (NIC)** . Otherwise, please modify these settings according to your specific hardware setup.

---

**Translation Complete.** I have maintained the technical terminology and the specific request regarding the image placeholder format.

Would you like me to translate more documentation or help you with the custom configuration upload guide?
