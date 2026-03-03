const fs = require('fs');
const { chromium } = require('playwright');

const DEBUG = process.argv.includes('--debug');
const DAEMON = process.argv.includes('--daemon');
const SEEN_PATH = './seen_posts.json';

let intervalMinutes = 5;
for (const arg of process.argv) {
  if (arg.startsWith('--interval=')) {
    const n = parseInt(arg.slice('--interval='.length), 10);
    if (!isNaN(n) && n > 0) intervalMinutes = n;
    break;
  }
}

function loadSeen() {
  try {
    const data = fs.readFileSync(SEEN_PATH, 'utf8');
    return JSON.parse(data);
  } catch (_) {
    return {};
  }
}

function saveSeen(seen) {
  const tempPath = SEEN_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(seen, null, 2), 'utf8');
  fs.renameSync(tempPath, SEEN_PATH);
}

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

const MAX_TEXT_LENGTH = 1500;
const NEW_EXCERPT_LENGTH = 200;

async function extractPostTextFromPostPage(page, postUrl) {
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const raw = await page.evaluate((maxLen) => {
      try {
        let text = '';
        const msgNodes = document.querySelectorAll('[data-ad-preview="message"]');
        if (msgNodes && msgNodes.length > 0) {
          const parts = [...msgNodes].map(n => (n.innerText || '').trim()).filter(t => t.length > 0);
          text = [...new Set(parts)].join(' ').trim();
        }
        if (!text) {
          const dirAuto = document.querySelectorAll('div[dir="auto"]');
          if (dirAuto && dirAuto.length > 0) {
            const parts = [...dirAuto].map(n => (n.innerText || '').trim()).filter(t => t.length >= 20);
            text = [...new Set(parts)].join(' ').trim();
          }
        }
        if (!text) text = (document.body && document.body.innerText) ? document.body.innerText.trim() : '';
        return text.replace(/\s+/g, ' ').trim().slice(0, maxLen);
      } catch (_) {
        return '';
      }
    }, MAX_TEXT_LENGTH);
    return (raw && typeof raw === 'string') ? raw : '';
  } catch (_) {
    return '';
  }
}

function parseGroupIdFromGroupUrl(groupUrl) {
  const m = String(groupUrl).match(/\/groups\/(\d+)/);
  return m ? m[1] : null;
}

function toStructuredItem(sourceUrl, groupUrl) {
  const u = sourceUrl.split('#')[0];
  const groupId = parseGroupIdFromGroupUrl(groupUrl);
  const item = { group_url: groupUrl, source_url: u, post_url: u, post_id: null, type: 'group_post' };

  const groupsPostsMatch = u.match(/\/groups\/(\d+)\/posts\/(\d+)/);
  if (groupsPostsMatch) {
    item.type = 'group_post';
    item.post_id = groupsPostsMatch[2];
    item.post_url = `https://www.facebook.com/groups/${groupsPostsMatch[1]}/posts/${item.post_id}/`;
    return item;
  }
  const setGmMatch = u.match(/set=gm\.(\d+)/);
  if (setGmMatch) {
    item.type = 'group_post';
    item.post_id = setGmMatch[1];
    item.post_url = groupId
      ? `https://www.facebook.com/groups/${groupId}/posts/${item.post_id}/`
      : u;
    return item;
  }
  const fbidMatch = u.match(/fbid=(\d+)/);
  if (fbidMatch) {
    item.type = 'photo';
    item.post_id = fbidMatch[1];
    item.post_url = `https://www.facebook.com/photo/?fbid=${item.post_id}`;
    return item;
  }
  const storyFbidMatch = u.match(/story_fbid=(\d+)/);
  if (storyFbidMatch) item.post_id = storyFbidMatch[1];
  else {
    const permalinkMatch = u.match(/\/permalink\/(\d+)/);
    if (permalinkMatch) item.post_id = permalinkMatch[1];
  }
  item.post_url = u;
  return item;
}

const groups = [
  'https://www.facebook.com/groups/989141844449592',
  'https://www.facebook.com/groups/1536046086634463'
];
const baseUrl = 'https://www.facebook.com';

