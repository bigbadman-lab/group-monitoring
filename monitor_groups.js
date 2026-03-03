const { chromium } = require('playwright');

const DEBUG = process.argv.includes('--debug');

// Patterns for post permalinks (match relative or absolute hrefs)
const PERMLINK_PATTERNS = [
  /\/groups\/\d+\/posts\/\d+/,
  /permalink\.php\?story_fbid=\d+/,
  /\/permalink\/\d+/,
];

function hrefMatchesPermalink(href) {
  if (!href || typeof href !== 'string') return false;
  const pathAndQuery = href.startsWith('http') ? new URL(href).pathname + new URL(href).search : href;
  return PERMLINK_PATTERNS.some(re => re.test(pathAndQuery));
}

(async () => {
  const context = await chromium.launchPersistentContext('./profile', {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await context.newPage();
  const baseUrl = 'https://www.facebook.com';

  const groups = [
    'https://www.facebook.com/groups/989141844449592',
    'https://www.facebook.com/groups/1536046086634463'
  ];

  for (const groupUrl of groups) {
    console.log('\n==============================');
    console.log('Checking group:', groupUrl);
    console.log('==============================\n');

    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1200);
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1200);

    if (DEBUG) {
      const rawHrefs = await page.$$eval('a[href]', links => links.map(a => a.getAttribute('href')));
      const normalized = new Set();
      for (const href of rawHrefs) {
        if (!hrefMatchesPermalink(href)) continue;
        try {
          const absolute = new URL(href, baseUrl).toString();
          const withoutHash = absolute.split('#')[0];
          normalized.add(withoutHash);
        } catch (_) {}
      }
      const permalinks = [...normalized];
      console.log(`Found ${permalinks.length} post permalinks`);
      permalinks.slice(0, 10).forEach(url => console.log(url));
    } else {
      const posts = await page.$$eval(
        'div[role="feed"] div[dir="auto"]',
        nodes => nodes
          .map(n => n.innerText)
          .filter(text => text.length > 40)
      );

      if (posts.length === 0) {
        console.log('Still no posts found.');
      } else {
        posts.slice(0, 8).forEach((post, i) => {
          console.log(`Post ${i + 1}:\n${post}\n-------------------\n`);
        });
      }
    }
  }

  await context.close();
})();
