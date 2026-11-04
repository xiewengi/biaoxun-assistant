// 验证「子路径部署」：逐页截图 + 记录所有 /biaoxun/api 请求状态
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8032/biaoxun/';
const OUT = path.resolve(__dirname, '..', 'screenshots', 'subpath');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const errors = [];
  const apiCalls = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('response', (r) => {
    const url = r.url();
    if (url.includes('/api/')) apiCalls.push({ status: r.status(), url });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(OUT, '01-login.png') });
  await page.fill('#login-account', 'sheshujuan');
  await page.fill('#login-password', '123456');
  await page.click('#login-btn');
  await page.waitForSelector('[data-page="announcements"]', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '02-announcements.png'), fullPage: true });

  for (const [key, name] of [['reminders', '03-reminders'], ['team', '04-team'],
    ['schedule', '05-schedule'], ['sources', '06-sources']]) {
    await page.locator(`[data-page="${key}"]`).first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
  }

  await page.locator('[data-page="announcements"]').first().click();
  await page.waitForTimeout(500);
  await page.locator('[data-detail]').first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '07-detail.png'), fullPage: true });

  const result = {
    base: BASE,
    consoleErrors: errors,
    apiCalls,
    nonSubpathApi: apiCalls.filter((c) => !c.url.includes('/biaoxun/api/')),
    failing: apiCalls.filter((c) => c.status >= 400),
    screenshots: OUT,
  };
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length || result.failing.length || result.nonSubpathApi.length) process.exitCode = 2;
  await browser.close();
})();
