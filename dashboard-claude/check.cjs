/* Browser check for the Clubhouse dashboard.
   Drives every view in Microsoft Edge, fails on any console/page error, and
   writes screenshots to dashboard-claude/shots/.

   Start the server first, then:  node dashboard-claude/check.cjs
*/

const path = require('path');
const fs = require('fs');

// Resolve a project-local install or an existing ancestor workspace install.
const { chromium } = require('playwright');

const BASE = process.env.CLUBHOUSE_URL || 'http://127.0.0.1:8052';
const SHOTS = path.join(__dirname, 'shots');

const VIEWS = ['overview', 'tournaments', 'players', 'scoring', 'pipeline'];

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  const step = async (name, fn) => {
    process.stdout.write(`  ${name} ... `);
    try { await fn(); console.log('ok'); }
    catch (err) { console.log('FAILED'); problems.push(`${name}: ${err.message}`); }
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });

  for (const view of VIEWS) {
    await step(view, async () => {
      await page.click(`.nav-btn[data-view="${view}"]`);
      await page.waitForFunction(() => !document.querySelector('#view .loading'), { timeout: 20000 });
      await page.waitForTimeout(600);
      const panels = await page.locator('#view .panel').count();
      if (panels === 0) throw new Error('no panels rendered');
      await page.screenshot({ path: path.join(SHOTS, `${view}.png`), fullPage: true });
    });
  }

  // Drill-in: a tournament leaderboard.
  await step('tournament drill-in', async () => {
    await page.click('.nav-btn[data-view="tournaments"]');
    await page.waitForTimeout(500);
    await page.click('#view tbody tr.clickable');
    await page.waitForTimeout(1200);
    const rows = await page.locator('#view .panel').last().locator('tbody tr').count();
    if (rows < 2) throw new Error('leaderboard did not populate');
    await page.screenshot({ path: path.join(SHOTS, 'tournament-detail.png'), fullPage: true });
  });

  // Drill-in: a player card.
  await step('player drill-in', async () => {
    await page.click('.nav-btn[data-view="players"]');
    await page.waitForTimeout(500);
    await page.click('#view tbody tr.clickable');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS, 'player-detail.png'), fullPage: true });
  });

  // Table-view twin on a chart.
  await step('chart table view', async () => {
    await page.click('.nav-btn[data-view="scoring"]');
    await page.waitForTimeout(900);
    const toggle = page.locator('.mini-btn').first();
    await toggle.click();
    await page.waitForTimeout(400);
    if ((await toggle.textContent()) !== 'Chart view') throw new Error('toggle did not switch');
    await toggle.click();
    await page.waitForTimeout(300);
  });

  // Search filter.
  await step('player search', async () => {
    await page.click('.nav-btn[data-view="players"]');
    await page.waitForTimeout(700);
    await page.fill('#view input[type="search"]', 'scheffler');
    await page.waitForTimeout(500);
    // Scope to the roster table; an open player card adds its own history table.
    const n = await page.locator('#view .panel').first().locator('tbody tr').count();
    if (n < 1 || n > 5) throw new Error(`search returned ${n} rows`);
  });

  // Light mode across every view.
  await step('light mode', async () => {
    await page.click('#theme-toggle');
    await page.waitForTimeout(300);
    for (const view of VIEWS) {
      await page.click(`.nav-btn[data-view="${view}"]`);
      await page.waitForFunction(() => !document.querySelector('#view .loading'), { timeout: 20000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SHOTS, `light-${view}.png`), fullPage: true });
    }
  });

  // Narrow viewport must not scroll the body sideways.
  await step('narrow viewport', async () => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.click('.nav-btn[data-view="overview"]');
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() =>
      document.body.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 2) throw new Error(`body scrolls horizontally by ${overflow}px`);
    await page.screenshot({ path: path.join(SHOTS, 'narrow.png'), fullPage: true });
  });

  await browser.close();

  console.log('');
  if (problems.length) {
    console.log(`${problems.length} problem(s):`);
    problems.forEach((p) => console.log('  - ' + p));
    process.exit(1);
  }
  console.log(`All checks passed. Screenshots in ${SHOTS}`);
})();
