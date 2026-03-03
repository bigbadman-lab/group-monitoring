const { chromium } = require('playwright');

(async () => {
  const context = await chromium.launchPersistentContext('./profile', {
    headless: false,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--lang=en-GB'
    ],
  });

  const page = await context.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

  console.log('Headed login running on DISPLAY. Log in in the VNC window.');
  await page.waitForTimeout(30 * 60 * 1000);

  await context.close();
})();
