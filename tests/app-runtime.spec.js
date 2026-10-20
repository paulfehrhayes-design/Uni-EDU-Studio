import { test, expect } from '@playwright/test';

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
  await page.getByRole('button', { name: 'Open queue' }).click();
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
  await page.getByRole('button', { name: 'Load occupancy map' }).click();
  await expect(page.getByText('Loaded • 2 × 2 cells • map classroom • version v2')).toBeVisible();
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
  await expect(page.getByText(/Live map updated • 2 × 2 cells • version v3/)).toBeVisible();
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
  await expect(page.getByText('Goal 1: -0.50, -0.50 m (map)')).toHaveCount(0);
  await expect(page.getByText(/1 destination\(s\) removed because they are no longer in known free space/)).toBeVisible();
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
  await page.getByRole('button', { name: 'Load occupancy map' }).click();
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
  await page.route('**/api/navigation/start', async (route) => {
    navigationStartCalls += 1;
    const request = route.request().postDataJSON();
    expect(request.map_id).toBe('classroom');
    expect(request.version).toBe('v2');
    expect(request.frame_id).toBe('map');
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
  await page.getByRole('button', { name: 'Load occupancy map' }).click();
  await expect(page.getByText('Loaded • 2 × 2 cells • map classroom • version v2')).toBeVisible();
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
  await expect(page.getByTestId('navigation-execution-status')).toContainText('Navigation completed');
});

test('teacher can test LiDAR status without issuing a robot motion command', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'teacher', username: 'teacher-lidar-test' },
    }));
  });
  await page.route('**/api/robot/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
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
      }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open queue' }).click();
  await expect(page.getByRole('button', { name: 'Test LiDAR' })).toBeVisible();
  await page.getByRole('button', { name: 'Test LiDAR' }).click();
  await expect(page.getByRole('status').filter({
    hasText: 'Front clearance 0.84 m from robot footprint • 38 ms old',
  })).toContainText('Rear clearance 1.14 m from robot footprint • 46 ms old');
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
