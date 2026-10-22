import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { BrowserProbe, detectLoginState, extractDetailDom, extractSearchDom, normalizeCard, searchUrl } from '@jobpilot/boss-adapter';
import { bossFixtureHtml, modernBossFixtureHtml } from './fixtures.js';
import { ownsChromeCommand } from '../packages/boss-adapter/src/native.js';
import { readFile } from 'node:fs/promises';

test('BOSS DOM fixtures extract twenty cards and JD, identify login/challenges, and fail on changed structure', async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
  try {
    const page=await browser.newPage();
    await page.route('https://www.zhipin.com/**',route=>route.fulfill({contentType:'text/html',body:bossFixtureHtml()}));
    await page.goto('https://www.zhipin.com/web/geek/jobs');
    const cards=await page.evaluate(extractSearchDom);
    assert.equal(cards.length,20);assert.equal(new Set(cards.map(card=>normalizeCard(card).id)).size,20);
    assert.equal(normalizeCard(cards[0]).recruiterId,'recruiter-1');
    // An avatar wrapper is also rendered for visitors and cannot prove login.
    assert.equal((await detectLoginState(page)).state,'UNKNOWN');
    await page.setContent('<div class="nav-figure"><span class="label-text">匿名测试用户</span></div>');
    assert.equal((await detectLoginState(page)).state,'LOGGED_IN');
    await page.setContent('<div class="nav-figure">头像占位</div><button class="login-register-btn">登录/注册</button>');
    assert.equal((await detectLoginState(page)).state,'LOGIN_REQUIRED');
    await page.setContent('<div>安全验证，请完成验证</div><div class="nav-logout">退出登录</div>');
    assert.equal((await detectLoginState(page)).state,'CHALLENGE');
    await page.setContent('<div class="job-banner"><div class="name"><h1>匿名 iOS 工程师</h1></div></div><div class="job-sec-text">负责 Swift 客户端和 BLE 通信。</div>');
    assert((await page.evaluate(extractDetailDom)).jdText.includes('BLE'));
    assert.throws(()=>normalizeCard({...cards[0],title:''}),{code:'ADAPTER_CHANGED'});
    assert.throws(()=>normalizeCard({...cards[0],url:'https://example.com/job_detail/test.html'}),{code:'ADAPTER_CHANGED'});
    await page.goto('about:blank');
    const blank=await detectLoginState(page,true);assert.equal(blank.state,'UNKNOWN');assert(blank.message.includes('空白'));
  } finally {await browser.close();}
});
test('native Chrome ownership rejects daily profiles, path prefixes and other executables',()=>{
 const path='/tmp/JobPilot/chrome-profile',chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 assert(ownsChromeCommand(`${chrome} --user-data-dir=${path} --no-first-run`,path));
 assert(ownsChromeCommand(`${chrome} --user-data-dir=${path}`,path));
 assert(!ownsChromeCommand(`${chrome} --user-data-dir=${path}-other --no-first-run`,path));
 assert(!ownsChromeCommand(`${chrome} --user-data-dir=/tmp/daily-profile`,path));
 assert(!ownsChromeCommand(`/tmp/unknown --user-data-dir=${path}`,path));
});
test('native snapshot reports only authenticated BOSS job DOM and stops on challenges',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
 try{
  const page=await browser.newPage();await page.route('https://www.zhipin.com/**',route=>route.fulfill({contentType:'text/html',body:bossFixtureHtml()}));await page.goto('https://www.zhipin.com/web/geek/jobs');
  const script=await readFile('dist/worker/browser-snapshot.js','utf8');
  assert(Buffer.byteLength(script)<256*1024,'native snapshot must fit the shipped helper resource limit');
  let result=JSON.parse(await page.evaluate(script));assert.equal(result.state,'UNKNOWN');assert.equal(result.cards,undefined);
  await page.locator('.nav-figure').evaluate(element=>element.innerHTML='<span class="label-text">匿名用户</span>');
  result=JSON.parse(await page.evaluate(script));assert.equal(result.state,'LOGGED_IN');assert.equal(result.cards.length,20);assert.equal(JSON.stringify(result).includes('匿名用户'),false);
  await page.setContent(modernBossFixtureHtml());result=JSON.parse(await page.evaluate(script));assert.equal(result.cards.length,20);assert.equal(normalizeCard(result.cards[0]).company,'匿名现代公司 1');assert.equal(normalizeCard(result.cards[0]).city,'深圳·南山');
  await page.setContent('<div>安全验证，请完成验证</div><span class="nav-logout">退出登录</span>');result=JSON.parse(await page.evaluate(script));assert.equal(result.state,'CHALLENGE');assert.equal(result.cards,undefined);
 }finally{await browser.close();}
});
test('search URLs preserve explicit filters and discard unrelated token parameters',()=>{
  const url=new URL(searchUrl({id:'primary',name:'匿名方案',keyword:'Swift',maxJobs:20,searchUrl:'https://www.zhipin.com/web/geek/jobs?city=101280600&token=fixture-secret'}));
  assert.equal(url.searchParams.get('city'),'101280600');assert.equal(url.searchParams.get('query'),'Swift');assert.equal(url.searchParams.has('token'),false);
  assert.throws(()=>searchUrl({id:'primary',name:'test',keyword:'Swift',maxJobs:20,searchUrl:'http://www.zhipin.com/web/geek/jobs'}),{code:'INVALID_SEARCH_URL'});
});
test('dedicated Chrome profile retains anonymous session state after a clean browser restart',async()=>{
  const directory=await mkdtemp('/tmp/jp-session-');
  const profile=new BrowserProbe(directory).profilePath;
  let context:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined;
  const launch=()=>chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,chromiumSandbox:true});
  const origin='https://anonymous-session.jobpilot.test';
  try{
    context=await launch();
    await context.route(`${origin}/**`,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Anonymous local fixture</title>'}));
    const first=await context.newPage();await first.goto(origin);
    await first.evaluate(()=>{document.cookie='fixture_session=anonymous-only; Max-Age=3600; Secure; SameSite=Lax';localStorage.setItem('fixture_state','anonymous-only');});
    await context.close();context=await launch();
    await context.route(`${origin}/**`,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Anonymous local fixture</title>'}));
    const restored=await context.newPage();await restored.goto(origin);
    assert.equal(await restored.evaluate(()=>localStorage.getItem('fixture_state')),'anonymous-only');
    assert.equal(await restored.evaluate(()=>document.cookie),'fixture_session=anonymous-only');
    // Neither fixture request reaches a real site, and no cookies are exported to SQLite.
  }finally{await context?.close();await rm(directory,{recursive:true,force:true});}
});
