# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app-runtime.spec.js >> App loads without runtime initialization errors
- Location: tests/app-runtime.spec.js:3:1

# Error details

```
Error: expect(locator).not.toHaveText(expected) failed

Locator:  locator('body')
Expected: not ""
Received: "
    
    
  

"
Timeout:  5000ms

Call log:
  - Expect "not toHaveText" locator('body') with timeout 5000ms
  - waiting for locator('body')
    14 × locator resolved to <body>…</body>
       - unexpected value "
    
    
  

"

```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test('App loads without runtime initialization errors', async ({ page }) => {
  4  |   const pageErrors = [];
  5  |   const consoleErrors = [];
  6  | 
  7  |   page.on('pageerror', (error) => pageErrors.push(error.message));
  8  |   page.on('console', (msg) => {
  9  |     if (msg.type() === 'error') {
  10 |       consoleErrors.push(msg.text());
  11 |     }
  12 |   });
  13 | 
  14 |   await page.goto('/');
  15 |   await expect(page.locator('#root')).toBeVisible();
> 16 |   await expect(page.locator('body')).not.toHaveText('');
     |                                          ^ Error: expect(locator).not.toHaveText(expected) failed
  17 | 
  18 |   expect(pageErrors).toEqual([]);
  19 |   expect(consoleErrors).toEqual([]);
  20 | });
  21 | 
```