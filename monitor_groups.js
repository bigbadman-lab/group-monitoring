const { chromium } = require('playwright');

const DEBUG = process.argv.includes('--debug');

// Patterns for post permalinks (match relative or absolute hrefs)
const PERMLINK_PATTERNS = [
  /\/groups\/\d+\/posts\/\d+/,
  /\/groups\/\d+\/permalink\/\d+/,
  /permalink\.php\?story_fbid=\d+/,
  /\/permalink\/\d+/,
  /\/photo\/\?fbid=\d+/,
  /photo\.php\?fbid=\d+/,
  /set=gm\.\d+/,
];

function hrefMatchesPermalink(href) {
  if (!href || typeof href !== 'string') return false;
  let pathAndQuery = href;
  try {
    if (href.startsWith('http')) pathAndQuery = new URL(href).pathname + new URL(href).search;
  } catch (_) {}
  return PERMLINK_PATTERNS.some(re => re.test(pathAndQuery));
}

const TARGETED_PERMLINK_SELECTOR = [
  'a[href*="/posts/"]',
  'a[href*="/permalink/"]',
  'a[href*="permalink.php?story_fbid="]',
  'a[href*="/photo/?fbid="]',
  'a[href*="photo.php?fbid="]',
  'a[href*="set=gm."]',
].join(', ');

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

    if (DEBUG) {
      console.log('Final URL:', page.url());
      console.log('Title:', page.title());
      const currentUrl = page.url();
      if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
        console.log('LOGIN/CHECKPOINT DETECTED');
        continue;
      }
      await page.waitForTimeout(1500);
      await page.waitForSelector('[role="feed"], [role="main"]', { timeout: 15000 }).catch(() => {});
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, 2500);
        await page.waitForTimeout(1200);
      }
      await page.waitForTimeout(1500);

      const targetedHrefs = await page.$$eval(TARGETED_PERMLINK_SELECTOR, links => links.map(a => a.getAttribute('href')));
      const fallbackHrefs = await page.$$eval('a[href]', links => links.map(a => a.getAttribute('href')));
      const combinedRaw = [...new Set([...targetedHrefs, ...fallbackHrefs.filter(h => hrefMatchesPermalink(h))])];
      const normalized = new Set();
      for (const href of combinedRaw) {
        if (!hrefMatchesPermalink(href)) continue;
        try {
          const absolute = new URL(href, baseUrl).toString();
          const withoutHash = absolute.split('#')[0];
          normalized.add(withoutHash);
        } catch (_) {}
      }
      const permalinks = [...normalized];
      console.log(`Found ${permalinks.length} post permalinks`);
      permalinks.slice(0, 15).forEach(url => console.log(url));
    } else {
      await page.waitForTimeout(1500);
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(1200);
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(1200);

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
