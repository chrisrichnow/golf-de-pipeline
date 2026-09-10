// Records a silent real-data UI preview; does not call the golf API.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

const imagesReady = page => page.waitForFunction(() => [...document.images]
  .filter(i => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })
  .every(i => i.complete && i.naturalWidth > 0), null, {timeout:10000});

(async () => {
  const output = path.resolve(__dirname, '../docs/portfolio');
  const scratch = path.resolve(__dirname, '../logs/demo-recording');
  await fs.mkdir(output, {recursive:true});
  await fs.mkdir(scratch, {recursive:true});
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const context = await browser.newContext({viewport:{width:1440,height:960},recordVideo:{dir:scratch,size:{width:1440,height:960}}});
    const page = await context.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://localhost:8050');
    await page.locator('#content:not([hidden])').waitFor();
    await imagesReady(page);
    await page.screenshot({path:path.join(output,'pga-analytics-overview.png')});
    await page.waitForTimeout(4000);
    await page.locator('[data-metric="wins"]').click();
    await page.waitForTimeout(3000);
    await page.locator('.bar-row').first().click();
    await imagesReady(page);
    await page.screenshot({path:path.join(output,'pga-analytics-player.png')});
    await page.waitForTimeout(4000);
    await page.locator('tbody [data-event]').first().click();
    await page.waitForTimeout(3000);
    await page.locator('#tournament').selectOption({label:'Zurich Classic of New Orleans · Team event'});
    await imagesReady(page);
    await page.screenshot({path:path.join(output,'pga-analytics-team.png')});
    await page.waitForTimeout(4000);
    await page.locator('nav [data-view="overview"]').click();
    await page.locator('#player-search').fill('Scheffler');
    await page.locator('#season-table').scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);
    await page.locator('#player-search').fill('');
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.waitForTimeout(2000);
    const video=page.video();
    await context.close();
    await video.saveAs(path.join(output,'dashboard-demo.webm'));
    if(errors.length)throw new Error(errors.join('\n'));
    console.log('Saved dashboard-demo.webm and three portfolio screenshots.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
