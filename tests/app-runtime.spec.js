import { test, expect } from '@playwright/test';
import { getG1BlocklyCommandBlocks, parseG1Program } from '../src/sim/g1Commands.js';
import { getDuetBlocklyCommandBlocks, parseDuetProgram } from '../src/sim/duetCommands.js';

async function openConnectionPanel(page) {
  await page.getByRole('button', { name: 'Open robot connection' }).click();
}

test('login starts blank and determines role from the account', async ({ page }) => {
  let loginPayload;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/classroom/login') {
      loginPayload = request.postDataJSON();
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(path === '/api/classroom/login'
        ? { token: 'student-login-token', user: { role: 'student', username: 'student-login-test' } }
        : {}),
    });
  });

  await page.goto('/');
  await expect(page.locator('input[type="text"]')).toHaveValue('');
  const passwordInput = page.locator('input[autocomplete="current-password"]');
  await expect(passwordInput).toHaveAttribute('type', 'password');
  await expect(passwordInput).toHaveValue('');
  await expect(page.getByLabel('Role')).toHaveCount(0);
  await expect(page.getByText('Teacher demo: teacher / teacher')).toHaveCount(0);
  await expect(page.getByText('Student demo: student1 / student1')).toHaveCount(0);

  await page.locator('input[type="text"]').fill('student-login-test');
  await passwordInput.fill('classroom-password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(passwordInput).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(passwordInput).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect.poll(() => loginPayload).toEqual({
    username: 'student-login-test',
    password: 'classroom-password',
  });
  await expect(page.getByRole('button', { name: 'Open queue' })).toHaveCount(0);
});

test('legacy and DUET expose the same approximate in-place 180-degree turn name', () => {
  const legacy = parseG1Program('robot.turn_around_180()');
  const duet = parseDuetProgram('duet.turn_around_180()');
  expect(legacy[0].method).toBe('turn_around_180');
  expect(duet[0].method).toBe('turn_around_180');
  expect(duet[0].code).toBe('duet.turn_around_180()');
  expect(getG1BlocklyCommandBlocks().some((block) => block.type === 'g1_command_turn_around_180')).toBe(true);
  expect(getDuetBlocklyCommandBlocks().some((block) => block.type === 'duet_command_turn_around_180')).toBe(true);
});

test('teacher robot connection opens from the top bar beside Settings', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(path === '/api/classroom/login'
        ? {
          token: 'teacher-connection-panel-token',
          user: { role: 'teacher', username: 'teacher-connection-panel-test' },
        }
        : {}),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page.getByRole('button', { name: 'Open robot connection' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open app settings' })).toBeVisible();
  const toolbarOrder = await page.getByRole('button', { name: 'Open robot connection' }).evaluate((button) => (
    Array.from(button.parentElement.children, (item) => item.textContent.trim())
  ));
  expect(toolbarOrder).toEqual(['Connection', 'Objects', 'Project', 'Settings', 'Configure', 'Logout']);
  await openConnectionPanel(page);

  await expect(page.getByRole('dialog', { name: 'Robot connection panel' })).toBeVisible();
  await expect(page.getByTestId('teacher-robot-settings')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Teacher Queue' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Internal Simulator/ })).toHaveCount(0);
});

test('simulation preview controls are in app Settings, not the G1 simulator', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(path === '/api/classroom/login'
        ? {
          token: 'teacher-preview-settings-token',
          user: { role: 'teacher', username: 'teacher-preview-settings-test' },
        }
        : {}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Log In' }).click();
  await page.getByRole('button', { name: 'Open app settings' }).click();

  const previewSettings = page.getByRole('group', { name: 'Simulation preview' });
  await expect(previewSettings.getByRole('button', { name: 'Kid preview' })).toHaveAttribute('aria-pressed', 'true');
  await previewSettings.getByRole('button', { name: 'Advanced physics' }).click();
  await expect(previewSettings.getByRole('button', { name: 'Advanced physics' })).toHaveAttribute('aria-pressed', 'true');
  await expect(previewSettings.getByText('20 m x 20 m')).toBeVisible();
  await expect(previewSettings.getByText('1.0x')).toBeVisible();
  await expect(previewSettings.getByText('Speed changes timing only. Distances remain in meters.')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('button', { name: 'Open queue' }).click();
  await expect(page.getByRole('heading', { name: /Internal Simulator/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open simulator settings panel' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Kid preview' })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Simulation grid size' })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Simulation speed' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close queue' }).click();

  await page.getByRole('button', { name: 'Open objects area' }).click();
  const objectArea = page.getByRole('dialog', { name: 'Objects area' });
  await expect(objectArea).toBeVisible();
  await expect(objectArea.getByRole('button', { name: 'Box' })).toBeVisible();
  await objectArea.getByRole('button', { name: 'Box' }).click();
  await objectArea.getByRole('button', { name: 'Scene Objects' }).click();
  await expect(objectArea.getByText('Box', { exact: true })).toBeVisible();
  await expect(objectArea.getByRole('button', { name: 'Delete' })).toBeVisible();
  await expect(objectArea.getByRole('heading', { name: /Internal Simulator/ })).toHaveCount(0);
});

test('teacher records measured DUET arm samples and saves them for simulator playback', async ({ page }) => {
  test.setTimeout(60000);
  const savedPayloads = [];
  const apiRequests = [];
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-arm-recording-token',
      user: { role: 'teacher', username: 'teacher-arm-recording-test' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    apiRequests.push(`${request.method()} ${path}`);
    let body = {};
    if (path === '/api/duet/status') {
      body = {
        status: 'connected',
        connected: true,
        ready: true,
        controlLease: true,
        motionOwner: 'duet',
        motionActive: false,
        programActive: false,
        robotModel: 'Unitree G1 EDU 23-DOF',
        capabilities: ['base_velocity', 'arm_targets', 'arm_feedback'],
        measuredJoints: Array(10).fill(0),
      };
    } else if (path === '/api/robot/recordings' && request.method() === 'GET') {
      body = { recordings: [] };
    } else if (path === '/api/robot/recordings' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      savedPayloads.push(payload);
      body = {
        recording: {
          id: 'capture_test123456',
          name: payload.name,
          controller_version: payload.controller_version,
          command: payload.command,
          joint_names: payload.joint_names,
          frames: payload.frames,
          created_at: '2026-11-12 00:00:00',
        },
      };
    } else if (path === '/api/duet/run') {
      body = { status: 'completed', commandsExecuted: 1, armTelemetry: [] };
    } else if (path === '/api/classroom/safe-mode') {
      body = { enabled: false };
    } else if (path === '/api/classroom/simulation-visibility') {
      body = { show_simulation: true };
    } else if (path === '/api/classroom/sidebar-settings') {
      body = { locked_panels: [], configured: true };
    } else if (path === '/api/classroom/me') {
      body = { data_revision: 0 };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open app settings' }).click();
  await page.getByRole('checkbox', { name: 'Enable DUET version two' }).check();
  await expect(page.getByText('DUET v2 and fresh measured arm feedback are ready.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Recorded motion name' }).fill('Measured wave');
  await page.getByRole('checkbox', { name: 'Confirm robot arm workspace is clear' }).check();
  await page.getByRole('button', { name: 'Run & record on robot' }).click();
  await expect.poll(() => savedPayloads.length, { timeout: 8000 }).toBe(1);
  await expect(page.getByText('Measured wave', { exact: true })).toBeVisible();
  expect(apiRequests).toContain('POST /api/duet/run');
  expect(savedPayloads).toHaveLength(1);
  expect(savedPayloads[0].name).toBe('Measured wave');
  expect(savedPayloads[0].controller_version).toBe('duet');
  expect(savedPayloads[0].frames.length).toBeGreaterThanOrEqual(2);
  expect(savedPayloads[0].joint_names).toHaveLength(10);
  expect(savedPayloads[0].frames[0]).toEqual({ time: 0, joints: Array(10).fill(0) });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCount(0);
});

test('teacher records full measured legacy SDK joint samples and exports them', async ({ page }) => {
  test.setTimeout(60000);
  const savedPayloads = [];
  const apiRequests = [];
  const jointNames = [
    'left_hip_pitch_joint', 'left_hip_roll_joint', 'left_hip_yaw_joint',
    'left_knee_joint', 'left_ankle_pitch_joint', 'left_ankle_roll_joint',
    'right_hip_pitch_joint', 'right_hip_roll_joint', 'right_hip_yaw_joint',
    'right_knee_joint', 'right_ankle_pitch_joint', 'right_ankle_roll_joint',
    'waist_yaw_joint', 'left_shoulder_pitch_joint', 'left_shoulder_roll_joint',
    'left_shoulder_yaw_joint', 'left_elbow_joint', 'left_wrist_roll_joint',
    'right_shoulder_pitch_joint', 'right_shoulder_roll_joint', 'right_shoulder_yaw_joint',
    'right_elbow_joint', 'right_wrist_roll_joint',
  ];
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-legacy-recording-token',
      user: { role: 'teacher', username: 'teacher-legacy-recording-test' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    apiRequests.push(`${request.method()} ${path}`);
    let body = {};
    if (path === '/api/robot/status') {
      body = { sdkAvailable: true, running: false, status: 'connected' };
    } else if (path === '/api/robot/joint-state') {
      body = {
        joint_names: jointNames,
        positions_rad: Array(23).fill(0),
        received_at: '2026-11-12T00:00:00Z',
        age_ms: 10,
      };
    } else if (path === '/api/robot/recordings' && request.method() === 'GET') {
      body = { recordings: [] };
    } else if (path === '/api/robot/recordings' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      savedPayloads.push(payload);
      body = {
        recording: {
          id: 'capture_legacytest1',
          ...payload,
          created_at: '2026-11-12T00:00:00Z',
        },
      };
    } else if (path === '/api/run') {
      body = { status: 'completed', commandsExecuted: 1 };
    } else if (path === '/api/classroom/safe-mode') {
      body = { enabled: false };
    } else if (path === '/api/classroom/simulation-visibility') {
      body = { show_simulation: true };
    } else if (path === '/api/classroom/sidebar-settings') {
      body = { locked_panels: [], configured: true };
    } else if (path === '/api/classroom/me') {
      body = { data_revision: 0 };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open app settings' }).click();
  await expect(page.getByText('Legacy SDK and fresh 23-joint ROS telemetry are ready.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Recorded motion name' }).fill('Legacy face wave');
  await page.getByRole('checkbox', { name: 'Confirm robot arm workspace is clear' }).check();
  await page.getByRole('button', { name: 'Run & record on robot' }).click();
  await expect.poll(() => savedPayloads.length, { timeout: 8000 }).toBe(1);
  expect(apiRequests).toContain('POST /api/run');
  expect(savedPayloads[0].controller_version).toBe('legacy');
  expect(savedPayloads[0].command).toBe('robot.arm_action("face wave")');
  expect(savedPayloads[0].joint_names).toEqual(jointNames);
  expect(savedPayloads[0].frames.length).toBeGreaterThanOrEqual(2);
  expect(savedPayloads[0].frames[0].joints).toHaveLength(23);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export all JSON' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('g1-recorded-motions.json');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCount(0);
});

test('only teachers can hide the simulation from Settings', async ({ page }) => {
  const visibilityUpdates = [];
  let showSimulation = true;
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-simulation-visibility-token',
      user: { role: 'teacher', username: 'teacher-simulation-visibility-test' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/classroom/simulation-visibility') {
      if (request.method() === 'PUT') {
        showSimulation = request.postDataJSON().show_simulation;
        visibilityUpdates.push(showSimulation);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ show_simulation: showSimulation }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(path === '/api/classroom/login'
        ? { token: 'teacher-simulation-visibility-token', user: { role: 'teacher', username: 'teacher-simulation-visibility-test' } }
        : {}),
    });
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide simulation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open app settings' }).click();
  const visibilityToggle = page.getByRole('checkbox', { name: 'Show 3D simulation in the workspace' });
  await expect(visibilityToggle).toBeChecked();
  await expect(visibilityToggle).toBeEnabled();
  await visibilityToggle.uncheck();
  await expect.poll(() => visibilityUpdates).toEqual([false]);
  await expect(page.getByTestId('simulation-view')).toHaveCount(0);
  const workspacePanel = page.getByTestId('workspace-panel');
  const expandedWorkspace = await workspacePanel.evaluate((panel) => ({
    position: getComputedStyle(panel).position,
    width: panel.getBoundingClientRect().width,
    height: panel.getBoundingClientRect().height,
    sceneWidth: panel.parentElement.getBoundingClientRect().width,
    sceneHeight: panel.parentElement.getBoundingClientRect().height,
  }));
  expect(expandedWorkspace.position).toBe('relative');
  expect(expandedWorkspace.width).toBeCloseTo(expandedWorkspace.sceneWidth);
  expect(expandedWorkspace.height).toBeCloseTo(expandedWorkspace.sceneHeight);
  await visibilityToggle.check();
  await expect.poll(() => visibilityUpdates).toEqual([false, true]);
  await expect(page.getByTestId('simulation-view')).toBeVisible();
});

test('student accounts follow the teacher saved simulation visibility', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'student-simulation-visibility-token',
      user: { role: 'student', username: 'student-simulation-visibility-test' },
    }));
  });
  let visibilityRead = false;
  let showSimulation = true;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/classroom/simulation-visibility') {
      visibilityRead = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ show_simulation: showSimulation }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('simulation-view')).toBeVisible();
  expect(visibilityRead).toBe(true);
  showSimulation = false;
  await expect(page.getByTestId('simulation-view')).toHaveCount(0, { timeout: 10000 });
  await page.getByRole('button', { name: 'Open app settings' }).click();
  await expect(page.getByRole('checkbox', { name: 'Show 3D simulation in the workspace' })).toHaveCount(0);
});

test('App loads without runtime initialization errors', async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Log In' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Account' })).toBeVisible();

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('public account registration creates a student account only', async ({ page }) => {
  let registration;
  await page.route('**/api/classroom/register', async (route) => {
    registration = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        token: 'registered-student-token',
        user: { username: 'new_student', role: 'student' },
      }),
    });
  });
  await page.route('**/api/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/classroom/register') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('button', { name: 'Create Student Account' })).toBeVisible();
  await expect(page.getByLabel('Role')).toHaveCount(0);
  await page.locator('input[autocomplete="username"]').fill('new_student');
  await page.locator('input[autocomplete="new-password"]').fill('new-student-password');
  await page.getByRole('button', { name: 'Create Student Account' }).click();

  await expect.poll(() => registration).toEqual({
    username: 'new_student',
    password: 'new-student-password',
  });
  await expect(page.getByText('Student workspace')).toBeVisible();
});

