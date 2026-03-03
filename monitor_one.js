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

    await page.goto(groupUrl, { waitUntil: 'networkidle' });

    // Scroll to trigger lazy loading
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(3000);

    const posts = await page.$$eval(
      'div[role="feed"] div[data-ad-preview="message"]',
      nodes => nodes.map(n => n.innerText).filter(Boolean)
    );

    if (posts.length === 0) {
      console.log('No posts found (selector may need adjustment).');
    } else {
      posts.slice(0, 5).forEach((post, i) => {
        console.log(`Post ${i + 1}:\n${post}\n-------------------\n`);
      });
    }
  }

  await context.close();
})();
