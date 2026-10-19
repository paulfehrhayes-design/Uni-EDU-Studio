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
- preview saved code
- create and remove classroom accounts
- delete queue items
- pause or stop the current robot run
- clear the queue

## 5. Review student work
For each student submission:
1. Open the code.
2. Look for obvious problems.
3. Use the simulator preview before running.
4. Approve or reject the job.

## 6. Start the robot queue
When the robot is ready:
- click the queue action to start the next item
- watch the simulation first if needed
- run the student code when safe

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

Teacher:
- review queue
- start approved work
- stop or pause when needed
- keep the class organized

This keeps the robot safe and still allows multiple students to work from different devices.