test('starter motion library is visible to students and loading an example does not run it', async ({ page }) => {
  const loadRequests = [];
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'starter-library-student-token',
      user: { role: 'student', username: 'motion_student' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/classroom/codes') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          codes: [],
          shared_motions: [],
          starter_codes: [{
            name: 'walk-forward',
            title: 'Walk Forward',
            description: 'One short example.',
            controller_version: 'legacy',
            code: 'robot.stand()\nrobot.wait(2)\nrobot.walk(2)',
            builtin: true,
          }],
        }),
      });
      return;
    }
    if (['/api/run', '/api/duet/run', '/api/classroom/submit-code'].includes(url.pathname)) {
      loadRequests.push(url.pathname);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.getByText('Starter motion library')).toBeVisible();
  await expect(page.getByText('walk-forward', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load into editor' }).click();
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toHaveCount(0);
  expect(loadRequests).toEqual([]);
});

test('shared motion preview loads the sequence and closes Library without running it', async ({ page }) => {
  const loadRequests = [];
  const sequence = 'robot.stand()\nrobot.walk(1)';
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'shared-motion-student-token',
      user: { role: 'student', username: 'motion_student' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (['/api/run', '/api/duet/run', '/api/classroom/submit-code'].includes(path)) {
      loadRequests.push(path);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(path === '/api/classroom/codes'
        ? {
          codes: [],
          starter_codes: [],
          shared_motions: [{
            id: 'sm_0123456789abcdef',
            name: 'Ready walk',
            controller_version: 'legacy',
            code: sequence,
          }],
        }
        : {}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByText('Preview sequence').click();
  await expect(page.getByText(sequence)).toBeVisible();
  await page.getByRole('button', { name: 'Load sequence' }).click();
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  const ide = page.locator('textarea:visible').first();
  await expect(ide).toHaveValue(sequence);
  expect(loadRequests).toEqual([]);
});

test('student can name a project save and is told that teacher approval is required', async ({ page }) => {
  const namedSaves = [];
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'named-project-student-token',
      user: { role: 'student', username: 'student1' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/classroom/project/save-named' && request.method() === 'POST') {
      namedSaves.push(request.postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'pending',
          project: {
            id: 21,
            username: 'student1',
            name: 'Named route',
            status: 'pending',
            sceneObjects: [{ id: 'box-1' }],
            plannerWaypoints: [],
            generatedCode: 'robot.walk(1)',
            duetCode: '',
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(path === '/api/classroom/codes'
        ? { codes: [], starter_codes: [], shared_motions: [] }
        : path === '/api/classroom/projects'
          ? { projects: [] }
          : path === '/api/classroom/project'
            ? { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } }
            : {}),
    });
  });

  await page.goto('/');
  const alertMessages = [];
  page.once('dialog', async (dialog) => {
    await dialog.accept('Named route');
    page.once('dialog', async (alertDialog) => {
      alertMessages.push(alertDialog.message());
      await alertDialog.accept();
    });
  });
  await page.getByRole('button', { name: 'Open project actions' }).click();
  await page.getByRole('button', { name: 'Save as Project', exact: true }).click();
  await expect.poll(() => namedSaves.length).toBe(1);
  expect(namedSaves[0].name).toBe('Named route');
  expect(namedSaves[0].sceneObjects).toEqual([]);
  await expect.poll(() => alertMessages.length).toBe(1);
  expect(alertMessages[0]).toContain('for teacher approval');
});

test('teacher Save as Starter Motion stores only the named controller sequence', async ({ page }) => {
  const motionSaves = [];
  const sequence = 'robot.stand()\nrobot.walk(1)';
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'starter-motion-teacher-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/classroom/starter-motions' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      motionSaves.push(payload);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'saved',
          motion: {
            id: 'sm_0123456789abcdef',
            name: payload.name,
            controller_version: payload.controller_version,
            code: payload.code,
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(path === '/api/classroom/codes'
        ? { codes: [], starter_codes: [], shared_motions: [] }
        : path === '/api/classroom/projects'
          ? { projects: [] }
          : path === '/api/classroom/project'
            ? { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } }
            : {}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.locator('textarea:visible').first().fill(sequence);
  page.once('dialog', (dialog) => dialog.accept('Ready walk'));
  await page.getByRole('button', { name: 'Open project actions' }).click();
  await page.getByRole('button', { name: 'Save as Starter Motion', exact: true }).click();
  await expect.poll(() => motionSaves.length).toBe(1);
  expect(motionSaves[0]).toEqual({
    name: 'Ready walk',
    code: sequence,
    controller_version: 'legacy',
  });
});

test('teacher can create and delete student accounts from the classroom panel', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-account-test-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  let users = [
    { username: 'teacher', role: 'teacher' },
    { username: 'student1', role: 'student' },
  ];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let response = { status: 200, body: {} };

    if (url.pathname === '/api/classroom/codes') response.body = { codes: [] };
    else if (url.pathname === '/api/classroom/queue') response.body = { items: [] };
    else if (url.pathname === '/api/classroom/users' && method === 'GET') response.body = { users };
    else if (url.pathname === '/api/classroom/users' && method === 'POST') {
      const account = JSON.parse(request.postData());
      users = [...users, { username: account.username, role: account.role || 'student' }];
      response = { status: 201, body: { status: 'created', user: users.at(-1) } };
    } else if (url.pathname.startsWith('/api/classroom/users/') && method === 'DELETE') {
      const username = decodeURIComponent(url.pathname.split('/').at(-1));
      users = users.filter((user) => user.username !== username);
      response.body = { status: 'deleted', username };
    } else if (url.pathname === '/api/classroom/status') response.body = { status: 'idle' };
    else if (url.pathname === '/api/classroom/projects/all') response.body = { projects: [] };
    else if (url.pathname === '/api/classroom/project') {
      response.body = { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } };
    } else if (url.pathname === '/api/robot/status') {
      response.body = { sdkAvailable: false, running: false };
    }
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Open app settings' }).click();
  await expect(page.getByText('Manage classroom accounts')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete account teacher' })).toHaveCount(0);

  await page.getByLabel('New student username').fill('classroom_24');
  await page.getByLabel('Initial password').fill('classroom-password');
  await page.getByRole('button', { name: 'Create student account' }).click();
  await expect(page.getByText('classroom_24', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete account classroom_24' })).toBeVisible();

  await page.getByLabel('Account type').selectOption('teacher');
  await page.getByLabel('New teacher username').fill('assistant_teacher');
  await page.getByLabel('Initial password').fill('teacher-password');
  await page.getByRole('button', { name: 'Create teacher account' }).click();
  await expect(page.getByText('assistant_teacher', { exact: true })).toBeVisible();
  await expect(page.getByText('teacher', { exact: true }).last()).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete account classroom_24' }).click();
  await expect(page.getByRole('button', { name: 'Delete account classroom_24' })).toHaveCount(0);
});

test('teacher can create a class, print its cards, and clear only its data', async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-guest-account-test-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  let users = [{ username: 'teacher', role: 'teacher' }];
  let groups = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let response = { status: 200, body: {} };

    if (url.pathname === '/api/classroom/me') response.body = { data_revision: 0 };
    else if (url.pathname === '/api/classroom/codes') response.body = { codes: [] };
    else if (url.pathname === '/api/classroom/queue') response.body = { items: [] };
    else if (url.pathname === '/api/classroom/users' && method === 'GET') response.body = { users };
    else if (url.pathname === '/api/classroom/groups' && method === 'GET') response.body = { groups };
    else if (url.pathname === '/api/classroom/groups' && method === 'POST') {
      const requestBody = request.postDataJSON();
      const accounts = Array.from({ length: requestBody.size }, (_, index) => ({
        username: `1${String(index + 1).padStart(2, '0')}`,
        account_number: index + 1,
        password: String(10203040 + index),
      }));
      groups = [{ group_number: 1, name: requestBody.name || 'Class 1', accounts }];
      users = [...users, ...accounts.map(({ username }) => ({ username, role: 'student' }))];
      response.body = { status: 'created', group: groups[0] };
    } else if (url.pathname === '/api/classroom/groups/1/clear-data' && method === 'POST') {
      response.body = { status: 'cleared', group_number: 1, accounts: 25, total_deleted: 25 };
    } else if (url.pathname === '/api/classroom/status') response.body = { status: 'idle' };
    else if (url.pathname === '/api/classroom/projects/all') response.body = { projects: [] };
    else if (url.pathname === '/api/classroom/project') {
      response.body = { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } };
    } else if (url.pathname === '/api/robot/status') {
      response.body = { sdkAvailable: false, running: false };
    }
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Open app settings' }).click();
  await page.getByLabel(/Class name/).fill('Room A');
  await page.getByLabel('Number of students').fill('25');
  await page.getByRole('button', { name: 'Create class' }).click();
  await expect(page.locator('p[role="status"]').filter({ hasText: 'Room A created with 25' })).toBeVisible();
  await expect(page.getByText('Class 1 · 25 students · usernames 101–125')).toBeVisible();
  await expect(page.getByText('Password: 10203040').first()).toBeVisible();

  await page.getByRole('button', { name: 'Print login cards' }).click();
  const cardsDialog = page.getByRole('dialog', { name: 'Guest account login cards' });
  await expect(cardsDialog.locator('.guest-login-card')).toHaveCount(25);
  await expect(cardsDialog.getByText('10203040').first()).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await cardsDialog.getByRole('button', { name: 'Download PDF' }).click();
  const pdfDownload = await downloadPromise;
  expect(pdfDownload.suggestedFilename()).toBe('class-1-login-cards.pdf');
  const pdfStream = await pdfDownload.createReadStream();
  const pdfChunks = [];
  for await (const chunk of pdfStream) pdfChunks.push(chunk);
  const pdf = Buffer.concat(pdfChunks).toString('latin1');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf).toContain('/Count 3');
  expect(pdf).toContain('(101) Tj');
  expect(pdf).toContain('(10203040) Tj');

  await page.emulateMedia({ media: 'print' });
  const printLayout = await cardsDialog.evaluate((dialog) => {
    const sheet = dialog.querySelector('.guest-card-page');
    const wrapper = dialog.querySelector(':scope > div');
    const sheetBounds = sheet.getBoundingClientRect();
    const cards = [...dialog.querySelectorAll('.guest-login-card')];
    return {
      portalIsDirectBodyChild: dialog.parentElement === document.body,
      dialogPosition: getComputedStyle(dialog).position,
      dialogOverflow: getComputedStyle(dialog).overflowY,
      sheetWidth: sheetBounds.width,
      sheetHeight: sheetBounds.height,
      wrapperPadding: getComputedStyle(wrapper).padding,
      breakAfter: getComputedStyle(sheet).breakAfter,
      cardsPerSheet: [...dialog.querySelectorAll('.guest-card-page')].map(
        (pageSheet) => pageSheet.querySelectorAll('.guest-login-card').length,
      ),
      firstCardHeight: cards[0].getBoundingClientRect().height,
    };
  });
  expect(printLayout.portalIsDirectBodyChild).toBe(true);
  expect(printLayout.dialogPosition).toBe('static');
  expect(printLayout.dialogOverflow).toBe('visible');
  expect(printLayout.sheetWidth).toBeGreaterThan(730);
  expect(printLayout.sheetHeight).toBeGreaterThan(1040);
  expect(printLayout.wrapperPadding).toBe('0px');
  expect(printLayout.breakAfter).toBe('page');
  expect(printLayout.cardsPerSheet).toEqual([10, 10, 5]);
  expect(printLayout.firstCardHeight).toBeGreaterThan(200);
  const printPdf = await page.pdf({ format: 'A4', printBackground: true });
  expect(printPdf.toString('latin1')).toContain('/Count 3');
  await page.emulateMedia({ media: 'screen' });
  await cardsDialog.getByRole('button', { name: 'Close guest login cards' }).click();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Clear class data' }).click();
  await expect(page.locator('p[role="status"]').filter({ hasText: 'Cleared 25 saved records from Room A' })).toBeVisible();
  await expect(page.getByText('Class 1 · 25 students · usernames 101–125')).toBeVisible();
});

test('existing student classes persist and their cards can be reopened', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-persistent-guests-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  const accounts = Array.from({ length: 25 }, (_, index) => ({
    username: `1${String(index + 1).padStart(2, '0')}`,
    account_number: index + 1,
    password: String(10203040 + index),
  }));
  const users = [{ username: 'teacher', role: 'teacher' }, ...accounts.map(({ username }) => ({
    username,
    role: 'student',
  }))];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let body = {};
    if (url.pathname === '/api/classroom/me') body = { data_revision: 0 };
    else if (url.pathname === '/api/classroom/codes') body = { codes: [] };
    else if (url.pathname === '/api/classroom/queue') body = { items: [] };
    else if (url.pathname === '/api/classroom/users' && method === 'GET') body = { users };
    else if (url.pathname === '/api/classroom/groups' && method === 'GET') {
      body = { groups: [{ group_number: 1, name: 'Room A', accounts }] };
    } else if (url.pathname === '/api/classroom/status') body = { status: 'idle' };
    else if (url.pathname === '/api/classroom/projects/all') body = { projects: [] };
    else if (url.pathname === '/api/classroom/project') {
      body = { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } };
    } else if (url.pathname === '/api/robot/status') {
      body = { sdkAvailable: false, running: false };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Open app settings' }).click();
  await expect(page.getByText('Room A', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create class' })).toBeEnabled();
  await page.getByRole('button', { name: 'Print login cards' }).click();
  await expect(page.getByRole('dialog', { name: 'Guest account login cards' }).locator('.guest-login-card')).toHaveCount(25);
  await expect(page.getByText('101–125')).toBeVisible();
});

test('guest data revision clears a cached workspace after a teacher reset', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'guest-reset-revision-token',
      user: { role: 'student', username: '101' },
    }));
    localStorage.setItem('edu-classroom-data-revision:101', '0');
    localStorage.setItem('edu-scene-objects:101', JSON.stringify([{ id: 'old-guest-object' }]));
    localStorage.setItem('uni-edu-duet-arm-motions:101', '[]');
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname === '/api/classroom/me') body = { data_revision: 1 };
    else if (url.pathname === '/api/classroom/codes') body = { codes: [] };
    else if (url.pathname === '/api/classroom/status') body = { status: 'idle' };
    else if (url.pathname === '/api/classroom/projects') body = { projects: [] };
    else if (url.pathname === '/api/classroom/project') body = { project: null };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const saved = localStorage.getItem('edu-scene-objects:101');
    return saved ? JSON.parse(saved).length : null;
  })).toBe(0);
  await expect.poll(() => page.evaluate(
    () => localStorage.getItem('edu-classroom-data-revision:101'),
  )).toBe('1');
  await expect.poll(() => page.evaluate(
    () => localStorage.getItem('uni-edu-duet-arm-motions:101'),
  )).toBeNull();
});

