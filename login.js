const { chromium } = require('playwright');

(async () => {
  const userDataDir = './profile';

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--remote-debugging-address=0.0.0.0',
      '--remote-debugging-port=9222'
    ],
  });

  const page = await context.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

  console.log('Remote debugging enabled on port 9222.');
  console.log('Leave this running while you connect from your Mac.');
  await page.waitForTimeout(30 * 60 * 1000);

  await context.close();
})();
