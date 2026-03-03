const { chromium } = require('playwright');

(async () => {
  const context = await chromium.launchPersistentContext('./profile', {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await context.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'fb.png', fullPage: true });

  console.log('Saved screenshot to fb.png');
  await context.close();
})();