test('teacher can hide Blocks and IDE tabs and restore them from settings', async ({ page }) => {
  let lockedPanels = [];
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-core-tabs-token',
      user: { role: 'teacher', username: 'teacher-core-tabs-test' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/classroom/sidebar-settings') {
      if (route.request().method() === 'PUT') {
        lockedPanels = route.request().postDataJSON().locked_panels;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ locked_panels: lockedPanels, configured: true }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Open app settings' }).click();
  const blocksToggle = page.getByRole('checkbox', { name: 'Hide Blocks tab from sidebar' });
  const ideToggle = page.getByRole('checkbox', { name: 'Hide IDE tab from sidebar' });
  await expect(blocksToggle).toBeVisible();
  await expect(ideToggle).toBeVisible();
  await blocksToggle.check();
  await expect(page.getByRole('button', { name: 'Blocks', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'IDE', exact: true })).toBeVisible();
  await ideToggle.check();
  await expect(page.getByRole('button', { name: 'Blocks', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'IDE', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Path Planner', exact: true })).toBeVisible();
  await expect.poll(() => lockedPanels).toEqual(['blocks', 'ide']);

  await ideToggle.uncheck();
  await expect(page.getByRole('button', { name: 'IDE', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Blocks', exact: true })).toHaveCount(0);
  await blocksToggle.uncheck();
  await expect(page.getByRole('button', { name: 'Blocks', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'IDE', exact: true })).toBeVisible();
  await expect.poll(() => lockedPanels).toEqual([]);
});

test('teacher can hide locked sidebar panels and restore them from settings', async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-sidebar-panels-token',
      user: { role: 'teacher', username: 'teacher-sidebar-panels-test' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/classroom/safe-mode') {
      if (route.request().method() === 'PUT') {
        safeModeEnabled = route.request().postDataJSON().enabled;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: safeModeEnabled,
          stop_margin_m: 1,
          coverage: 'front_rear_footprint',
          full_coverage_available: false,
        }),
      });
      return;
    }
    if (url.pathname === '/api/classroom/sidebar-settings') {
      if (route.request().method() === 'PUT') {
        lockedPanels = route.request().postDataJSON().locked_panels;
        sidebarSettingsConfigured = true;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ locked_panels: lockedPanels, configured: sidebarSettingsConfigured }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  let lockedPanels = [];
  let sidebarSettingsConfigured = false;
  let safeModeEnabled = false;
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Open app settings' }).click();
  const safeModeToggle = page.getByRole('checkbox', { name: 'Enable Safe Mode spatial guards' });
  await expect(safeModeToggle).not.toBeChecked();
  await expect(page.getByText(/Arm geometry is inflated by 0\.20 m/)).toBeVisible();
  await safeModeToggle.check();
  await expect.poll(() => safeModeEnabled).toBe(true);
  for (const panelName of ['Path Planner', 'Prompt to Motion', 'Vision to Motion']) {
    await page.getByRole('checkbox', { name: `Hide ${panelName} tab from sidebar` }).check();
  }
  await page.getByRole('checkbox', { name: 'Hide Prompt to Motion tab from sidebar' }).uncheck();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  for (const panelId of ['planner', 'camera']) {
    await expect(page.getByTestId(`sidebar-panel-${panelId}`)).toHaveCount(0);
  }
  await expect(page.getByTestId('sidebar-panel-prompt')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Path Planner', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prompt to Motion', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vision to Motion', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Blocks', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'IDE', exact: true })).toBeVisible();

  const [blocksTabBounds, ideTabBounds, promptTabBounds] = await Promise.all([
    page.getByRole('button', { name: 'Blocks', exact: true }).boundingBox(),
    page.getByRole('button', { name: 'IDE', exact: true }).boundingBox(),
    page.getByRole('button', { name: 'Prompt to Motion', exact: true }).boundingBox(),
  ]);
  expect(Math.abs(blocksTabBounds.width - ideTabBounds.width)).toBeLessThan(2);
  expect(Math.abs(blocksTabBounds.width - promptTabBounds.width)).toBeLessThan(2);

  expect(await page.evaluate(() => (
    localStorage.getItem('edu-locked-sidebar-panels:teacher-sidebar-panels-test')
  ))).toBe(JSON.stringify(['planner', 'camera']));

  await page.evaluate(() => localStorage.removeItem('edu-locked-sidebar-panels:teacher-sidebar-panels-test'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Path Planner', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Vision to Motion', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prompt to Motion', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Blocks', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'IDE', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open app settings' }).click();
  await expect(page.getByRole('checkbox', { name: 'Enable Safe Mode spatial guards' })).toBeChecked();
});

test('teacher queue review overlays the workspace and shows the complete submitted project', async ({ page }) => {
  const runRequests = [];
  const queuedItem = {
    id: 'queued-project-review',
    name: 'student-route',
    student: 'student1',
    status: 'queued',
    controller_version: 'legacy',
    code: 'robot.walktime(1)',
    planner_request: {
      planner_mode: 'manual',
      planner_label: 'student route',
      planner_waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      route_variants: { initial: 'robot.walktime(1)' },
      selected_variant: 'initial',
    },
    project_snapshot: {
      name: 'student-project',
      sceneObjects: [{ id: 'box-1', type: 'box', x: 1, y: 2 }],
      plannerWaypoints: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0 }],
      generatedCode: 'robot.walktime(1)',
      duetCode: 'duet.move(0.1, 0, 0, 0.5)',
      plannerMode: 'manual',
      plannerLabel: 'student route',
      plannerVariants: { initial: 'robot.walktime(1)' },
      selectedPlannerVariant: 'initial',
    },
  };
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-review-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/classroom/run-next') runRequests.push(request.postDataJSON());
    const responses = {
      '/api/classroom/codes': { codes: [] },
      '/api/classroom/queue': { items: [queuedItem] },
      '/api/classroom/users': { users: [{ username: 'teacher', role: 'teacher' }] },
      '/api/classroom/status': { status: 'idle' },
      '/api/classroom/projects/all': { projects: [] },
      '/api/classroom/project': { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } },
      '/api/planner/settings': { active_mode: 'manual' },
      '/api/robot/status': { sdkAvailable: false, running: false },
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responses[path] || {}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.getByRole('button', { name: 'Open queue' }).click();
  await page.getByRole('button', { name: 'Review request' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Exact command preview')).toBeVisible();
  await expect(dialog.getByText('robot.walktime(1)', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText('Complete submitted project state')).toBeVisible();
  await expect(page.getByRole('button', { name: 'IDE', exact: true }).first()).toHaveClass(/bg-blue-600/);
  await expect(dialog.getByRole('button', { name: 'Approve & run queued request' })).toBeEnabled();
  expect(runRequests).toEqual([]);

  await dialog.getByRole('button', { name: 'Close request review' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(runRequests).toEqual([]);
});

test('teacher can save a completed queued DUET program as a named command', async ({ page }) => {
  const savedMotions = [];
  let queuedItem = {
    id: 'queued-duet-motion',
    name: 'student-wave',
    student: 'student1',
    status: 'queued',
    controller_version: 'duet',
    code: 'duet.wave_left("mid", 1)',
    planner_request: null,
    project_snapshot: {},
  };
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-duet-save-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/classroom/run-next' && request.method() === 'POST') {
      queuedItem = { ...queuedItem, status: 'completed' };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'completed', item: queuedItem, process: { status: 'completed' } }),
      });
      return;
    }
    if (path === '/api/duet/motions' && request.method() === 'POST') {
      const requestBody = request.postDataJSON();
      savedMotions.push(requestBody);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          motion: { id: 'teacher-wave-a1b2c3d4', name: requestBody.name, code: requestBody.code },
        }),
      });
      return;
    }
    const responses = {
      '/api/classroom/codes': { codes: [] },
      '/api/classroom/queue': { items: [queuedItem] },
      '/api/classroom/users': { users: [{ username: 'teacher', role: 'teacher' }] },
      '/api/classroom/status': { status: 'idle' },
      '/api/classroom/projects/all': { projects: [] },
      '/api/classroom/project': { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } },
      '/api/planner/settings': { active_mode: 'manual' },
      '/api/robot/status': { sdkAvailable: false, running: false },
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responses[path] || {}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.getByRole('button', { name: 'Open queue' }).click();
  await page.getByRole('button', { name: 'Review request' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Approve & run queued request' }).click();
  await expect(dialog.getByText('Request completed. Physical movement is not independently verified.')).toBeVisible();
  await dialog.getByLabel('I reviewed the completed motion and it matched the intended result.').check();
  await dialog.getByLabel('Name the successful DUET motion').fill('Teacher wave');
  await page.getByRole('button', { name: 'Save command' }).click();
  await expect.poll(() => savedMotions).toEqual([{
    name: 'Teacher wave',
    code: 'duet.wave_left("mid", 1)',
  }]);
});

test('student can open a shared mode-2 project as a private copy with its original route visible', async ({ page }) => {
  const projectSaves = [];
  const sharedProject = {
    username: 'teacher',
    name: 'checkpoint-route',
    sceneObjects: [{ id: 'box-1', type: 'box', x: 1, y: 2 }],
    plannerWaypoints: [{ id: 'start', x: 0, y: 0 }, { id: 'goal', x: 1, y: 0 }],
    generatedCode: 'robot.walktime(1.2)',
    duetCode: '',
    plannerMode: 'sensor_corrected',
    plannerLabel: 'Checkpoint route',
    plannerVariants: {
      initial: 'robot.walktime(1)',
      corrected: 'robot.walktime(1.2)',
      final: 'robot.walktime(1.2)',
    },
    selectedPlannerVariant: 'corrected',
  };
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'student-shared-library-token',
      user: { role: 'student', username: 'student1' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/classroom/project/save' && request.method() === 'POST') {
      projectSaves.push(request.postDataJSON());
    }
    const responses = {
      '/api/classroom/codes': { codes: [] },
      '/api/classroom/projects': { projects: [sharedProject] },
      '/api/classroom/project': { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } },
      '/api/planner/settings': { active_mode: 'manual' },
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(path === '/api/classroom/project/save'
        ? { status: 'saved' }
        : responses[path] || {}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByText('Shared project library')).toBeVisible();
  await expect(page.getByText('teacher', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toHaveCount(0);
  await expect(page.getByText('Original route · read only').last()).toBeVisible();
  await expect(page.getByText('robot.walktime(1)', { exact: true })).toBeVisible();
  await expect(page.getByText('robot.walktime(1.2)', { exact: true })).toBeVisible();
  await expect.poll(() => projectSaves.some((project) => project.name === 'checkpoint-route (copy)')).toBe(true);

  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await expect(page.getByText('Original route · read only').last()).toBeVisible();
  await expect(page.locator('textarea').last()).toHaveValue('robot.walktime(1.2)');
});

test('teacher can rename and delete another owner project from the shared library', async ({ page }) => {
  const projectRequests = [];
  let projects = [{
    username: 'student1',
    name: 'student-route',
    generatedCode: 'robot.walktime(1)',
    plannerMode: 'sensor_corrected',
    plannerLabel: 'student-route',
    plannerVariants: { initial: 'robot.walktime(0.5)', corrected: 'robot.walktime(1)' },
  }];
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-project-library-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/classroom/project/rename' || path === '/api/classroom/project/delete') {
      const body = request.postDataJSON();
      projectRequests.push({ path, body });
      if (path.endsWith('/rename')) {
        projects = projects.map((project) => project.username === body.owner && project.name === body.name
          ? { ...project, name: body.new_name, plannerLabel: body.new_name }
          : project);
      } else {
        projects = projects.filter((project) => project.username !== body.owner || project.name !== body.name);
      }
    }
    const responses = {
      '/api/classroom/codes': { codes: [] },
      '/api/classroom/queue': { items: [] },
      '/api/classroom/users': { users: [{ username: 'teacher', role: 'teacher' }] },
      '/api/classroom/status': { status: 'idle' },
      '/api/classroom/projects': { projects },
      '/api/classroom/project': { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } },
      '/api/planner/settings': { active_mode: 'manual' },
      '/api/robot/status': { sdkAvailable: false, running: false },
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(path === '/api/classroom/project/rename'
        ? { status: 'renamed' }
        : path === '/api/classroom/project/delete'
          ? { status: 'deleted' }
          : responses[path] || {}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open queue' }).click();
  await expect(page.getByText('Shared project library')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close queue' }).click();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByText('Shared project library')).toBeVisible();
  await expect(page.getByText('student-route', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept('reviewed-route'));
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByText('reviewed-route', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No saved projects yet.')).toBeVisible();
  expect(projectRequests).toEqual([
    { path: '/api/classroom/project/rename', body: { owner: 'student1', name: 'student-route', new_name: 'reviewed-route' } },
    { path: '/api/classroom/project/delete', body: { owner: 'student1', name: 'reviewed-route' } },
  ]);
});

test('student view does not expose teacher account management', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'student-account-test-token',
      user: { role: 'student', username: 'student1' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const responses = {
      '/api/classroom/codes': { codes: [] },
      '/api/classroom/status': { status: 'idle' },
      '/api/classroom/projects': { projects: [] },
      '/api/classroom/project': {
        project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' },
      },
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responses[url.pathname] || {}),
    });
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open queue' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.getByText('Manage classroom accounts')).toHaveCount(0);
  await expect(page.getByLabel('New student username')).toHaveCount(0);
});

test('device camera preview remains local and stops when leaving Vision to Motion', async ({ page }) => {
  const apiRequests = [];
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-camera-preview-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
    let stopCount = 0;
    window.cameraPreviewTestState = {
      requestCount: 0,
      stopCount: () => stopCount,
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          window.cameraPreviewTestState.requestCount += 1;
          return {
            getTracks: () => [{ stop: () => { stopCount += 1; } }],
          };
        },
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get() { return this.testSrcObject; },
      set(value) { this.testSrcObject = value; },
    });
    HTMLMediaElement.prototype.play = () => Promise.resolve();
  });
  await page.route('**/api/**', async (route) => {
    apiRequests.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Vision to Motion' }).click();
  const legacyCameraNotice = page.getByText(/Camera-to-motion pose inference is not implemented/);
  await legacyCameraNotice.scrollIntoViewIfNeeded();
  await expect(legacyCameraNotice).toBeVisible();
  await page.getByRole('button', { name: 'Start preview' }).click();
  await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();
  expect(await page.evaluate(() => window.cameraPreviewTestState.requestCount)).toBe(1);
  expect(apiRequests.some((path) => path.includes('camera'))).toBe(false);

  await page.getByRole('button', { name: 'Blocks', exact: true }).last().click();
  await expect.poll(() => page.evaluate(() => window.cameraPreviewTestState.stopCount())).toBe(1);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => /camera|video/i.test(key)))).toEqual([]);
});

