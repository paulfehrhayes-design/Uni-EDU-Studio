# Teacher Guide

This is a simple classroom workflow for one robot and many students.

## 1. First-time setup
Before class:
1. Make sure the robot or host computer is connected to the same Wi-Fi as the students.
2. Start the app on the teacher machine or robot host.
3. Open the browser to the host address, for example:
   - `http://<robot-ip>:5179`
   - or `http://localhost:5173` for local development

## 2. Log in as teacher
Use the default teacher login:
- username: `teacher`
- password: `teacher`

This is the main account for classroom management.

## 3. Manage student accounts
Open the teacher **Open queue** panel and use **Manage classroom accounts** to create a student login:
- usernames are 3–32 characters and may contain letters, numbers, `_` or `-`
- initial passwords must be 8–128 characters and cannot be only whitespace
- students may register their own student accounts; public registration cannot create teacher accounts. Teachers can create student or teacher accounts and remove classroom accounts from the Open queue panel.

Use **Delete** beside an account to remove it. The currently signed-in teacher cannot delete their own account, and the last teacher account is protected. A running classroom job or active robot operation associated with the account must finish before deletion. Deletion permanently removes that user's saved programs, projects, submissions, and account-owned navigation/scan records; their login sessions are revoked. The shared classroom map is retained, with its publisher label changed to `deleted account`.

## 4. Check the classroom
The teacher view lets you:
- see student submissions
- inspect the exact queued SDK/DUET code preview and planner mode, waypoint, and map details
- load a submitted program into the teacher IDE or planner grid for review
- create and remove classroom accounts
- delete queue items
- pause or stop the current robot run
- clear the queue

## 5. Review student work
For each student submission:
1. Open **Review exact command preview** and inspect the submitted code and, for planner requests, the mode, waypoints, route variants, and map identity.
2. Use **Load for teacher review** to repopulate the IDE or planner grid. Autonomous requests are only shown on a map with the matching map ID, version, and frame.
3. Look for problems and use the simulator preview when appropriate.
4. Approve physical execution explicitly. The IDE/Blocks run prompt displays the exact program; planner run prompts show the route or initial SDK commands. Students cannot call physical execution endpoints.

## 6. Start the robot queue
When the robot is ready:
- review the exact preview for the next queued request
- click **Run next** and confirm the teacher-approval prompt to authorize that specific displayed program
- watch the simulation first if needed
- run the student code only when safe

## 7. Keep the robot safe
Use these classroom rules:
- only one robot run at a time
- keep the robot area clear
- test commands in simulation before live run
- use simple commands for younger students
- stop immediately if the robot does not behave normally

## 8. Best practice for beginner classes
Good beginner commands:
- Walk Forward
- Walk Backward
- Turn Left
- Turn Right
- Wait
- Stop
- Raise Both Arms

Use simple challenge tasks such as:
- walk to a target
- turn and walk around an obstacle
- follow a path with only a few commands

## 9. Student workflow summary
Students:
- log in
- use an account created by the teacher
- build code in Blocks or IDE
- preview the program
- submit to the queue
- wait for teacher approval

Students can also send Normal path, Sensor-corrected path, or Autonomous
obstacle-aware path requests. These include the generated command preview and
the route details needed for a teacher to load the request into their own
planner workspace. Loading a request does not execute it; a teacher must
review and explicitly approve any physical run.

Teacher:
- review queue
- start approved work
- stop or pause when needed
- keep the class organized

This keeps the robot safe and still allows multiple students to work from different devices.
