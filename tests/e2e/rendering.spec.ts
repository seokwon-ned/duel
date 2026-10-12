import { test, expect } from '@playwright/test';

test.describe('P0-2: Client Rendering (1v1 Two-Tab)', () => {
  test('two browsers connect and render in 1v1 match', async ({ browser }) => {
    // Open two pages (simulating two tabs)
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      // Navigate both to the client
      await page1.goto('/');
      await page2.goto('/');

      // Wait for page load
      await page1.waitForLoadState('domcontentloaded');
      await page2.waitForLoadState('domcontentloaded');

      // Check initial debug hook exists (proves main.ts loaded)
      const initialDebug1 = await page1.evaluate(() => window.__turfDebug);
      const initialDebug2 = await page2.evaluate(() => window.__turfDebug);
      
      expect(initialDebug1).toBeDefined();
      expect(initialDebug2).toBeDefined();
      
      console.log('✓ Debug hooks initialized on both pages');

      // Both click "Connect to Server"
      await page1.click('#connectBtn');
      await page2.click('#connectBtn');

      console.log('✓ Both pages clicked Connect button');

      // Wait for connection and initial state sync (3 seconds)
      await page1.waitForTimeout(3000);

      // Check connection status (should say "Connected! Room: ...")
      const status1 = await page1.textContent('#status');
      const status2 = await page2.textContent('#status');
      console.log('Page 1 status:', status1);
      console.log('Page 2 status:', status2);

      // Both should be connected (not showing "Ready to connect" or "Error")
      expect(status1).toContain('Connected');
      expect(status2).toContain('Connected');

      console.log('✓ Both clients connected to server');

      // Wait until the server clock is actually advancing (slack for CI)
      await page1.waitForFunction(
        () => Boolean(window.__turfDebug && window.__turfDebug.tick > 10),
        { timeout: 15000 },
      );
      await page2.waitForFunction(
        () => Boolean(window.__turfDebug && window.__turfDebug.tick > 10),
        { timeout: 15000 },
      );

      // Get final debug info
      const finalDebug1 = await page1.evaluate(() => window.__turfDebug);
      const finalDebug2 = await page2.evaluate(() => window.__turfDebug);

      console.log('Page 1 debug:', finalDebug1);
      console.log('Page 2 debug:', finalDebug2);

      // Assert game state is advancing (tick > 10 after 8 seconds)
      expect(finalDebug1!.tick).toBeGreaterThan(10);
      expect(finalDebug2!.tick).toBeGreaterThan(10);

      console.log(`✓ Game tick advancing: page1=${finalDebug1!.tick}, page2=${finalDebug2!.tick}`);

      // Assert both pages see similar tick (within 5 ticks = 250ms desync tolerance)
      const tickDiff = Math.abs(finalDebug1!.tick - finalDebug2!.tick);
      expect(tickDiff).toBeLessThan(5);

      console.log(`✓ Both pages synchronized (tick diff: ${tickDiff})`);

      // Assert rendering is happening (renderedFrames incremented)
      expect(finalDebug1!.renderedFrames).toBeGreaterThan(0);
      expect(finalDebug2!.renderedFrames).toBeGreaterThan(0);

      console.log(`✓ Rendering active: page1=${finalDebug1!.renderedFrames} frames, page2=${finalDebug2!.renderedFrames} frames`);

      // Assert both players have non-zero owned cells (game logic working)
      expect(finalDebug1!.ownedCells.p1).toBeGreaterThan(0);
      expect(finalDebug1!.ownedCells.p2).toBeGreaterThan(0);
      expect(finalDebug2!.ownedCells.p1).toBeGreaterThan(0);
      expect(finalDebug2!.ownedCells.p2).toBeGreaterThan(0);

      console.log(`✓ Both players own territory: p1=${finalDebug1!.ownedCells.p1}, p2=${finalDebug1!.ownedCells.p2}`);

      // Optional: Check canvas element exists (best-effort, may fail in headless)
      const hasCanvas1 = await page1.locator('canvas').count();
      const hasCanvas2 = await page2.locator('canvas').count();
      if (hasCanvas1 > 0 && hasCanvas2 > 0) {
        console.log('✓ Canvas elements present on both pages');
      } else {
        console.log('⚠ Canvas not detected (headless mode), but debug hook confirms rendering');
      }

    } finally {
      // Cleanup
      await context1.close();
      await context2.close();
    }
  });
});
