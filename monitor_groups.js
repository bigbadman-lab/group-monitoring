const fs = require('fs');
const { chromium } = require('playwright');

const DEBUG = process.argv.includes('--debug');
const DAEMON = process.argv.includes('--daemon');
const SEEN_PATH = './seen_posts.json';

let testPostUrl = null;
for (const arg of process.argv) {
  if (arg.startsWith('--test-post=')) {
    testPostUrl = arg.slice('--test-post='.length).trim();
    break;
  }
}

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

const UI_CHROME_PHRASES = [
  'Unread Chats',
  'Number of unread notifications',
  'All reactions',
  'Like',
  'Comment',
  'Share',
];

async function extractPostTextFromPostPage(page, postUrl, options = {}) {
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[role="main"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const finalUrl = page.url();
    const groupPostMatch = String(postUrl).match(/\/posts\/(\d+)/);
    if (groupPostMatch) {
      const expectedPostId = groupPostMatch[1];
      if (!finalUrl.includes(expectedPostId)) {
        console.warn(`WARN: postUrl redirected, expected ${expectedPostId}, got ${finalUrl}`);
        if (options.debugStats) {
          return { text: '', finalUrl, dataAdPreviewCount: 0, dirAutoDivCount: 0, dirAutoSpanCount: 0, roleArticleCount: 0, bestArticleInnerTextLength: 0 };
        }
        return '';
      }
    }
    await page.evaluate(() => {
      const re = /see more|more/i;
      const buttons = document.querySelectorAll('button, [role="button"]');
      let clicked = 0;
      for (const el of buttons) {
        if (clicked >= 5) break;
        try {
          const text = (el.innerText || '').trim();
          if (re.test(text)) {
            el.click();
            clicked++;
          }
        } catch (_) {}
      }
    });
    await page.waitForTimeout(500);
    const returnStats = !!options.debugStats;
    const raw = await page.evaluate((maxLen, uiPhrases, returnStats) => {
      function clean(s) {
        return (s || '').replace(/\s+/g, ' ').trim();
      }
      function hasChrome(text) {
        const t = String(text);
        return uiPhrases.some(phrase => t.includes(phrase));
      }
      const uiBlockRe = /Like|Comment|Share|All reactions|Write a comment|See more|Send message|Photos|Most relevant|Top contributor|Edited/i;
      const pureCountRe = /^\d+$/;
      let dataAdPreviewCount = 0;
      let dirAutoDivCount = 0;
      let dirAutoSpanCount = 0;
      let roleArticleCount = 0;
      let bestArticleInnerTextLength = 0;
      try {
        const root = document.querySelector('[role="main"]') || document;
        const msgNodes = document.querySelectorAll('[data-ad-preview="message"]');
        dataAdPreviewCount = msgNodes.length;
        if (msgNodes && msgNodes.length > 0) {
          const candidates = [...msgNodes]
            .map(n => clean(n.innerText || ''))
            .filter(t => t.length >= 20);
          if (candidates.length > 0) {
            const best = candidates.reduce((a, b) => (a.length >= b.length ? a : b), '');
            const text = best.slice(0, maxLen);
            if (returnStats) {
              dirAutoDivCount = root.querySelectorAll('div[dir="auto"]').length;
              dirAutoSpanCount = root.querySelectorAll('span[dir="auto"]').length;
              const articles = Array.from(document.querySelectorAll('[role="article"]'));
              roleArticleCount = articles.length;
              if (articles.length > 0) {
                bestArticleInnerTextLength = Math.max(...articles.map(a => (a.innerText || '').length));
              }
              return { text, dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength };
            }
            return text;
          }
        }
        const dirAuto = root.querySelectorAll('div[dir="auto"], span[dir="auto"]');
        dirAutoDivCount = root.querySelectorAll('div[dir="auto"]').length;
        dirAutoSpanCount = root.querySelectorAll('span[dir="auto"]').length;
        let candidates = [...dirAuto]
          .map(n => clean(n.innerText || ''))
          .filter(t => t.length >= 30)
          .filter(t => !hasChrome(t));
        let deduped = [...new Set(candidates)];
        if (deduped.length > 0) {
          const best = deduped.reduce((a, b) => (a.length >= b.length ? a : b), '');
          const text = best.slice(0, maxLen);
          if (returnStats) {
            const articles = Array.from(document.querySelectorAll('[role="article"]'));
            roleArticleCount = articles.length;
            if (articles.length > 0) {
              bestArticleInnerTextLength = Math.max(...articles.map(a => (a.innerText || '').length));
            }
            return { text, dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength };
          }
          return text;
        }
        const articles = Array.from(document.querySelectorAll('[role="article"]'));
        roleArticleCount = articles.length;
        if (articles.length === 0) {
          if (returnStats) return { text: '', dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength };
          return '';
        }
        const bestArticle = articles.reduce((a, b) => {
          const al = (a.innerText || '').length;
          const bl = (b.innerText || '').length;
          return al >= bl ? a : b;
        });
        bestArticleInnerTextLength = (bestArticle.innerText || '').length;
        const blocks = bestArticle.querySelectorAll('div, span');
        candidates = [...blocks]
          .map(n => clean(n.innerText || ''))
          .filter(t => t.length >= 40)
          .filter(t => !uiBlockRe.test(t))
          .filter(t => !pureCountRe.test(t.trim()));
        deduped = [...new Set(candidates)];
        if (deduped.length === 0) {
          if (returnStats) return { text: '', dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength };
          return '';
        }
        const best = deduped.reduce((a, b) => (a.length >= b.length ? a : b), '');
        const text = best.slice(0, maxLen);
        if (returnStats) return { text, dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength };
        return text;
      } catch (_) {
        if (returnStats) return { text: '', dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength };
        return '';
      }
    }, MAX_TEXT_LENGTH, UI_CHROME_PHRASES, returnStats);
    const result = (raw && typeof raw === 'string') ? raw : (raw && raw.text !== undefined ? raw.text : '');
    const stats = raw && typeof raw === 'object' && raw.text !== undefined ? raw : null;
    if (result === '' && groupPostMatch) {
      console.warn(`WARN: empty post text for ${postUrl} final=${finalUrl}`);
    }
    if (options.debugStats) {
      return {
        text: result,
        finalUrl,
        dataAdPreviewCount: stats ? stats.dataAdPreviewCount : 0,
        dirAutoDivCount: stats ? stats.dirAutoDivCount : 0,
        dirAutoSpanCount: stats ? stats.dirAutoSpanCount : 0,
        roleArticleCount: stats ? stats.roleArticleCount : 0,
        bestArticleInnerTextLength: stats ? stats.bestArticleInnerTextLength : 0,
      };
    }
    return result;
  } catch (_) {
    if (options.debugStats) {
      return { text: '', finalUrl: page.url(), dataAdPreviewCount: 0, dirAutoDivCount: 0, dirAutoSpanCount: 0, roleArticleCount: 0, bestArticleInnerTextLength: 0 };
    }
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
  const item = { group_url: groupUrl, source_url: u, post_url: u, post_id: null, type: 'group_post', aliases: [] };

  const groupsPostsMatch = u.match(/\/groups\/(\d+)\/posts\/(\d+)/);
  if (groupsPostsMatch) {
    item.type = 'group_post';
    item.post_id = groupsPostsMatch[2];
    item.post_url = `https://www.facebook.com/groups/${groupsPostsMatch[1]}/posts/${item.post_id}/`;
    item.aliases = [];
    return item;
  }
  const setGmMatch = u.match(/set=gm\.(\d+)/);
  if (setGmMatch) {
    item.type = 'group_post';
    item.post_id = setGmMatch[1];
    item.post_url = groupId
      ? `https://www.facebook.com/groups/${groupId}/posts/${item.post_id}/`
      : u;
    const fbidInUrl = u.match(/fbid=(\d+)/);
    item.aliases = fbidInUrl
      ? [`https://www.facebook.com/photo/?fbid=${fbidInUrl[1]}`]
      : [];
    return item;
  }
  const fbidMatch = u.match(/fbid=(\d+)/);
  if (fbidMatch && !u.includes('set=gm.')) {
    item.type = 'photo';
    item.post_id = fbidMatch[1];
    item.post_url = `https://www.facebook.com/photo/?fbid=${item.post_id}`;
    item.aliases = [];
    return item;
  }
  const storyFbidMatch = u.match(/story_fbid=(\d+)/);
  if (storyFbidMatch) item.post_id = storyFbidMatch[1];
  else {
    const permalinkMatch = u.match(/\/permalink\/(\d+)/);
    if (permalinkMatch) item.post_id = permalinkMatch[1];
  }
  item.post_url = u;
  item.aliases = [];
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
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 2500);
        await page.waitForTimeout(1200);
      }
      await page.waitForTimeout(1500);
    } else {
      await page.waitForTimeout(1500);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 2500);
        await page.waitForTimeout(1200);
      }
      await page.waitForTimeout(1500);
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

    const byPostId = new Map();
    const orderIds = [];
    const noIdItems = [];
    for (const item of structured) {
      if (!item.post_id) {
        noIdItems.push(item);
        continue;
      }
      const pid = item.post_id;
      if (!byPostId.has(pid)) {
        byPostId.set(pid, item);
        orderIds.push(pid);
      } else if (item.type === 'group_post' && byPostId.get(pid).type === 'photo') {
        byPostId.set(pid, item);
      }
    }
    structured = [...orderIds.map(pid => byPostId.get(pid)), ...noIdItems];

    if (!DEBUG) {
      const nGroupPost = structured.filter(i => i.type === 'group_post').length;
      const nPhoto = structured.filter(i => i.type === 'photo').length;
      console.log(`Type breakdown: group_post=${nGroupPost}, photo=${nPhoto}`);
    }

    if (DEBUG) {
      console.log(`Found ${permalinks.length} post permalinks`);
      console.log(`Found ${structured.length} structured items (deduped)`);
      structured.slice(0, 10).forEach(obj => console.log(JSON.stringify(obj, null, 2)));
    } else {
      const seen = loadSeen();
      let newCount = 0;
      for (const item of structured) {
        if (seen[item.post_url] != null) continue;
        const alreadySeenViaAlias = (item.aliases || []).some(alias => seen[alias] != null);
        if (alreadySeenViaAlias) continue;
        if (item.type === 'group_post') {
          item.text = await extractPostTextFromPostPage(detailPage, item.post_url);
        } else {
          item.text = '';
        }
        console.log('[NEW]', item.post_url);
        if (item.post_id) console.log('post_id:', item.post_id);
        console.log('type:', item.type);
        if (item.text && item.text.length > 0) {
          console.log('text excerpt:', item.text.slice(0, NEW_EXCERPT_LENGTH));
        } else {
          console.log('text: (none)');
        }
        const timestamp = new Date().toISOString();
        seen[item.post_url] = timestamp;
        for (const alias of (item.aliases || [])) {
          seen[alias] = timestamp;
        }
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

  if (testPostUrl) {
    const page = await context.newPage();
    const out = await extractPostTextFromPostPage(page, testPostUrl, { debugStats: true });
    await page.close();
    await context.close();
    console.log('Test URL:', testPostUrl);
    console.log('Final URL:', out.finalUrl);
    console.log('data-ad-preview count:', out.dataAdPreviewCount);
    console.log('dir=auto div count:', out.dirAutoDivCount);
    console.log('dir=auto span count:', out.dirAutoSpanCount);
    console.log('role=article count:', out.roleArticleCount);
    console.log('best article innerText length:', out.bestArticleInnerTextLength);
    console.log('Extracted text length:', (out.text || '').length);
    const preview = (out.text && out.text.length > 0) ? out.text.slice(0, 500) : '(none)';
    console.log('Extracted text preview:', preview);
    process.exit(0);
  }

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
