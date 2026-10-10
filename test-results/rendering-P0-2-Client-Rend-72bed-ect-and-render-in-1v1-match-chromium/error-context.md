# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: rendering.spec.ts >> P0-2: Client Rendering (1v1 Two-Tab) >> two browsers connect and render in 1v1 match
- Location: tests/e2e/rendering.spec.ts:4:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('canvas')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('canvas') with timeout 5000ms
  - waiting for locator('canvas')

```

```yaml
- heading "땅따 | Turf Duel" [level=2]:
  - img "땅따 | Turf Duel"
- text: "Server URL:"
- textbox "ws://localhost:2567"
- button "Connect to Server"
- button "Play vs Bot (Local)"
- paragraph: "Controls: Arrow keys or WASD"
- paragraph: Ready to connect
```

# Test source

```ts
  1  | import { test, expect, type Page } from '@playwright/test';
  2  | 
  3  | test.describe('P0-2: Client Rendering (1v1 Two-Tab)', () => {
  4  |   test('two browsers connect and render in 1v1 match', async ({ browser }) => {
  5  |     // Open two pages (simulating two tabs)
  6  |     const context1 = await browser.newContext();
  7  |     const context2 = await browser.newContext();
  8  |     const page1 = await context1.newPage();
  9  |     const page2 = await context2.newPage();
  10 | 
  11 |     // Navigate both to the client
  12 |     await page1.goto('/');
  13 |     await page2.goto('/');
  14 | 
  15 |     // Wait for page load
  16 |     await page1.waitForLoadState('networkidle');
  17 |     await page2.waitForLoadState('networkidle');
  18 | 
  19 |     // Check canvas exists
  20 |     const canvas1 = await page1.locator('canvas');
  21 |     const canvas2 = await page2.locator('canvas');
> 22 |     await expect(canvas1).toBeVisible();
     |                           ^ Error: expect(locator).toBeVisible() failed
  23 |     await expect(canvas2).toBeVisible();
  24 | 
  25 |     console.log('✓ Canvas elements visible on both pages');
  26 | 
  27 |     // Check initial debug hook exists
  28 |     const initialDebug1 = await page1.evaluate(() => window.__turfDebug);
  29 |     const initialDebug2 = await page2.evaluate(() => window.__turfDebug);
  30 |     
  31 |     expect(initialDebug1).toBeDefined();
  32 |     expect(initialDebug2).toBeDefined();
  33 |     
  34 |     console.log('✓ Debug hooks initialized');
  35 | 
  36 |     // Both click "Connect to Server"
  37 |     await page1.click('#connectBtn');
  38 |     await page2.click('#connectBtn');
  39 | 
  40 |     console.log('✓ Both pages clicked Connect');
  41 | 
  42 |     // Wait for connection (status should change from initial state)
  43 |     await page1.waitForTimeout(3000);
  44 | 
  45 |     // Check connection status
  46 |     const status1 = await page1.textContent('#status');
  47 |     const status2 = await page2.textContent('#status');
  48 |     console.log('Page 1 status:', status1);
  49 |     console.log('Page 2 status:', status2);
  50 | 
  51 |     // Both should be connected (not showing initial state or error)
  52 |     expect(status1).toContain('Connected');
  53 |     expect(status2).toContain('Connected');
  54 | 
  55 |     // Wait for game to progress
  56 |     await page1.waitForTimeout(5000);
  57 | 
  58 |     // Get final debug info
  59 |     const finalDebug1 = await page1.evaluate(() => window.__turfDebug);
  60 |     const finalDebug2 = await page2.evaluate(() => window.__turfDebug);
  61 | 
  62 |     console.log('Final debug1:', finalDebug1);
  63 |     console.log('Final debug2:', finalDebug2);
  64 | 
  65 |     // Assert rendering happened (tick should advance OR frames should be rendered)
  66 |     // In online mode with full grid sync, tick advances but frames may not render
  67 |     // in headless mode if Phaser doesn't initialize properly
  68 |     const page1Active = (finalDebug1!.tick > 0) || (finalDebug1!.renderedFrames > 0);
  69 |     const page2Active = (finalDebug2!.tick > 0) || (finalDebug2!.renderedFrames > 0);
  70 | 
  71 |     expect(page1Active).toBe(true);
  72 |     expect(page2Active).toBe(true);
  73 | 
  74 |     console.log(`✓ Page 1: tick=${finalDebug1!.tick}, frames=${finalDebug1!.renderedFrames}`);
  75 |     console.log(`✓ Page 2: tick=${finalDebug2!.tick}, frames=${finalDebug2!.renderedFrames}`);
  76 | 
  77 |     // If ticks advanced, check owned cells
  78 |     if (finalDebug1!.tick > 10) {
  79 |       expect(finalDebug1!.ownedCells.p1).toBeGreaterThan(0);
  80 |       expect(finalDebug1!.ownedCells.p2).toBeGreaterThan(0);
  81 |       console.log('✓ Both players have owned cells');
  82 |     }
  83 | 
  84 |     // Cleanup
  85 |     await context1.close();
  86 |     await context2.close();
  87 |   });
  88 | });
  89 | 
```