test('device camera preview stops when switching to a robot camera source', async ({ page }) => {
  const apiRequests = [];
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-camera-source-test-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
    let stopCount = 0;
    window.cameraSourceTestState = {
      stopCount: () => stopCount,
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => { stopCount += 1; } }],
        }),
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get() { return this.testSrcObject; },
      set(value) { this.testSrcObject = value; },
    });
    HTMLMediaElement.prototype.play = () => Promise.resolve();
  });
  await page.route('**/api/**', async (route) => {
    apiRequests.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Vision to Motion' }).click();
  await page.getByRole('button', { name: 'Start preview' }).click();
  await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();
  await page.getByLabel('Camera source').selectOption('robot');

  await expect.poll(() => page.evaluate(() => window.cameraSourceTestState.stopCount())).toBe(1);
  await expect(page.getByText('Run teacher sensor discovery and select one fresh image topic.')).toBeVisible();
  expect(apiRequests.some((path) => path.includes('camera'))).toBe(false);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => /camera|video/i.test(key)))).toEqual([]);
});

test('teacher can preview one explicitly selected fresh robot camera topic', async ({ page }) => {
  const topic = '/camera/color/image_raw';
  let frameRequests = 0;
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-camera-stream-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  await page.route('**/api/sensors/discover', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        lidar: { discovery: { ros: { pointclouds: [], sources: [], diagnostics: [] } }, distance: {}, calibration: {} },
        cameras: {
          sources: {
            unitree: {
              image_topics: [{
                name: topic,
                type: 'sensor_msgs/msg/Image',
                frame_id: 'camera_color_optical_frame',
                fresh: true,
                age_ms: 20,
              }],
              camera_info_topics: [],
            },
          },
        },
      }),
    });
  });
  await page.route('**/api/sensors/camera/frame**', async (route) => {
    frameRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      headers: {
        'X-Camera-Topic': topic,
        'X-Camera-Frame-Id': 'camera_color_optical_frame',
        'X-Camera-Encoding': 'rgb8',
        'X-Camera-Width': '1',
        'X-Camera-Height': '1',
        'X-Camera-Step': '3',
        'X-Camera-Timestamp': '2026-10-29T00:00:00+00:00',
        'X-Camera-Receive-Age-Ms': '4',
        'X-Camera-Stamp-Age-Ms': '20',
        'Cache-Control': 'no-store',
      },
      body: Buffer.from([255, 0, 0]),
    });
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/sensors/discover' || path === '/api/sensors/camera/frame') {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await openConnectionPanel(page);
  await page.getByRole('button', { name: 'Discover sensors' }).click();
  await page.getByRole('button', { name: 'Close connection panel' }).click();
  await page.getByRole('button', { name: 'Vision to Motion' }).click();
  await page.getByLabel('Camera source').selectOption('robot');
  await page.getByLabel('Robot camera topic').selectOption(topic);

  await expect(page.getByRole('status').filter({ hasText: topic })).toContainText('stamp 20 ms');
  await expect.poll(() => frameRequests).toBeGreaterThan(0);
  expect(await page.locator('canvas[aria-label="Transient G1 ROS camera preview"]').evaluate((canvas) => canvas.width)).toBe(1);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => /camera|video/i.test(key)))).toEqual([]);
});

test('DUET prompt and vision tabs expose both approved motion modes', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-duet-mode-test-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses = {
      '/api/classroom/codes': { codes: [] },
      '/api/classroom/queue': { items: [] },
      '/api/classroom/users': { users: [{ username: 'teacher', role: 'teacher' }] },
      '/api/classroom/status': { status: 'idle' },
      '/api/classroom/projects/all': { projects: [] },
      '/api/classroom/project': { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } },
      '/api/planner/settings': { active_mode: 'manual' },
      '/api/robot/status': { sdkAvailable: false, running: false },
      '/api/duet/motions': { motions: [] },
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responses[path] || {}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open app settings' }).click();
  await page.getByRole('checkbox', { name: 'Enable DUET version two' }).check();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('button', { name: 'Prompt to Motion' }).click();
  await expect(page.getByText('DUET motion mode')).toBeVisible();
  await page.getByRole('button', { name: 'Follow and save' }).click();
  await expect(page.getByText('Create a bounded motion series, review and run it, then save it as one named DUET command.')).toBeVisible();

  await page.getByRole('button', { name: 'Vision to Motion' }).click();
  await expect(page.getByText('DUET motion mode')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Follow and save' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Vision to DUET motion')).toBeVisible();
});

test('student view hides legacy arm holds and diagnostics without exposing sensor controls', async ({ page }) => {
  const sensorRequests = [];
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'student-sensor-visibility-test-token',
      user: { role: 'student', username: 'student1' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/sensors/')) sensorRequests.push(path);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await expect(page.getByText('robot.hold_arm("hands up", 3)', { exact: true })).toHaveCount(0);
  await expect(page.getByText('robot.getfsm()', { exact: true })).toHaveCount(0);
  await expect(page.getByText('robot.getactions()', { exact: true })).toHaveCount(0);
  await expect(page.getByText('robot.setvolume(50)', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.getByText('My Saved Code')).toBeVisible();
  await expect(page.getByText('Sensors and diagnostics')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Discover sensors' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set Origin' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Return to Origin' })).toHaveCount(0);
  expect(sensorRequests).toEqual([]);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Open robot configuration' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open app settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Open app settings' }).click();
  await expect(page.getByText('Choose the application language.')).toBeVisible();
  await expect(page.getByText('Uni++ EDU Studio')).toHaveCount(0);
  await expect(page.getByText('graphical programming environment for Unitree Robots')).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Robot speaker volume' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Enable DUET version two' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
});

test('teacher can read and set speaker volume from Settings', async ({ page }) => {
  const volumeRequests = [];
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-speaker-volume-test-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/robot/status') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sdkAvailable: true, interface: 'eth0', distanceSensor: { ready: false } }),
      });
      return;
    }
    if (url.pathname === '/api/run') {
      const { code } = route.request().postDataJSON();
      volumeRequests.push(code);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(code === 'robot.getvolume()'
          ? { status: 'completed', results: [{ command: 'getvolume', value: { volume: 35 } }] }
          : { status: 'completed', results: [] }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open robot configuration' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open app settings' })).toBeVisible();
  const actionLabels = await page.getByTestId('workspace-actions').locator('button').allTextContents();
  expect(actionLabels.map((label) => label.trim())).toEqual([
    'Run simulation',
    'Open queue',
    'Robot run',
  ]);
  await page.getByRole('button', { name: 'Open app settings' }).click();
  const volumeSlider = page.getByRole('slider', { name: 'Robot speaker volume' });
  await expect(page.getByRole('checkbox', { name: 'Show shared LiDAR map overlay in Settings' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Enable DUET version two' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Enable Safe Mode spatial guards' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Hide Path Planner tab from sidebar' })).toBeVisible();
  await expect(volumeSlider).toBeEnabled();
  await page.getByRole('button', { name: 'Read current' }).click();
  await expect(volumeSlider).toHaveValue('35');
  await expect(page.getByRole('status').filter({ hasText: 'Current speaker volume: 35/100.' })).toBeVisible();
  await volumeSlider.focus();
  await volumeSlider.press('End');
  await page.getByRole('button', { name: 'Apply volume' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Speaker volume set to 100/100.' })).toBeVisible();
  expect(volumeRequests).toEqual(['robot.getvolume()', 'robot.setvolume(100)']);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Open robot configuration' }).click();
  await expect(page.getByText('Robot speaker volume')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Enable Safe Mode spatial guards' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
});

test('teacher sensor diagnostics label model-derived distance readings as provisional', async ({ page }) => {
  let sensorDiscoveryRequests = 0;
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-sensor-diagnostics-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  const diagnostics = {
    lidar: {
      discovery: {
        connection: {
          method: 'direct_livox',
          reason: 'Validated direct Livox network path; sensor stream not yet verified.',
        },
        ros: {
          pointclouds: [
            { name: '/lidar/front', fresh: true, frame_id: 'front_lidar', age_ms: 42 },
            { name: '/lidar/rear', fresh: false, frame_id: 'rear_lidar', age_ms: 1800, error: 'PointCloud2 sample is stale.' },
          ],
          sources: [
            { role: 'imu', name: '/imu/data', fresh: true, frame_id: 'base_link', age_ms: 35 },
            { role: 'joint_state', name: '/joint_states', fresh: true, frame_id: 'pelvis', age_ms: 40 },
            { role: 'local_costmap', name: '/local_costmap/costmap', fresh: false, frame_id: 'map', age_ms: 1800, error: 'OccupancyGrid sample is stale.' },
          ],
        },
        diagnostics: [],
      },
      calibration: {
        status: 'model_derived',
        calibration_source: 'model_derived',
        physical_mount_confirmed: false,
        reason: 'Using the nominal URDF mount and model-derived footprint; physical sensor mounting has not been independently verified.',
        candidate_mounts: {
          mid360: {
            available: true,
            parent_frame: 'torso_link',
            sensor_frame: 'mid360_link',
            translation_m: [0.01, 0.02, 0.4],
          },
        },
      },
      distance: {
        ready: true,
        front: { ready: true, distance_m: 0.84 },
        sources: [
          {
            id: 'mid360-front',
            topic: '/mid360/livox/lidar',
            status: 'ready',
            contributing: true,
            sensor_frame_id: 'mid360_link',
            age_ms: 42,
            receive_age_ms: 4,
            stamp_age_ms: 42,
            coverage: ['forward', 'rear'],
          },
          {
            id: 'front-depth',
            topic: '/camera/depth/points',
            status: 'timestamp_skew',
            contributing: false,
            sensor_frame_id: 'camera_depth_frame',
            age_ms: 155,
            receive_age_ms: 3,
            stamp_age_ms: 155,
            coverage: ['forward'],
            error: 'Cloud capture time differs from the newest usable source by more than 100 ms.',
          },
        ],
        rear: {
          ready: true,
          distance_m: 1.14,
          sources: [],
        },
      },
    },
    cameras: { sources: {} },
  };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/sensors/discover') sensorDiscoveryRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        url.pathname === '/api/sensors/discover' ? diagnostics : {},
      ),
    });
  });

  await page.goto('/');
  await expect(page.getByTestId('teacher-robot-settings')).toHaveCount(0);
  await openConnectionPanel(page);
  const robotSettings = page.getByTestId('teacher-robot-settings');
  await expect(robotSettings.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await expect(robotSettings.getByRole('button', { name: 'Set Origin' })).toBeVisible();
  await expect(robotSettings.getByRole('button', { name: 'Return to Origin' })).toBeVisible();
  await page.getByRole('button', { name: 'Discover sensors' }).click();
  await expect(page.getByText(/direct_livox.*model-derived \(provisional\)/)).toBeVisible();
  await expect(page.getByText('/lidar/front · fresh · frame front_lidar · 42 ms old')).toBeVisible();
  await expect(page.getByText('/lidar/rear · unavailable · frame rear_lidar · 1800 ms old · PointCloud2 sample is stale.')).toBeVisible();
  await expect(page.getByText('imu: /imu/data · fresh · frame base_link · 35 ms old')).toBeVisible();
  await expect(page.getByText('joint state: /joint_states · fresh · frame pelvis · 40 ms old')).toBeVisible();
  await expect(page.getByText('local costmap: /local_costmap/costmap · unavailable · frame map · 1800 ms old · OccupancyGrid sample is stale.')).toBeVisible();
  await expect(page.getByText(/Forward distance: ready.*Rear distance: ready/)).toBeVisible();
  await expect(page.getByText(/forward · \/mid360\/livox\/lidar · contributing · frame mid360_link · 42 ms old/)).toBeVisible();
  await expect(page.getByText(/forward · \/mid360\/livox\/lidar .*receive 4 ms · stamp 42 ms/)).toBeVisible();
  await expect(page.getByText(/forward · \/camera\/depth\/points · timestamp_skew/)).toBeVisible();
  await expect(page.getByText(/Nominal model mount \(torso_link → mid360_link; physical fit not independently checked\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart managed LiDAR driver' })).toBeVisible();
  expect(sensorDiscoveryRequests).toBe(1);
});

test('3D camera keypad is draggable and has no shrink control', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-camera-controls-test' },
    }));
  });
  await page.goto('/');
  const canvas = page.locator('canvas[aria-label^="3D simulation."]');
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pan view up' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pan view left' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pan view down' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pan view right' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Shrink camera controls' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enlarge camera controls' })).toHaveCount(0);

  const moveHandle = page.getByRole('button', { name: 'Move camera controls' });
  const beforeMove = await page.getByRole('group', { name: '3D camera navigation' }).boundingBox();
  const handleBounds = await moveHandle.boundingBox();
  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBounds.x + handleBounds.width / 2 + 60, handleBounds.y + handleBounds.height / 2 + 30);
  await page.mouse.up();
  const afterMove = await page.getByRole('group', { name: '3D camera navigation' }).boundingBox();
  expect(afterMove.x).toBeGreaterThan(beforeMove.x + 30);
  expect(afterMove.y).toBeGreaterThan(beforeMove.y + 10);
  const movedHandle = await moveHandle.boundingBox();
  await page.mouse.move(movedHandle.x + movedHandle.width / 2, movedHandle.y + movedHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(movedHandle.x + movedHandle.width / 2 - 60, movedHandle.y + movedHandle.height / 2 - 30);
  await page.mouse.up();

  await page.evaluate(() => {
    document.addEventListener('keydown', (event) => {
      window.cameraKeyWasHandled = event.defaultPrevented;
    });
  });
  await page.getByRole('button', { name: 'Pan view right' }).click();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => page.evaluate(() => window.cameraKeyWasHandled)).toBe(true);

  await canvas.click({ position: { x: 150, y: 120 } });
  await page.evaluate(() => { window.cameraKeyWasHandled = false; });
  await page.keyboard.press('q');
  await expect.poll(() => page.evaluate(() => window.cameraKeyWasHandled)).toBe(true);
});

