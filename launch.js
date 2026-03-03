const { chromium } = require('playwright');

(async () => {
  const userDataDir = './profile'; // persistent profile lives here

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ],
  });

  const page = await context.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

  console.log('Opened Facebook. Title:', await page.title());

  // Keep the browser running for 5 minutes so we can confirm it stays alive.
  // (Later this would run 24/7.)
  await page.waitForTimeout(5 * 60 * 1000);

  await context.close();
})();
