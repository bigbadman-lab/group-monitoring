const { chromium } = require('playwright');

(async () => {
  const context = await chromium.launchPersistentContext('./profile', {
    headless: true,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--lang=en-GB',
      '--remote-debugging-address=0.0.0.0',
      '--remote-debugging-port=9222'
    ],
  });

  const page = await context.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

  console.log('Remote debugging on 9222. Current URL:', page.url());
  console.log('Log in via chrome://inspect, then come back here and press CTRL+C when done.');

  // keep alive
  await page.waitForTimeout(30 * 60 * 1000);

  await context.close();
})();
