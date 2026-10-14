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
  await expect(page.getByRole('button', { name: 'Create Account' }).first()).toBeVisible();

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
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
  await page.locator('textarea').first().fill('robot.walk(2)\nrobot.stand()\nrobot.arm_action("hands up")');
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
  });
  await expect(page.locator('pre').filter({ hasText: 'robot.walk(3)' })).toContainText('robot.arm_action("hands up")');
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
  test.setTimeout(60000);
  const username = `planner-test-${Date.now()}`;
  await page.addInitScript((testUsername) => {
    localStorage.setItem('edu-classroom-session', JSON.stringify({
      token: 'test-token',
      user: { role: 'student', username: testUsername },
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
});