test('3D camera navigation controls remain reachable on a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-mobile-camera-test' },
    }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Collapse workspace panel' }).click();
  await expect(page.getByRole('group', { name: '3D camera navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide camera controls' }).click();
  await expect(page.getByRole('button', { name: 'Pan view right' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show camera controls' })).toBeVisible();
  await page.getByRole('button', { name: 'Show camera controls' }).click();
  await expect(page.getByRole('button', { name: 'Pan view right' })).toBeVisible();
  await page.getByRole('button', { name: 'Pan view right' }).click();

  await page.setViewportSize({ width: 320, height: 360 });
  const sceneBounds = await page.locator('.scene-shell').boundingBox();
  for (const locator of [
    page.getByRole('group', { name: '3D camera navigation' }),
    page.getByRole('group', { name: 'Motion playback controls' }),
  ]) {
    const bounds = await locator.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(sceneBounds.x);
    expect(bounds.y).toBeGreaterThanOrEqual(sceneBounds.y);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(sceneBounds.x + sceneBounds.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(sceneBounds.y + sceneBounds.height);
  }
  await page.getByRole('button', { name: 'Expand workspace panel' }).click();
  const workspacePanel = page.getByRole('button', { name: 'Collapse workspace panel' }).locator('xpath=../..');
  await expect.poll(async () => {
    const bounds = await workspacePanel.boundingBox();
    return {
      insideScene: bounds.x >= sceneBounds.x
        && bounds.y >= sceneBounds.y
        && bounds.x + bounds.width <= sceneBounds.x + sceneBounds.width
        && bounds.y + bounds.height <= sceneBounds.y + sceneBounds.height,
      insideViewport: bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 360,
    };
  }).toEqual({ insideScene: true, insideViewport: true });
});

test('Blockly supports Project menu JSON export, history, clear, and keyboard shortcuts', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-blockly-history-test' },
    }));
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run simulation', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Send to robot', exact: true })).toHaveCount(0);
  await expect(page.getByText('Workspace', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'File', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  const actionLabels = await page.getByTestId('workspace-actions').locator('button').allTextContents();
  expect(actionLabels.map((label) => label.trim())).toEqual([
    'Run simulation',
    'Submit to teacher',
    'Library',
  ]);
  await page.getByRole('button', { name: 'Open project actions' }).click();
  const projectMenu = page.getByRole('menu', { name: 'Project actions' });
  await expect(projectMenu).toBeVisible();
  const projectMenuBounds = await projectMenu.boundingBox();
  const viewport = page.viewportSize();
  expect(projectMenuBounds.x).toBeGreaterThanOrEqual(0);
  expect(projectMenuBounds.y).toBeGreaterThanOrEqual(0);
  expect(projectMenuBounds.x + projectMenuBounds.width).toBeLessThanOrEqual(viewport.width);
  expect(projectMenuBounds.y + projectMenuBounds.height).toBeLessThanOrEqual(viewport.height);
  await expect(projectMenu).toHaveClass(/bg-slate-900/);
  await expect(page.getByRole('button', { name: 'Save to account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import JSON' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export JSON' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import Python' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export Python (.py)' })).toBeVisible();
  await expect(page.getByLabel('Import JSON file')).toHaveAttribute('accept', '.json');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Redo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Open project actions' }).click();
  await page.evaluate(() => {
    const workspace = window.Blockly.getMainWorkspace();
    const block = workspace.newBlock('g1_command_walk');
    block.initSvg();
    block.render();
  });
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks().length
  ))).toBe(1);

  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks().length
  ))).toBe(0);
  await page.keyboard.press('Control+y');
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks().length
  ))).toBe(1);

  await page.getByRole('button', { name: 'Open project actions' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks().length
  ))).toBe(0);
  await page.getByRole('button', { name: 'Open project actions' }).click();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks().length
  ))).toBe(1);

  await page.getByRole('button', { name: 'Open project actions' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const jsonDownload = await downloadPromise;
  expect(jsonDownload.suggestedFilename()).toBe('project.json');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Open project actions' }).click();
  await page.getByRole('button', { name: 'Clear workspace' }).click();
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks().length
  ))).toBe(0);
});

test('Project menu imports Python into IDE', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-python-import-test' },
    }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open project actions' }).click();
  await page.getByRole('button', { name: 'Import Python' }).click();
  await page.getByLabel('Import Python file').setInputFiles({
    name: 'example.py',
    mimeType: 'text/x-python',
    buffer: Buffer.from('robot.walk(2)\n'),
  });
  await expect(page.locator('textarea').first()).toHaveValue('robot.walk(2)');
});

test('Blockly workspace survives collapsing and reopening its side panel', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-blockly-panel-test' },
    }));
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.locator('textarea').first().fill(
    'robot.walk(2)\nrobot.stand()\nrobot.arm_action("hands up")\nrobot.hold_arm("hands up", 3)',
  );
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect(page.locator('.blocklyText').filter({ hasText: 'Walk forward' }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks().length
  ))).toBe(4);
  await page.evaluate(() => {
    window.originalBlocklySvg = document.querySelector('.blocklySvg');
  });
  const workspacePanel = page.getByRole('button', { name: 'Collapse workspace panel' })
    .locator('xpath=../..');
  const expandedPanelBounds = await workspacePanel.boundingBox();

  await page.getByRole('button', { name: 'Collapse workspace panel' }).click();
  await expect(page.locator('.blocklySvg')).toBeHidden();
  await page.getByRole('button', { name: 'Expand workspace panel' }).click();
  await expect(page.locator('.blocklySvg')).toBeVisible();
  await expect.poll(async () => {
    const bounds = await workspacePanel.boundingBox();
    return { width: bounds.width, height: bounds.height };
  }).toEqual({ width: expandedPanelBounds.width, height: expandedPanelBounds.height });
  await expect.poll(() => page.evaluate(() => (
    window.originalBlocklySvg === document.querySelector('.blocklySvg')
      && window.Blockly.getMainWorkspace().getAllBlocks().length === 4
  ))).toBe(true);
});

test('Blockly loop counts are restricted to 1 through 20', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-loop-count-test' },
    }));
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.locator('textarea').first().fill('for count in range(20):\n    robot.stand()');
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const workspace = window.Blockly.getMainWorkspace();
    const repeatBlock = workspace.getAllBlocks(false).find((block) => block.type === 'controls_repeat_ext');
    return Number(repeatBlock?.getInputTargetBlock('TIMES')?.getFieldValue('NUM'));
  })).toBe(20);

  await page.evaluate(() => {
    const workspace = window.Blockly.getMainWorkspace();
    const repeatBlock = workspace.getAllBlocks(false).find((block) => block.type === 'controls_repeat_ext');
    const countField = repeatBlock.getInputTargetBlock('TIMES').getField('NUM');
    countField.setValue('21');
  });
  await expect.poll(() => page.evaluate(() => {
    const workspace = window.Blockly.getMainWorkspace();
    const repeatBlock = workspace.getAllBlocks(false).find((block) => block.type === 'controls_repeat_ext');
    return Number(repeatBlock?.getInputTargetBlock('TIMES')?.getFieldValue('NUM'));
  })).toBe(20);
});

test('student IDE multiline commands render as Blocks and generate code', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-blocks-test' },
    }));
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.locator('textarea').first().fill(
    'robot.walk(2)\nrobot.stand()\nrobot.arm_action("hands up")\nrobot.hold_arm("hands up", 3)',
  );
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();

  await expect(page.locator('.blocklySvg')).toBeVisible();
  await expect(page.locator('.blocklyText').filter({ hasText: 'Walk forward' }).first()).toBeVisible();
  await expect(page.locator('.blocklyText').filter({ hasText: 'Stand / ready' }).first()).toBeVisible();
  await expect(page.locator('.blocklyText').filter({ hasText: 'Arm preset: Hands Up' }).first()).toBeVisible();
  const blocklyLayout = await page.evaluate(() => {
    const workspace = window.Blockly.getMainWorkspace();
    const rect = document.querySelector('.blocklySvg').getBoundingClientRect();
    return { scale: workspace.getScale(), width: rect.width, height: rect.height };
  });
  expect(blocklyLayout.scale).toBeLessThanOrEqual(0.8);
  expect(blocklyLayout.width).toBeGreaterThan(0);
  expect(blocklyLayout.height).toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'Gestures' }).click();
  await expect(page.locator('.blocklyFlyout .blocklyText').filter({ hasText: 'Arm preset: Hands Up' })).toBeVisible();
  await expect(page.locator('.blocklyFlyout .blocklyText').filter({ hasText: 'Arm preset: Shake Hand' })).toBeVisible();
  await page.evaluate(() => {
    const blocks = window.Blockly.getMainWorkspace().getAllBlocks();
    blocks.find((block) => block.type === 'g1_command_walk')
      .setFieldValue('3', 'STEPS');
    if (!blocks.find((block) => block.type === 'g1_command_arm_action_hands_up')) {
      throw new Error('Arm preset did not map to its dedicated Blocks command.');
    }
    if (!blocks.find((block) => block.type === 'g1_command_hold_arm')) {
      throw new Error('Timed arm pose did not map to its Blockly command.');
    }
  });
  await expect(page.locator('pre').filter({ hasText: 'robot.walk(3)' })).toContainText('robot.arm_action("hands up")');
  await expect(page.locator('pre').filter({ hasText: 'robot.walk(3)' })).toContainText('robot.hold_arm("hands up", 3)');
  await expect(page.locator('pre').filter({ hasText: 'robot.walk(3)' })).not.toContainText('robot.arm_action("release arm")');
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await expect(page.locator('code').filter({ hasText: 'robot.arm_action("hands up")' })).toBeVisible();
  await expect(page.locator('code').filter({ hasText: 'robot.arm_action("shake hand")' })).toBeVisible();
  await expect(page.locator('code').filter({ hasText: 'robot.wait(1)' })).toBeVisible();
  await expect(page.getByText('Unitree SDK: LocoClient.Start() / SetFsmId(500)')).toBeVisible();
  await expect(page.getByText('Stand ready to move.')).toBeVisible();
  await expect(page.getByText('Pause for the selected number of seconds.')).toBeVisible();
  await expect(page.getByText('Raise both hands.')).toBeVisible();
  await expect(page.getByText(/“example” is a placeholder app name, not a sound/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('distance if/then/else programs round-trip between IDE text and Blockly', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-distance-conditions-test' },
    }));
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.locator('textarea').first().fill(
    'if robot.front_distance_m() < 1:\n'
    + '    robot.walk(2)\n'
    + 'else:\n'
    + '    robot.turn("left", 90)',
  );
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect(page.locator('.blocklySvg')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks().map((block) => block.type).sort()
  ))).toEqual(['controls_if', 'g1_command_turn', 'g1_command_walk', 'g1_front_distance_m', 'logic_compare', 'math_number'].sort());
  await page.evaluate(() => {
    const conditional = window.Blockly.getMainWorkspace().getAllBlocks().find((block) => block.type === 'controls_if');
    if (!conditional.getInput('ELSE')) throw new Error('Else branch was not restored from IDE code.');
    if (conditional.getInputTargetBlock('ELSE')?.type !== 'g1_command_turn') {
      throw new Error('Else branch command was not connected to the conditional.');
    }
  });
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await expect(page.locator('textarea').first()).toHaveValue(
    'if robot.front_distance_m() < 1:\n    robot.walk(2)\nelse:\n    robot.turn("left", 90)',
  );
});

test('left and right sidestep counts round-trip between IDE and Blockly', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-sidestep-count-test' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
  const code = 'robot.sidestep("left", 3)\nrobot.sidestep("right", 2)';

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.locator('textarea').first().fill(code);
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks()
      .filter((block) => block.type === 'g1_command_sidestep')
      .map((block) => [block.getFieldValue('DIRECTION'), block.getFieldValue('STEPS')])
  ))).toEqual([['left', 3], ['right', 2]]);
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await expect(page.locator('textarea').first()).toHaveValue(code);
});

test('editing a wait in the IDE preserves the commands below it', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-ide-edit-preserve-test' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
  const initialCode = 'robot.wait(2)\nrobot.walk(3)\nrobot.turn("left", 90)';
  const expectedCode = 'robot.wait(5)\nrobot.walk(3)\nrobot.turn("left", 90)';

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  const editor = page.locator('textarea').first();
  await editor.fill(initialCode);
  await editor.evaluate((element) => {
    const position = element.value.indexOf('2');
    element.focus();
    element.setSelectionRange(position, position + 1);
  });
  await editor.pressSequentially('5');
  await expect(editor).toHaveValue(expectedCode);
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => {
    const waitBlock = window.Blockly.getMainWorkspace().getAllBlocks()
      .find((block) => block.type === 'g1_command_wait');
    waitBlock.setFieldValue('6', 'SECONDS');
  });
  const updatedCode = 'robot.wait(6)\nrobot.walk(3)\nrobot.turn("left", 90)';
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await expect(editor).toHaveValue(updatedCode);
});

test('condition toolbox provides True and False blocks without a Variables category', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-boolean-toolbox-test' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  const toolboxCategories = await page.getByRole('treeitem').allTextContents();
  expect(toolboxCategories).toContain('Conditions');
  expect(toolboxCategories).not.toContain('Variables');

  await page.getByRole('treeitem', { name: 'Conditions' }).click();
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getFlyout().getWorkspace().getAllBlocks()
      .filter((block) => block.type === 'logic_boolean')
      .map((block) => block.getFieldValue('BOOL'))
      .sort()
  ))).toEqual(['FALSE', 'TRUE']);
});

