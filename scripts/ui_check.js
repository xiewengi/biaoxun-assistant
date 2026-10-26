// 本地 UI 冒烟：登录 → 逐页截图 → 收集控制台报错 / 失败请求
// 用法：PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers node scripts/ui_check.js [baseUrl]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8000';
const OUT = path.resolve(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const errors = [];
  const badResponses = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(OUT, '01-login.png') });

  await page.fill('#login-account', 'sheshujuan');
  await page.fill('#login-password', '123456');
  await page.click('#login-btn');
  await page.waitForSelector('[data-page="announcements"]', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '02-announcements.png'), fullPage: true });

  const pages = [
    ['reminders', '03-reminders'],
    ['team', '04-team'],
    ['schedule', '05-schedule'],
    ['sources', '06-sources'],
  ];
  for (const [key, name] of pages) {
    const el = page.locator(`[data-page="${key}"]`).first();
    if (await el.count()) {
      await el.click();
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
    } else {
      errors.push(`未找到侧边栏入口 data-page=${key}`);
    }
  }

  // 打开第一条公告详情
  const firstDetail = page.locator('[data-detail]').first();
  if (await firstDetail.count()) {
    await firstDetail.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '07-detail.png'), fullPage: true });
  }

  await browser.close();
  const result = { base: BASE, consoleErrors: errors, badResponses, screenshots: OUT };
  fs.writeFileSync(path.join(OUT, 'ui-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length || badResponses.length) process.exitCode = 2;
})();