async function runOnce(context) {
  const page = await context.newPage();
  const detailPage = await context.newPage();
  try {
    for (const groupUrl of groups) {
    console.log('\n==============================');
    console.log('Checking group:', groupUrl);
    console.log('==============================\n');

    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (DEBUG) {
      console.log('Final URL:', page.url());
      console.log('Title:', await page.title());
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
    } else {
      await page.waitForTimeout(1500);
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(1200);
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(1200);
    }

    const hrefsWithText = await page.$$eval(TARGETED_PERMLINK_SELECTOR, (links, maxLen) => {
      return links.map(a => {
        let text = '';
        try {
          const container = a.closest('[role="article"]') || a.closest('div[role="article"]') || a.closest('div');
          if (container) {
            let raw = '';
            const msgNodes = container.querySelectorAll('[data-ad-preview="message"]');
            if (msgNodes && msgNodes.length > 0) {
              const parts = [...msgNodes].map(n => (n.innerText || '').trim()).filter(t => t.length > 0);
              raw = [...new Set(parts)].join(' ');
            } else {
              const dirAuto = container.querySelectorAll('div[dir="auto"]');
              if (dirAuto && dirAuto.length > 0) {
                const parts = [...dirAuto].map(n => (n.innerText || '').trim()).filter(t => t.length >= 20);
                raw = parts.join(' ');
              }
            }
            if (!raw) raw = (container.innerText || '').trim();
            text = raw.replace(/\s+/g, ' ').trim().slice(0, maxLen);
          }
        } catch (_) {}
        return { href: a.getAttribute('href'), text };
      });
    }, MAX_TEXT_LENGTH);

    const targetedHrefs = hrefsWithText.map(x => x.href);
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
    const textMap = new Map();
    for (const { href, text } of hrefsWithText) {
      try {
        const key = new URL(href, baseUrl).toString().split('#')[0];
        if (!textMap.has(key) || (text && !textMap.get(key))) textMap.set(key, text || '');
      } catch (_) {}
    }
    const permalinks = [...normalized];
    let structured = permalinks.map(sourceUrl => toStructuredItem(sourceUrl, groupUrl));
    for (const item of structured) {
      item.text = (textMap.get(item.source_url) || textMap.get(item.post_url) || '').trim();
    }
    const byPostUrl = new Map();
    const order = [];
    for (const item of structured) {
      const key = item.post_url;
      if (!byPostUrl.has(key)) {
        byPostUrl.set(key, item);
        order.push(key);
      } else if (item.type === 'group_post' && byPostUrl.get(key).type === 'photo') {
        byPostUrl.set(key, item);
      }
    }
    structured = order.map(k => byPostUrl.get(k));

    if (DEBUG) {
      console.log(`Found ${permalinks.length} post permalinks`);
      console.log(`Found ${structured.length} structured items (deduped)`);
      structured.slice(0, 10).forEach(obj => console.log(JSON.stringify(obj, null, 2)));
    } else {
      const seen = loadSeen();
      let newCount = 0;
      for (const item of structured) {
        if (seen[item.post_url] != null) continue;
        item.text = await extractPostTextFromPostPage(detailPage, item.post_url);
        console.log('[NEW]', item.post_url);
        if (item.post_id) console.log('post_id:', item.post_id);
        console.log('type:', item.type);
        const excerpt = (item.text && item.text.length > 0) ? item.text.slice(0, NEW_EXCERPT_LENGTH) : '(none)';
        console.log('text excerpt:', excerpt);
        seen[item.post_url] = new Date().toISOString();
        newCount++;
      }
      saveSeen(seen);
      const seenTotal = Object.keys(seen).length;
      console.log(`Found ${structured.length} items, NEW: ${newCount}, Seen total: ${seenTotal}`);
    }
  }
  } finally {
    await page.close();
    await detailPage.close();
  }
}

(async () => {
  const context = await chromium.launchPersistentContext('./profile', {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  if (DAEMON) {
    console.log(`Daemon mode enabled. Interval: ${intervalMinutes} minutes`);
    while (true) {
      try {
        await runOnce(context);
      } catch (err) {
        console.error('Cycle error:', err);
      }
      await new Promise(r => setTimeout(r, intervalMinutes * 60 * 1000));
    }
  } else {
    await runOnce(context);
    await context.close();
  }
})();
