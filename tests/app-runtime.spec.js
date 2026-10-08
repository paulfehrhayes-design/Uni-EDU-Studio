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
  await page.mouse.click(canvasBounds.x + canvasBounds.width * 0.3, canvasBounds.y + canvasBounds.height * 0.56);
  await expect(page.getByText('Waypoint 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Place waypoint' }).click();
  await page.mouse.click(canvasBounds.x + canvasBounds.width * 0.38, canvasBounds.y + canvasBounds.height * 0.56);
  await expect(page.getByText('Waypoint 2', { exact: true })).toBeVisible();

  const firstWaypoint = page.getByText('Waypoint 1', { exact: true }).locator('xpath=../..');
  const secondWaypoint = page.getByText('Waypoint 2', { exact: true }).locator('xpath=../..');
  const thirdWaypoint = page.getByText('Waypoint 3', { exact: true }).locator('xpath=../..');
  const waypointCoordinates = async () => Promise.all([
    firstWaypoint.locator('input[type="number"]').nth(0).inputValue(),
    firstWaypoint.locator('input[type="number"]').nth(1).inputValue(),
    secondWaypoint.locator('input[type="number"]').nth(0).inputValue(),
    secondWaypoint.locator('input[type="number"]').nth(1).inputValue(),
  ]);
  const coordinatesBeforeCompile = await waypointCoordinates();
  expect(coordinatesBeforeCompile).not.toEqual(['0', '0', '0', '0']);

  await page.getByRole('button', { name: 'Compile' }).click();
  await page.getByRole('button', { name: 'Path Planner' }).click();

  expect(await waypointCoordinates()).toEqual(coordinatesBeforeCompile);

  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect(page.locator('.blocklyText').filter({ hasText: 'Move to X' }).first()).toBeVisible();
  await page.evaluate(() => {
    const moveBlock = window.Blockly.getMainWorkspace().getAllBlocks().find((block) => block.type === 'robot_move_to');
    moveBlock.setFieldValue('6.25', 'X');
    moveBlock.setFieldValue('7.5', 'Y');
  });

  await page.getByRole('button', { name: 'IDE', exact: true }).evaluate((button) => button.click());
  await expect(page.locator('textarea').first()).toHaveValue(/robot\.moveTo\(6\.25, 7\.5\)/);

  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Path Planner')
      ?.click();
  });
  await expect.poll(() => secondWaypoint.locator('input[type="number"]').evaluateAll((inputs) => inputs.map((input) => input.value))).toEqual(['6.25', '7.5']);
});
