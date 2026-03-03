const { chromium } = require('playwright');

(async () => {
  const context = await chromium.launchPersistentContext('./profile', {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await context.newPage();

  const groups = [
    'https://www.facebook.com/groups/989141844449592',
    'https://www.facebook.com/groups/1536046086634463'
  ];

  for (const groupUrl of groups) {
    console.log('\n==============================');
    console.log('Checking group:', groupUrl);
    console.log('==============================\n');

    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.waitForTimeout(5000);
    await page.mouse.wheel(0, 6000);
    await page.waitForTimeout(4000);

    // Broader selector
    const posts = await page.$$eval(
      'div[role="feed"] div[dir="auto"]',
      nodes => nodes
        .map(n => n.innerText)
        .filter(text => text.length > 40) // filter out small junk text
    );

    if (posts.length === 0) {
      console.log('Still no posts found.');
    } else {
      posts.slice(0, 8).forEach((post, i) => {
        console.log(`Post ${i + 1}:\n${post}\n-------------------\n`);
      });
    }
  }

  await context.close();
})();