test('Boolean variable if/then/else programs round-trip between IDE text and Blockly', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-boolean-conditions-test' },
    }));
  });
  const code = 'obstacle_detected = True\n'
    + 'if obstacle_detected:\n'
    + '    robot.walk(1)\n'
    + 'else:\n'
    + '    robot.turn("left", 90)';

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.locator('textarea').first().fill(code);
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect(page.locator('.blocklySvg')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks().map((block) => block.type).sort()
  ))).toEqual(['controls_if', 'g1_command_turn', 'g1_command_walk', 'logic_boolean', 'variables_get', 'variables_set'].sort());
  await page.evaluate(() => {
    const blocks = window.Blockly.getMainWorkspace().getAllBlocks();
    const conditional = blocks.find((block) => block.type === 'controls_if');
    if (conditional.getInputTargetBlock('IF0')?.type !== 'variables_get') {
      throw new Error('Boolean variable was not connected to the condition.');
    }
    if (conditional.getInputTargetBlock('ELSE')?.type !== 'g1_command_turn') {
      throw new Error('Else branch was not restored from IDE code.');
    }
    blocks.find((block) => block.type === 'logic_boolean').setFieldValue('FALSE', 'BOOL');
  });
  await expect(page.locator('pre')).toContainText('obstacle_detected = False');
  await expect(page.locator('pre')).toContainText('if obstacle_detected:');
  await expect(page.locator('pre')).toContainText('robot.turn("left", 90)');
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await expect(page.locator('textarea').first()).toHaveValue(
    'obstacle_detected = False\nif obstacle_detected:\n    robot.walk(1)\nelse:\n    robot.turn("left", 90)',
  );
});

test('rear distance conditions appear in Blockly and round-trip to IDE text', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-rear-distance-test' },
    }));
  });
  const code = 'if robot.rear_distance_m() < 0.8:\n'
    + '    robot.backward(1)\n'
    + 'else:\n'
    + '    robot.turn("left", 90)';
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.locator('textarea').first().fill(code);
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks().map((block) => block.type).sort()
  ))).toEqual(['controls_if', 'g1_command_turn', 'g1_command_backward', 'g1_rear_distance_m', 'logic_compare', 'math_number'].sort());
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await expect(page.locator('textarea').first()).toHaveValue(code);
});

test('teacher can check ROS navigation readiness without starting motion', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'teacher', username: 'teacher-navigation-bridge-test' },
    }));
  });
  await page.route('**/api/navigation/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ready',
        ready: true,
        motionReady: true,
        estop: { ready: true, age_ms: 40, error: null },
        robotHealth: { ready: true, age_ms: 30, error: null },
        localization: {
          pose: { x: 1.2, y: -0.4, yaw_rad: 0.3 },
          age_ms: 80,
        },
        pointcloudAgeMs: 50,
        map: { map_id: 'classroom', version: 'v4', frame_id: 'map' },
        diagnostics: {
          topics: { pointcloud: '/mid360/livox/lidar', map: '/map' },
          frames: { pointcloud: 'livox_frame', map: 'map', base: 'base_link' },
          pointcloud: {
            rate_hz: 20,
            age_ms: 50,
            stamp_age_ms: 30,
            callback_duration_ms: 2,
            count: 100,
          },
          map: {
            occupied_threshold: 65,
            age_ms: 40,
            metadata: {
              resolution_m: 0.05,
              origin: { x: -5, y: -3.75, yaw_rad: 0 },
            },
          },
          localization: { quality: 'fresh_transform' },
          actions: { navigation: true, route_preview: true, spin: true },
          controller: {
            owner: 'nav2_via_single_unitree_bridge',
            ready: true,
          },
          execution_enabled: true,
        },
      }),
    });
  });
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Path Planner' }).click();
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByRole('status').filter({
    hasText: 'Ready • map classroom • version v4 • map • pose 1.20, -0.40 m (80 ms old) • MID-360 50 ms old',
  })).toBeVisible();
  await expect(page.getByTestId('navigation-diagnostics')).toContainText('/mid360/livox/lidar');
  await expect(page.getByTestId('navigation-diagnostics')).toContainText('20.0 Hz measured');
  await expect(page.getByTestId('navigation-diagnostics')).toContainText('nav2_via_single_unitree_bridge');
});

test('teacher can load and hide the ROS occupancy map', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'teacher', username: 'teacher-map-preview-test' },
    }));
  });
  let mapVersion = 'v2';
  let occupancy = [0, 100, -1, 75];
  let liveSocket;
  await page.route('**/api/navigation/map', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: true,
        map: {
          map_id: 'classroom',
          version: mapVersion,
          frame_id: 'map',
          resolution_m: 1,
          width: 2,
          height: 2,
          origin: { x: -1, y: -1, yaw_rad: 0 },
        },
        data: occupancy,
      }),
    });
  });
  await page.routeWebSocket('**/api/lidar/live', (socket) => {
    liveSocket = socket;
  });
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Path Planner' }).click();
  await page.getByRole('button', { name: 'Live adaptive' }).click();
  await page.getByRole('button', { name: 'Load live occupancy map' }).click();
  await expect(page.getByText(/Live SLAM map loaded • 2 × 2 cells • map classroom • version v2/)).toBeVisible();
  const overlay = page.getByTestId('ros-occupancy-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('path')).toHaveAttribute('d', /M1 0h1v1h-1zM1 1h1v1h-1z/);
  await page.getByRole('button', { name: 'Add map goals' }).click();
  const mapClick = await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="navigation-map-coordinate-layer"]');
    const svg = layer.ownerSVGElement;
    const target = svg.createSVGPoint();
    target.x = 0.5;
    target.y = 0.5;
    const screenPoint = target.matrixTransform(layer.getScreenCTM());
    const bounds = svg.getBoundingClientRect();
    return { x: screenPoint.x - bounds.left, y: screenPoint.y - bounds.top };
  });
  await page.getByRole('img', { name: 'ROS occupancy map and navigation destinations' }).click({
    position: mapClick,
  });
  await expect(page.getByText('Goal 1: -0.50, -0.50 m (map)')).toBeVisible();
  await expect.poll(() => Boolean(liveSocket)).toBeTruthy();
  mapVersion = 'v3';
  occupancy = [0, 0, -1, 75];
  liveSocket.send(JSON.stringify({
    type: 'live_update',
    navigation: { ready: true, map: { map_id: 'classroom', version: mapVersion } },
    scan: null,
    shared_overlay_enabled: false,
    shared_map_version: null,
  }));
  await expect(overlay.locator('path')).toHaveAttribute('d', 'M1 1h1v1h-1z');
  await expect(page.getByText(/Live map updated .*2 × 2 cells .*version v3/)).toBeVisible();
  await expect(page.getByText('Goal 1: -0.50, -0.50 m (map)')).toBeVisible();
  mapVersion = 'v4';
  occupancy = [100, 0, -1, 75];
  liveSocket.send(JSON.stringify({
    type: 'live_update',
    navigation: { ready: true, map: { map_id: 'classroom', version: mapVersion } },
    scan: null,
    shared_overlay_enabled: false,
    shared_map_version: null,
  }));
  await expect(page.getByText('Goal 1: -0.50, -0.50 m (map)')).toBeVisible();
  await expect(page.getByText(/Live map updated .* destinations stay fixed in map coordinates/)).toBeVisible();
  await expect(page.getByTestId('navigation-waypoint-1')).toHaveAttribute('fill', '#dc2626');
  await page.getByRole('button', { name: 'Hide overlay' }).click();
  await expect(overlay).toHaveCount(0);
});

test('students receive the centrally published metric map and 3D cloud overlay', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-shared-map-test' },
    }));
  });
  await page.route('**/api/lidar/settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ show_shared_overlay: true }),
    });
  });
  await page.route('**/api/lidar/map', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        map: {
          ready: true,
          map: {
            map_id: 'classroom',
            version: 'shared-v1',
            frame_id: 'map',
            resolution_m: 0.5,
            width: 2,
            height: 2,
            origin: { x: -0.5, y: -0.5, yaw_rad: 0 },
          },
          data: [100, 0, -1, 0],
        },
        pointcloud: {
          frame_id: 'map',
          point_count: 1,
          points: [{ x: -0.25, y: -0.25, z: 1.4 }],
        },
      }),
    });
  });
  let liveSocket;
  await page.routeWebSocket('**/api/lidar/live', (socket) => {
    liveSocket = socket;
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Path Planner' }).click();
  await expect(page.getByText('Published room map • 3D points projected to grid')).toHaveCount(0);
  await expect(page.getByRole('img', {
    name: 'Published shared occupancy map with 3D LiDAR points colored by height',
  })).toHaveCount(0);
  await expect(page.getByText('Teacher-managed student grid overlay: enabled.')).toHaveCount(0);
  await expect(page.getByText('Compile remains the open-loop SDK path.')).toHaveCount(0);
  await expect(page.getByText('ROS navigation bridge', { exact: true })).toHaveCount(0);
  await expect(page.getByText('3D room scan', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Not checked', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No room scan', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Live updates disconnected/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Place waypoint' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compile' })).toBeVisible();
  await page.getByRole('button', { name: 'Library' }).click();
  const gridOverlay = page.getByTestId('shared-lidar-grid-overlay');
  await expect(gridOverlay).toBeVisible();
  await expect(gridOverlay).toHaveAttribute('d', 'M104.5 115.5L110 115.5L110 110L104.5 110z');
  const pointOverlay = page.getByTestId('shared-lidar-pointcloud-overlay').locator('circle');
  await expect(pointOverlay).toHaveCount(1);
  await expect(pointOverlay).toHaveAttribute('cx', '107.25');
  await expect(pointOverlay).toHaveAttribute('cy', '112.75');
  await expect(page.getByRole('checkbox', { name: 'Show shared LiDAR map overlay' })).toHaveCount(0);
  await expect.poll(() => Boolean(liveSocket)).toBeTruthy();
  liveSocket.send(JSON.stringify({
    type: 'live_update',
    navigation: { ready: false, error: 'navigation unavailable' },
    scan: null,
    shared_overlay_enabled: false,
    shared_map_version: 'shared-v1',
  }));
  await expect(page.getByTestId('shared-lidar-grid-overlay')).toHaveCount(0);
  liveSocket.send(JSON.stringify({
    type: 'live_update',
    navigation: { ready: false, error: 'navigation unavailable' },
    scan: null,
    shared_overlay_enabled: true,
    shared_map_version: 'shared-v1',
  }));
  await expect(page.getByTestId('shared-lidar-grid-overlay')).toBeVisible();
});

test('teacher can manage the shared LiDAR overlay from Settings and Path Planner', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'teacher', username: 'teacher-shared-map-settings-test' },
    }));
  });
  let settingEnabled = false;
  await page.route('**/api/lidar/settings', async (route) => {
    if (route.request().method() === 'PUT') {
      expect(route.request().postDataJSON()).toEqual({ show_shared_overlay: true });
      settingEnabled = true;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ show_shared_overlay: settingEnabled }),
    });
  });
  await page.route('**/api/lidar/map', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: settingEnabled, map: null, pointcloud: null }),
    });
  });
  await page.routeWebSocket('**/api/lidar/live', () => {});

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  const settingsToggle = page.getByRole('checkbox', { name: 'Show shared LiDAR map overlay in Settings' });
  await expect(settingsToggle).toBeVisible();
  await settingsToggle.check();
  await expect(settingsToggle).toBeChecked();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Path Planner' }).click();
  const setting = page.getByRole('checkbox', { name: 'Show shared LiDAR map overlay' });
  await expect(setting).toBeVisible();
  await expect(setting).toBeChecked();

  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Show shared LiDAR map overlay' })).toHaveCount(0);
});

