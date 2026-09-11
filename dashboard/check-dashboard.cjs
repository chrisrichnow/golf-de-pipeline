// Browser integration check. Run from the project root with the server running:
// node dashboard/check-dashboard.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

(async () => {
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.request.get('http://localhost:8050/api/data');
    assert.equal(response.status(), 200);
    const data = await response.json();
    const summaries = data.summaries.filter(x => x.season_year === '2026' && x.org_id === '1');
    const players = data.players.filter(x => x.season_year === '2026' && x.org_id === '1');
    const teams = data.teams.filter(x => x.season_year === '2026' && x.org_id === '1');
    assert.equal((await page.request.get('http://localhost:8050/.env')).status(), 404);
    await page.goto('http://localhost:8050');
    await page.locator('#content:not([hidden])').waitFor();
    assert.equal(await page.locator('.metric-value').nth(1).textContent(), summaries.length.toLocaleString('en-US'));
    assert.equal(await page.locator('.metric-value').nth(2).textContent(), (players.length + teams.length).toLocaleString('en-US'));
    await page.locator('[data-metric="wins"]').click();
    assert.equal(await page.locator('.bar-value').first().textContent(), String(Math.max(...summaries.map(x=>x.wins))));
    await page.locator('#player-search').fill('Scheffler');
    assert.equal(await page.locator('#season-table tbody tr').count(), 1);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export').click();
    const download = await downloadPromise;
    const csv = await fs.readFile(await download.path(), 'utf8');
    assert.ok(csv.includes('Scottie Scheffler'));
    assert.equal(csv.trim().split('\r\n').length, 2);
    await page.locator('#season-table [data-player]').click();
    assert.equal(await page.locator('.profile-header h2').textContent(), 'Scottie Scheffler');
    assert.equal(await page.locator('tbody tr').count(), players.filter(x=>x.player_name==='Scottie Scheffler').length);
    await page.locator('#profile-search').fill('Rory');
    await page.locator('#player-picker').selectOption({label: 'Rory McIlroy'});
    assert.equal(await page.locator('.profile-header h2').textContent(), 'Rory McIlroy');
    await page.screenshot({path: path.join(__dirname, '../logs/dashboard-player.png'), fullPage: true});
    await page.locator('tbody [data-event]').first().click();
    assert.equal(await page.locator('#breadcrumb').textContent(), 'Tournaments');
    await page.locator('#tournament').selectOption({label: 'Zurich Classic of New Orleans · Team event'});
    assert.equal(await page.locator('#event-table tbody tr').count(), teams.length);
    assert.ok((await page.locator('#event-table').textContent()).includes('Scores belong to the team'));
    await page.locator('#event-search').fill('Fitzpatrick');
    assert.equal(await page.locator('#event-table tbody tr').count(), 1);
    await page.locator('#tournament').selectOption({label: 'Sony Open in Hawaii'});
    assert.equal(await page.locator('#event-table tbody tr').count(), players.filter(x=>x.tournament_name==='Sony Open in Hawaii').length);
    assert.ok((await page.locator('#event-table tbody tr').first().textContent()).includes('Chris Gotterup'));
    await page.locator('[data-sort="score_to_par"]').click();
    await page.locator('nav [data-view="overview"]').click();
    await page.locator('#player-search').fill('no-such-player-xyz');
    assert.ok((await page.locator('#season-table').textContent()).includes('No players match'));
    assert.equal(await page.locator('#export').isDisabled(), true);
    await page.locator('#player-search').fill('');
    await page.locator('[data-page="1"]').click();
    assert.ok((await page.locator('.pagination').textContent()).includes('2 /'));
    await page.locator('#refresh').click();
    await page.locator('#toast').filter({hasText:'Dashboard refreshed'}).waitFor();
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(__dirname, '../logs/dashboard-mobile.png'),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), 'Overview has horizontal page overflow');
    await page.locator('nav [data-view="players"]').click();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), 'Player view has horizontal page overflow');
    await page.locator('nav [data-view="tournaments"]').click();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), 'Tournament view has horizontal page overflow');
    await page.route('**/api/data', route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Test database offline'})}));
    await page.locator('#refresh').click();
    await page.locator('#error:not([hidden])').waitFor();
    assert.ok((await page.locator('#error').textContent()).includes('Showing the last successfully loaded data'));
    assert.equal(await page.locator('#content').isVisible(),true);
    assert.deepEqual(errors, []);
    console.log('PASS: database counts, protected routes, chart toggle, search, filtered CSV, player history, team separation, tournament switching, sorting, pagination, refresh, mobile layouts, and offline error state.');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