test('teacher scan workflow requires explicit capture completion and map publication', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'teacher', username: 'teacher-room-scan-test' },
    }));
  });
  const jobId = '12345678-1234-1234-1234-123456789abc';
  await page.route('**/api/lidar/scan', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirm_rotation: true });
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: jobId,
        status: 'scanning',
        rotation_status: 'submitted',
        rotation_radians: 0,
        point_count: 0,
        preview_points: [],
      }),
    });
  });
  await page.route(`**/api/lidar/scan/${jobId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: jobId,
        status: 'scanning',
        rotation_status: 'completed',
        rotation_radians: 6.283185307179586,
        point_count: 1200,
        preview_points: [{ x: 0.2, y: 0.3, z: 1.1 }],
      }),
    });
  });
  await page.route(`**/api/lidar/scan/${jobId}/complete`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: jobId,
        status: 'completed',
        point_count: 1200,
        rotation_status: 'completed',
        rotation_radians: 6.283185307179586,
        map: {
          map_id: 'classroom',
          version: 'scan-v1',
          frame_id: 'map',
          resolution_m: 0.05,
          width: 40,
          height: 30,
          origin: { x: -1, y: -0.75, yaw_rad: 0 },
        },
      }),
    });
  });
  await page.route('**/api/lidar/map/publish', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'published',
        map: { map_id: 'classroom', version: 'scan-v1', width: 40, height: 30, resolution_m: 0.05 },
      }),
    });
  });
  await page.route('**/api/lidar/map', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: false, map: null, pointcloud: null }),
    });
  });
  let liveSocket;
  await page.routeWebSocket('**/api/lidar/live', (socket) => {
    liveSocket = socket;
  });

  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Path Planner' }).click();
  await expect.poll(() => Boolean(liveSocket)).toBeTruthy();
  liveSocket.send(JSON.stringify({
    type: 'live_update',
    navigation: {
      ready: true,
      motion_ready: true,
      estop: { ready: true, age_ms: 40, error: null },
      robot_health: { ready: true, age_ms: 30, error: null },
    },
    scan: null,
    shared_overlay_enabled: false,
  }));
  await page.getByRole('button', { name: 'Start supervised 360° scan' }).click();
  await expect(page.getByRole('button', { name: 'Validate 360° scan' })).toBeEnabled();
  await expect(page.getByText(/360° rotation confirmed \(6\.28 rad\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Validate 360° scan' }).click();
  await expect(page.getByRole('button', { name: 'Publish shared map' })).toBeVisible();
  await page.getByRole('button', { name: 'Publish shared map' }).click();
  await expect(page.getByText('Published shared room map • 2 m × 1.5 m')).toBeVisible();
});

test('teacher live scan points overlay the planner map only in a matching frame', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'teacher', username: 'teacher-live-scan-overlay-test' },
    }));
  });
  await page.route('**/api/lidar/settings', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ show_shared_overlay: false }) });
  });
  await page.route('**/api/lidar/map', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ map: null, pointcloud: null }) });
  });
  await page.route('**/api/navigation/map', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: true,
        map: {
          map_id: 'classroom',
          version: 'v1',
          frame_id: 'map',
          resolution_m: 1,
          width: 2,
          height: 2,
          origin: { x: 0, y: 0, yaw_rad: 0 },
        },
        data: [0, 0, 0, 0],
      }),
    });
  });
  let liveSocket;
  await page.routeWebSocket('**/api/lidar/live', (socket) => {
    liveSocket = socket;
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Path Planner' }).click();
  await page.getByRole('button', { name: 'Live adaptive' }).click();
  await page.getByRole('button', { name: 'Load live occupancy map' }).click();
  await expect(page.getByTestId('navigation-map-coordinate-layer')).toBeVisible();
  await expect.poll(() => Boolean(liveSocket)).toBeTruthy();
  const scan = {
    job_id: '12345678-1234-1234-1234-123456789abc',
    status: 'scanning',
    frame_id: 'map',
    rotation_status: 'rotating',
    rotation_radians: 1,
    point_count: 1,
    preview_points: [{ x: 0.5, y: 0.5, z: 0.6 }],
  };
  liveSocket.send(JSON.stringify({ type: 'live_update', navigation: { ready: false }, scan, shared_overlay_enabled: false }));
  const overlay = page.getByTestId('navigation-live-lidar-scan-overlay');
  await expect(overlay.locator('circle')).toHaveCount(1);
  await expect(overlay.locator('circle')).toHaveAttribute('cx', '0.5');
  liveSocket.send(JSON.stringify({
    type: 'live_update',
    navigation: { ready: false },
    scan: { ...scan, frame_id: 'odom' },
    shared_overlay_enabled: false,
  }));
  await expect(overlay.locator('circle')).toHaveCount(0);
});

test('live adaptive planner displays fresh obstacles and keeps waypoints anchored in map coordinates', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'teacher', username: 'teacher-live-adaptive-test' },
    }));
  });
  await page.route('**/api/navigation/map', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: true,
        map: {
          map_id: 'classroom',
          version: 'live-v1',
          frame_id: 'map',
          resolution_m: 1,
          width: 2,
          height: 2,
          origin: { x: -1, y: -1, yaw_rad: 0 },
        },
        data: [0, 0, 0, 0],
      }),
    });
  });
  await page.routeWebSocket('**/api/lidar/live', (socket) => {
    page.liveAdaptiveSocket = socket;
  });

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Path Planner' }).click();
  await page.getByRole('button', { name: 'Live adaptive' }).click();
  await page.getByRole('button', { name: 'Load live occupancy map' }).click();
  await page.getByRole('button', { name: 'Add map goals' }).click();
  const mapClick = await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="navigation-map-coordinate-layer"]');
    const svg = layer.ownerSVGElement;
    const target = svg.createSVGPoint();
    target.x = 0.5;
    target.y = 0.5;
    const screenPoint = target.matrixTransform(layer.getScreenCTM());
    const bounds = svg.getBoundingClientRect();
    return { x: screenPoint.x - bounds.left, y: screenPoint.y - bounds.top };
  });
  await page.getByRole('img', { name: 'ROS occupancy map and navigation destinations' }).click({
    position: mapClick,
  });
  await expect(page.getByTestId('navigation-waypoint-1')).toBeVisible();
  await expect.poll(() => Boolean(page.liveAdaptiveSocket)).toBeTruthy();
  page.liveAdaptiveSocket.send(JSON.stringify({
    type: 'live_update',
    navigation: {
      ready: true,
      motion_ready: true,
      live_avoidance_ready: true,
      live_obstacles: {
        ready: true,
        frame_id: 'map',
        age_ms: 80,
        points: [{ x: 0.25, y: 0.25 }],
      },
      localization: {
        ready: true,
        frame_id: 'map',
        pose: { x: -0.5, y: -0.5, yaw_rad: 0 },
        age_ms: 50,
      },
      map: { map_id: 'classroom', version: 'live-v1' },
      diagnostics: {
        topics: { pointcloud: '/lidar/front,/lidar/rear' },
        pointcloud: {
          sources: [
            { topic: '/lidar/front', frame_id: 'front_lidar', ready: true, age_ms: 60 },
            { topic: '/lidar/rear', frame_id: 'rear_lidar', ready: false, age_ms: 1700, error: 'stale source' },
          ],
        },
      },
    },
    scan: null,
    shared_overlay_enabled: false,
  }));
  await expect(page.getByTestId('navigation-live-obstacles-overlay').locator('circle')).toHaveCount(1);
  await expect(page.getByTestId('navigation-live-robot-pose')).toBeVisible();
  await expect(page.getByTestId('navigation-waypoint-1')).toHaveAttribute('cx', '0.5');
  await expect(page.getByText(/Live local costmap • 1 obstacle samples/)).toBeVisible();
  await expect(page.getByTestId('navigation-pointcloud-source').filter({ hasText: '/lidar/front · contributing' })).toBeVisible();
  await expect(page.getByTestId('navigation-pointcloud-source').filter({ hasText: '/lidar/rear · unavailable' })).toContainText('stale source');
});

test('teacher can preview a route without motion before starting Nav2', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'teacher', username: 'teacher-navigation-execution-test' },
    }));
  });
  let motionReady = true;
  await page.route('**/api/navigation/map', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: true,
        map: {
          map_id: 'classroom',
          version: 'v2',
          frame_id: 'map',
          resolution_m: 1,
          width: 2,
          height: 2,
          origin: { x: -1, y: -1, yaw_rad: 0 },
        },
        data: [0, 0, 0, 0],
      }),
    });
  });
  await page.route('**/api/lidar/map', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: false,
        map: {
          ready: true,
          map: {
            map_id: 'classroom',
            version: 'v2',
            frame_id: 'map',
            resolution_m: 1,
            width: 2,
            height: 2,
            origin: { x: -1, y: -1, yaw_rad: 0 },
          },
          data: [0, 0, 0, 0],
        },
        pointcloud: null,
      }),
    });
  });
  await page.route('**/api/navigation/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ready',
        ready: true,
        motionReady,
        estop: {
          ready: motionReady,
          age_ms: 40,
          error: motionReady ? null : 'E-stop is engaged or the safety circuit is unhealthy.',
        },
        robotHealth: { ready: true, age_ms: 30, error: null },
        localization: {
          pose: { x: 0, y: 0, yaw_rad: 0 },
          age_ms: 40,
        },
        pointcloudAgeMs: 50,
        map: { map_id: 'classroom', version: 'v2', frame_id: 'map' },
      }),
    });
  });
  let navigationStartCalls = 0;
  let operationPollCalls = 0;
  await page.route('**/api/navigation/start', async (route) => {
    navigationStartCalls += 1;
    const request = route.request().postDataJSON();
    expect(request.map_id).toBe('classroom');
    expect(request.version).toBe('v2');
    expect(request.frame_id).toBe('map');
    expect(request.planner_mode).toBe('static');
    expect(request.waypoints).toEqual([{ x: -0.5, y: -0.5 }]);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        operation_id: '12345678-1234-1234-1234-123456789abc',
        status: 'accepted',
      }),
    });
  });
  await page.route('**/api/navigation/plan', async (route) => {
    const request = route.request().postDataJSON();
    expect(request.map_id).toBe('classroom');
    expect(request.version).toBe('v2');
    expect(request.frame_id).toBe('map');
    expect(request.planner_mode).toBe('static');
    expect(request.waypoints).toHaveLength(1);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        map_id: 'classroom',
        version: 'v2',
        frame_id: 'map',
        planner_id: 'GridBased',
        path: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }],
      }),
    });
  });
  await page.route('**/api/navigation/operation/*', async (route) => {
    operationPollCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        operation_id: '12345678-1234-1234-1234-123456789abc',
        status: 'succeeded',
        current_waypoint: 1,
      }),
    });
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Path Planner' }).click();
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByText(/e-stop healthy/)).toBeVisible();
  await page.getByRole('button', { name: 'Load static 360° map' }).click();
  await expect(page.getByText(/Static scan map loaded • 2 × 2 cells • map classroom • version v2/)).toBeVisible();
  await page.getByRole('button', { name: 'Add map goals' }).click();
  const mapClick = await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="navigation-map-coordinate-layer"]');
    const svg = layer.ownerSVGElement;
    const target = svg.createSVGPoint();
    target.x = 0.5;
    target.y = 0.5;
    const screenPoint = target.matrixTransform(layer.getScreenCTM());
    const bounds = svg.getBoundingClientRect();
    return { x: screenPoint.x - bounds.left, y: screenPoint.y - bounds.top };
  });
  await page.getByRole('img', { name: 'ROS occupancy map and navigation destinations' }).click({
    position: mapClick,
  });
  await expect(page.getByText('Goal 1: -0.50, -0.50 m (map)')).toBeVisible();
  const startNavigation = page.getByRole('button', { name: 'Start Nav2' });
  await expect(startNavigation).toBeDisabled();
  expect(navigationStartCalls).toBe(0);
  await page.getByRole('button', { name: 'Preview route • no motion' }).click();
  await expect(page.getByTestId('navigation-preview-status')).toContainText('no motion sent');
  await expect(page.getByTestId('navigation-route-preview')).toHaveAttribute('points', '1,1 1.5,1.5');
  motionReady = false;
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(startNavigation).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Preview route • no motion' })).toBeEnabled();
  await page.getByRole('button', { name: 'Preview route • no motion' }).click();
  await expect(page.getByTestId('navigation-preview-status')).toContainText('no motion sent');
  motionReady = true;
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(startNavigation).toBeEnabled();
  await page.getByRole('button', { name: 'Start Nav2' }).click();
  await expect.poll(() => operationPollCalls).toBeGreaterThan(0);
  await expect(page.getByTestId('navigation-execution-status')).toContainText('Navigation completed');
});

test('teacher can test LiDAR status without issuing a robot motion command', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'teacher', username: 'teacher-lidar-test' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path === '/api/robot/status'
      ? {
        sdkAvailable: false,
        distanceSensor: {
          ready: true,
          calibrated: true,
          measurement: 'footprint_clearance',
          distance_m: 0.84,
          max_range_m: 39.5,
          age_ms: 38,
          frame_id: 'base_link',
          sensor_frame_id: 'livox_frame',
          timestamp: new Date().toISOString(),
          rear: {
            ready: true,
            calibrated: true,
            measurement: 'footprint_clearance',
            distance_m: 1.14,
            max_range_m: 39.7,
            age_ms: 46,
            frame_id: 'base_link',
            sensor_frame_id: 'livox_frame',
          },
        },
      }
      : path === '/api/classroom/codes'
        ? { codes: [], starter_codes: [], shared_motions: [] }
        : path === '/api/classroom/queue'
          ? { items: [] }
          : path === '/api/classroom/users'
            ? { users: [] }
            : path === '/api/classroom/status'
              ? { status: 'idle' }
              : path === '/api/classroom/projects/all'
                ? { projects: [] }
                : path === '/api/classroom/project'
                  ? { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } }
                  : {};
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.goto('/');
  await openConnectionPanel(page);
  await expect(page.getByRole('button', { name: 'Test LiDAR' })).toBeVisible();
  await page.getByRole('button', { name: 'Test LiDAR' }).click();
  await expect(page.getByRole('status').filter({
    hasText: 'Front clearance 0.84 m from robot footprint • 38 ms old',
  })).toContainText('Rear clearance 1.14 m from robot footprint • 46 ms old');
});

test('teacher LiDAR status distinguishes disabled distance conditions from sensor connectivity', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'teacher', username: 'teacher-lidar-calibration-test' },
    }));
  });
  const error = 'MID-360-to-robot transform and footprint calibration are unconfirmed; physical distance conditions are disabled.';
  await page.route('**/api/robot/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sdkAvailable: false,
        distanceSensor: {
          ready: false,
          error,
          rear: { ready: false, error },
        },
      }),
    });
  });
  await page.goto('/');
  await openConnectionPanel(page);
  await page.getByRole('button', { name: 'Test LiDAR' }).click();
  const status = page.getByRole('status').filter({
    hasText: 'Front distance conditions disabled',
  });
  await expect(status).toContainText('Rear distance conditions disabled');
  await expect(status).not.toContainText('Front unavailable');
});

test('object library items keep distinct shapes when added to the scene', async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-object-library-test' },
    }));
  });
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'Add Object' }).click();

  for (const objectType of ['Box', 'Wall', 'Platform', 'Ramp', 'Stairs', 'Sphere', 'Cylinder', 'Table', 'Terrain']) {
    const objectLabel = page.getByText(objectType, { exact: true });
    await objectLabel.click({ force: true });
  }

  const scene = page.locator('svg[viewBox="0 0 220 220"]');
  for (const type of ['box', 'wall', 'platform', 'ramp', 'stairs', 'sphere', 'cylinder', 'table', 'terrain']) {
    await expect(scene.locator(`g[data-obstacle-type="${type}"]`)).toHaveCount(1);
  }
  await expect(scene.locator('g[data-obstacle-type="box"] polygon')).toHaveCount(3);
  await expect(scene.locator('g[data-obstacle-type="wall"] path')).toHaveCount(1);
  await expect(scene.locator('g[data-obstacle-type="platform"] rect')).toHaveCount(2);
  await expect(scene.locator('g[data-obstacle-type="ramp"] polygon')).toHaveCount(1);
  await expect(scene.locator('g[data-obstacle-type="stairs"] path')).toHaveCount(1);
  await expect(scene.locator('g[data-obstacle-type="sphere"] circle')).toHaveCount(2);
  await expect(scene.locator('g[data-obstacle-type="cylinder"] ellipse')).toHaveCount(1);
  await expect(scene.locator('g[data-obstacle-type="cylinder"] circle')).toHaveCount(1);
  await expect(scene.locator('g[data-obstacle-type="table"] circle')).toHaveCount(4);
  await expect(scene.locator('g[data-obstacle-type="terrain"] polygon')).toHaveCount(1);
});

test('unsupported saved code is preserved and explained in the Blocks view for both roles', async ({ browser }) => {
  test.setTimeout(90000);
  for (const role of ['student', 'teacher']) {
    const page = await browser.newPage();
    page.on('dialog', (dialog) => dialog.accept());
    await page.addInitScript((userRole) => {
      localStorage.setItem('edu-classroom-session', JSON.stringify({
        token: 'test-token',
        user: { role: userRole, username: `${userRole}-unsupported-code-test` },
      }));
    }, role);

    await page.goto('/');
    await expect(page.locator('canvas')).toBeVisible();
    await page.getByRole('button', { name: 'IDE', exact: true }).click();
    await page.locator('textarea').first().fill('robot.walk\n');
    await page.getByRole('button', { name: 'Blocks', exact: true }).click();
    await expect(page.getByText('This code cannot be represented with Blocks')).toBeVisible();
    await expect(page.getByText(/Unsupported statement on line 1/).first()).toBeVisible();
    await expect(page.locator('.blocklySvg')).toBeVisible();
    await page.getByRole('button', { name: 'Edit in IDE' }).click();
    await expect(page.locator('textarea').first()).toHaveValue('robot.walk\n');
    await page.getByRole('button', { name: 'Blocks', exact: true }).click();
    await page.getByRole('button', { name: 'Clear unsupported code' }).click();
    await expect(page.getByText('Choose a command from the toolbox to get started.')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.close();
  }
});

test('simulation playback speed follows estimated SDK command duration', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: 'student-playback-test' },
    }));
  });
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.locator('textarea').first().fill('robot.walk(2)');
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await page.getByRole('button', { name: 'Run simulation' }).first().click();

  await page.waitForTimeout(600);
  const playbackPercent = Number((await page.getByText(/^\d+%$/).textContent()).replace('%', ''));
  expect(playbackPercent).toBeGreaterThan(0);
  expect(playbackPercent).toBeLessThan(60);
});

test('compiling a planner path preserves its waypoint coordinates', async ({ page }) => {
  test.setTimeout(120000);
  const username = `planner-test-${Date.now()}`;
  await page.addInitScript((testUsername) => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'teacher', username: testUsername },
    }));
  }, username);
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Path Planner' }).click();
  await expect(page.getByText('No waypoints yet.')).toBeVisible();
  const canvas = page.locator('canvas');
  const canvasBounds = await canvas.boundingBox();
  await page.getByRole('button', { name: 'Place waypoint' }).click();
  await expect(page.getByText('Waypoint 1', { exact: true })).toHaveCount(0);
  await page.mouse.click(canvasBounds.x + canvasBounds.width * 0.3, canvasBounds.y + canvasBounds.height * 0.56);
  await expect(page.getByText('Waypoint 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Place waypoint' }).click();
  await expect(page.getByText('Waypoint 2', { exact: true })).toHaveCount(0);
  await page.mouse.click(canvasBounds.x + canvasBounds.width * 0.38, canvasBounds.y + canvasBounds.height * 0.56);
  await expect(page.getByText('Waypoint 2', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="waypoint-distance"]')).toHaveText(/^\d+\.\d{2} m from waypoint 1$/);
  await expect(page.locator('[data-testid="waypoint-total-distance"]')).toHaveText(/^\d+\.\d{2} m total$/);

  const firstWaypoint = page.getByText('Waypoint 1', { exact: true }).locator('xpath=../..');
  const secondWaypoint = page.getByText('Waypoint 2', { exact: true }).locator('xpath=../..');
  const waypointCoordinates = async () => Promise.all([
    firstWaypoint.locator('input[type="number"]').nth(0).inputValue(),
    firstWaypoint.locator('input[type="number"]').nth(1).inputValue(),
    secondWaypoint.locator('input[type="number"]').nth(0).inputValue(),
    secondWaypoint.locator('input[type="number"]').nth(1).inputValue(),
  ]);
  const coordinatesBeforeCompile = await waypointCoordinates();
  expect(coordinatesBeforeCompile).not.toEqual(['0', '0', '0', '0']);
  expect(coordinatesBeforeCompile).not.toEqual(['4', '2', '8', '4']);
  expect(coordinatesBeforeCompile.slice(0, 2)).not.toEqual(coordinatesBeforeCompile.slice(2));

  await page.getByRole('button', { name: 'Compile' }).click();
  expect(await waypointCoordinates()).toEqual(coordinatesBeforeCompile);
  await expect(page.locator('[data-testid="waypoint-total-distance"]')).toBeVisible();

  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await expect(page.locator('textarea').first()).toHaveValue(/robot\.walktime\(/);
  await expect(page.locator('textarea').first()).not.toHaveValue(/robot\.moveTo\(/);
  await page.getByRole('button', { name: 'Path Planner' }).click();

  expect(await waypointCoordinates()).toEqual(coordinatesBeforeCompile);

  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await page.getByRole('button', { name: 'Run simulation' }).first().click();
  await page.getByRole('button', { name: 'Path Planner' }).click();

  expect(await waypointCoordinates()).toEqual(coordinatesBeforeCompile);

  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect(page.locator('.blocklyText').filter({ hasText: 'Walk forward for' }).first()).toBeVisible();
  await page.evaluate(() => {
    const walkBlock = window.Blockly.getMainWorkspace().getAllBlocks().find((block) => block.type === 'g1_command_walktime');
    walkBlock.setFieldValue('6.25', 'SECONDS');
  });

  await page.getByRole('button', { name: 'IDE', exact: true }).evaluate((button) => button.click());
  await expect(page.locator('textarea').first()).toHaveValue(/robot\.walktime\(6\.25\)/);

  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Path Planner')
      ?.click();
  });
  await expect.poll(async () => {
    const [x, y] = await secondWaypoint.locator('input[type="number"]').evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
    return Number(Math.hypot(x, y).toFixed(1));
  }).toBe(2.5);

  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await page.locator('textarea').first().fill('robot.walk(3)\nrobot.turn("right", 45)');
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect(page.locator('.blocklyText').filter({ hasText: 'Walk forward' }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    window.Blockly.getMainWorkspace().getAllBlocks().map((block) => block.type)
  ))).toEqual(['g1_command_walk', 'g1_command_turn']);
  await page.getByRole('button', { name: 'IDE', exact: true }).click();
  await expect(page.locator('textarea').first()).toHaveValue('robot.walk(3)\nrobot.turn("right", 45)');

  await page.getByRole('button', { name: 'Path Planner' }).click();
  await expect(secondWaypoint).toBeVisible();
  await secondWaypoint.scrollIntoViewIfNeeded();
  await secondWaypoint.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Waypoint 2', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Waypoint 1', { exact: true })).toBeVisible();
});

test('students can add, move, delete, and compile planner waypoints', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: `student-planner-${Date.now()}` },
    }));
  });
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Path Planner' }).click();
  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();

  await page.getByRole('button', { name: 'Place waypoint' }).click();
  await page.mouse.click(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.56);
  await expect(page.getByText('Waypoint 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Place waypoint' }).click();
  await page.mouse.click(bounds.x + bounds.width * 0.38, bounds.y + bounds.height * 0.56);
  await expect(page.getByText('Waypoint 2', { exact: true })).toBeVisible();

  const waypointCard = (index) => page.getByText(`Waypoint ${index}`, { exact: true }).locator('xpath=../..');
  const firstWaypoint = waypointCard(1);
  const secondWaypoint = waypointCard(2);
  await page.getByRole('button', { name: 'Compile' }).click();
  await firstWaypoint.locator('input[type="number"]').nth(0).fill('2.5');
  await expect(firstWaypoint.locator('input[type="number"]').nth(0)).toHaveValue('2.5');
  await expect(secondWaypoint).toBeVisible();
  await firstWaypoint.scrollIntoViewIfNeeded();
  await firstWaypoint.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Waypoint 2', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Waypoint 1', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="waypoint-total-distance"]')).toHaveCount(0);
});

test('teacher DUET commissioning supports retry, review, failure, and copyable evidence without legacy runs', async ({ page }) => {
  const requests = [];
  const abortRequests = [];
  const steps = [
    { id: 'base-custom-vector', title: 'Custom bounded base vector', expected: 'Brief bounded motion then zero velocity.', code: 'duet.move(0.05, 0.05, 0.1, 0.5)', status: 'pending', attempts: [] },
    { id: 'program-stop-command', title: 'DUET program stop command', expected: 'The executor reports stopped.', code: 'duet.stop()', status: 'pending', attempts: [] },
  ];
  let report = { status: 'not_started', current_step: null, steps: [], commissioning_enabled: true };
  const evidence = {
    report: { status: 'failed', report_id: 'commissioning-e2e', steps: [] },
    events: [{ event: 'step_reviewed', passed: false }],
    event_log: '{"event":"step_reviewed","passed":false}\n',
  };

  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-duet-commissioning-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
    window.__copiedCommissioningEvidence = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copiedCommissioningEvidence = text;
        },
      },
    });
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    requests.push({ path, method: request.method(), body: request.postDataJSON() });
    let body = {};

    if (path === '/api/classroom/codes') body = { codes: [] };
    else if (path === '/api/classroom/queue') body = { items: [] };
    else if (path === '/api/classroom/users') body = { users: [{ username: 'teacher', role: 'teacher' }] };
    else if (path === '/api/classroom/status') body = { status: 'idle' };
    else if (path === '/api/classroom/projects/all') body = { projects: [] };
    else if (path === '/api/classroom/project') body = { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } };
    else if (path === '/api/robot/status') body = { sdkAvailable: false, running: false };
    else if (path === '/api/duet/commissioning' && request.method() === 'GET') body = report;
    else if (path === '/api/duet/commissioning/evidence') body = evidence;
    else if (path === '/api/duet/connect') {
      body = { status: 'connected', ready: true, connected: true, motionOwner: 'duet', capabilities: ['base_velocity', 'arm_targets'] };
    } else if (path === '/api/duet/commissioning/start') {
      report = {
        report_id: 'commissioning-e2e',
        status: 'in_progress',
        current_step: 0,
        commissioning_enabled: true,
        steps: steps.map((step) => ({ ...step, attempts: [...step.attempts] })),
      };
      body = report;
    } else if (path === '/api/duet/commissioning/step') {
      const { step_index: stepIndex } = request.postDataJSON();
      const step = report.steps[stepIndex];
      step.attempts.push({ attempt: step.attempts.length + 1 });
      step.status = 'awaiting_review';
      step.result = { status: 'completed', commandsExecuted: 1, armTelemetry: [] };
      body = report;
    } else if (path === '/api/duet/commissioning/review') {
      const review = request.postDataJSON();
      const step = report.steps[review.step_index];
      step.review = review;
      if (review.passed) {
        step.status = 'passed';
        report.current_step += 1;
      } else {
        step.status = 'failed';
        report.status = 'failed';
      }
      body = report;
    } else if (path === '/api/duet/commissioning/abort') {
      abortRequests.push(path);
      report.status = 'aborted';
      body = report;
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open app settings' }).click();
  await page.getByRole('checkbox', { name: 'Enable DUET version two' }).check();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await openConnectionPanel(page);
  const connectionPanel = page.getByRole('dialog', { name: 'Robot connection panel' });
  await expect(connectionPanel.getByText('Teacher-only DUET commissioning')).toBeVisible();
  page.on('dialog', (dialog) => dialog.accept());
  await connectionPanel.getByRole('button', { name: 'Connect', exact: true }).click();
  await connectionPanel.getByRole('button', { name: 'Start full test sequence' }).click();
  await connectionPanel.getByRole('button', { name: 'Run test 1' }).click();
  await connectionPanel.getByRole('button', { name: 'Run again' }).click();

  const observedResult = connectionPanel.getByLabel('DUET commissioning observed result');
  await observedResult.fill('Observed the test response and confirmed the expected direction.');
  const nextButton = connectionPanel.getByRole('button', { name: 'Next', exact: true });
  await expect(nextButton).toBeDisabled();
  await connectionPanel.getByLabel('I physically observed the expected robot response for this test.').check();
  await expect(nextButton).toBeEnabled();
  await nextButton.click();

  await connectionPanel.getByRole('button', { name: 'Run test 2' }).click();
  await connectionPanel.getByLabel('DUET commissioning observed result').fill('Observed a discrepancy; stopping this commissioning run.');
  await connectionPanel.getByRole('button', { name: 'Fail and stop sequence' }).click();
  await expect(connectionPanel.getByText('failed', { exact: true })).toBeVisible();
  await connectionPanel.getByRole('button', { name: 'Copy evidence' }).click();
  await expect(connectionPanel.getByLabel('Selectable DUET commissioning report and event log')).toHaveValue(/commissioning-e2e/);
  await expect.poll(() => page.evaluate(() => window.__copiedCommissioningEvidence)).toContain('"event_log"');

  await connectionPanel.getByRole('button', { name: 'Start a new full test' }).click();
  await connectionPanel.getByRole('button', { name: 'Abort and request STOP' }).click();
  await expect(connectionPanel.getByText('aborted', { exact: true })).toBeVisible();
  expect(abortRequests).toHaveLength(1);

  const reviewRequests = requests.filter((request) => request.path === '/api/duet/commissioning/review');
  expect(reviewRequests.map(({ body }) => body.observed_result)).toEqual([
    'Observed the test response and confirmed the expected direction.',
    'Observed a discrepancy; stopping this commissioning run.',
  ]);
  expect(requests.filter(({ path }) => path === '/api/duet/commissioning/step')).toHaveLength(3);
  expect(requests.some(({ path }) => path === '/api/run' || path === '/api/duet/run')).toBe(false);
});

test('DUET commissioning is hidden from students', async ({ page }) => {
  const commissioningRequests = [];
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'student-duet-commissioning-token',
      user: { role: 'student', username: 'student1' },
    }));
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/duet/commissioning')) commissioningRequests.push(path);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  await page.goto('/');
  await expect(page.getByText('Teacher-only DUET commissioning')).toHaveCount(0);
  expect(commissioningRequests).toEqual([]);
});

test('teacher commissioning controls stay disabled when the backend feature gate is off', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'teacher-duet-commissioning-disabled-token',
      user: { role: 'teacher', username: 'teacher' },
    }));
  });
  const startRequests = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body = {};
    if (path === '/api/classroom/codes') body = { codes: [] };
    else if (path === '/api/classroom/queue') body = { items: [] };
    else if (path === '/api/classroom/users') body = { users: [{ username: 'teacher', role: 'teacher' }] };
    else if (path === '/api/classroom/status') body = { status: 'idle' };
    else if (path === '/api/classroom/projects/all') body = { projects: [] };
    else if (path === '/api/classroom/project') body = { project: { name: 'default', sceneObjects: [], plannerWaypoints: [], generatedCode: '' } };
    else if (path === '/api/robot/status') body = { sdkAvailable: false, running: false };
    else if (path === '/api/duet/commissioning') {
      body = { status: 'not_started', steps: [], current_step: null, commissioning_enabled: false };
    } else if (path === '/api/duet/connect') {
      body = { status: 'connected', ready: true, connected: true, motionOwner: 'duet' };
    } else if (path === '/api/duet/commissioning/start') {
      startRequests.push(path);
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open app settings' }).click();
  await page.getByRole('checkbox', { name: 'Enable DUET version two' }).check();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await openConnectionPanel(page);
  const robotSettings = page.getByTestId('teacher-robot-settings');
  page.on('dialog', (dialog) => dialog.accept());
  await robotSettings.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(robotSettings.getByText('Guided commissioning is disabled.')).toBeVisible();
  const startButton = robotSettings.getByRole('button', { name: 'Start full test sequence' });
  await expect(startButton).toBeDisabled();
  await startButton.click({ force: true });
  expect(startRequests).toEqual([]);
});
