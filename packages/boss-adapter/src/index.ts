import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { AppError, redact, type JobRecord, type LoginState, type SearchProfileData } from '@jobpilot/contracts';

export { searchUrl, extractSearchDom, extractDetailDom, normalizeCard } from './dom.js';
export {normalizeJobText,decodeBossDigits} from './job-text.js';
import { searchUrl, extractSearchDom, extractDetailDom, normalizeCard } from './dom.js';
export { NativeChrome as BrowserProbe } from './native.js';

export async function detectLoginState(page: Page, hasBossHistory = false): Promise<LoginState> {
    const url = page.url().split('?')[0];
    const body = (await page.locator('body').innerText({timeout: 4000}).catch(() => '')).slice(0, 50000);
    const challenge = await page.locator('iframe[src*="captcha"], .geetest_panel, .verify-slider, #nc_1_wrapper').first().isVisible().catch(() => false);
    if (challenge || /安全验证|请完成验证|操作过于频繁|访问异常|账号.*受限/.test(body)) return {state: 'CHALLENGE', message: '页面需要人工安全验证，已暂停自动读取。', url};
    if (!/^https:\/\/www\.zhipin\.com\//.test(url)) return {state: 'UNKNOWN', message: hasBossHistory ? 'BOSS 页面已返回空白，尚未确认登录。已停止采集，请检查站点可用性。' : '尚未打开 BOSS 页面。', url};
    if (/\/web\/user\//.test(url) || await page.locator('.sign-wrap, .login-register-btn').first().isVisible().catch(() => false) || /扫码登录|登录\/注册|登录后查看更多/.test(body)) return {state: 'LOGIN_REQUIRED', message: '请在专用 Chrome 中手动登录。', url};
    const userLabel = await page.locator('.nav-figure .label-text, .user-nav .user-name, .header-user .user-name').first().innerText({timeout:1000}).catch(()=>'');
    const logout = await page.locator('.nav-logout').first().isVisible().catch(()=>false);
    if (page.url().split('?')[0] !== url) return {state:'UNKNOWN',message:'页面正在跳转，尚未确认登录。',url:page.url().split('?')[0]};
    if (logout || (userLabel.trim() && !/登录|注册/.test(userLabel))) return {state: 'LOGGED_IN', message: '页面显示已登录标识。', url};
    return {state: 'UNKNOWN', message: '未识别到可靠的登录标识，请检查页面或更新适配器。', url};
  }

export class PlaywrightProbe {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private navigation: string[] = [];
  readonly profilePath: string;
  constructor(dataDir: string) { this.profilePath = join(dataDir, 'chrome-profile'); }
  status() { return {open: Boolean(this.context), profilePath: this.profilePath}; }
  private serial<T>(action: () => Promise<T>): Promise<T> { const next = this.tail.then(action, action); this.tail = next.catch(() => {}); return next; }
  open() {
    return this.serial(async () => {
      if (this.context) return this.status();
      await mkdir(this.profilePath, {recursive: true, mode: 0o700}); await chmod(this.profilePath, 0o700);
      try {
        const context = await chromium.launchPersistentContext(this.profilePath, {channel: 'chrome', chromiumSandbox: true, headless: false, timeout: 30000, viewport: null, acceptDownloads: false});
        this.context = context; this.navigation = [];
        context.on('close', () => { if (this.context === context) { this.context = undefined; this.page = undefined; } });
        context.on('page', page => this.observe(page));
        // Use an owned page rather than a tab restored by Chrome at startup.
        // Keep at least one page alive throughout the handover.
        const startupPages = context.pages();
        this.page = await context.newPage();
        for (const page of startupPages) await page.close();
        await this.page.setContent('<!doctype html><meta charset="utf-8"><title>JobPilot · 专用浏览器</title><body style="font:18px system-ui;padding:60px"><h1>JobPilot 专用 Chrome</h1><p>此窗口使用独立 Profile。请从工作台打开 BOSS 并手动完成登录，登录态会保存在本机专用目录中。</p></body>');
        return this.status();
      } catch { await this.context?.close().catch(() => {}); this.context = undefined; throw new AppError('CHROME_UNAVAILABLE', '无法启动 Chrome；请确认已安装 Google Chrome，且专用 Profile 未被其它进程占用。'); }
    });
  }
  private observe(page: Page) {
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) { const url = frame.url().split('?')[0].split('#')[0]; this.navigation.push(url); this.navigation = this.navigation.slice(-10); } });
  }
  diagnostics() { return {navigation: [...this.navigation], pages: this.context?.pages().map(page => page.url().split('?')[0].split('#')[0]) ?? []}; }
  private activePage() {
    if (!this.context) throw new AppError('BROWSER_CLOSED', '请先打开专用 Chrome 并登录 BOSS。');
    const pages = this.context.pages().filter(page => !page.isClosed());
    const boss = pages.findLast(page => /^https:\/\/www\.zhipin\.com\//.test(page.url()));
    const page = boss ?? (this.page && !this.page.isClosed() ? this.page : pages[0]);
    if (!page) throw new AppError('BROWSER_CLOSED', '浏览器窗口已关闭。');
    this.page = page; return page;
  }
  private loginState(page: Page) { return detectLoginState(page, this.navigation.some(path=>path.includes('zhipin.com'))); }
  async openLogin() {
    await this.open();
    return this.serial(async () => {
      const page = this.activePage(); await page.bringToFront();
      await page.goto('https://www.zhipin.com/', {waitUntil: 'domcontentloaded', timeout: 30000});
      await page.bringToFront();
      return this.loginState(page);
    });
  }
  loginStatus(): Promise<LoginState> { return this.serial(async () => this.context ? this.loginState(this.activePage()) : {state: 'CLOSED', message: '专用 Chrome 未打开。', url: null}); }
  private async ensureLoggedIn(page: Page) {
    const state = await this.loginState(page);
    if (state.state !== 'LOGGED_IN') throw new AppError(state.state === 'CHALLENGE' ? 'BOSS_CHALLENGE' : state.state === 'LOGIN_REQUIRED' ? 'BOSS_LOGIN_REQUIRED' : 'ADAPTER_CHANGED', state.message);
  }
  search(profile: SearchProfileData, signal: AbortSignal, onJob: (job: JobRecord) => void) {
    return this.serial(async () => {
      const page = this.activePage(); signal.throwIfAborted();
      await page.goto(searchUrl(profile), {waitUntil: 'domcontentloaded', timeout: 30000});
      await page.locator('.job-card-wrapper, .job-card-box, .job-list-empty, .search-empty, .sign-wrap, .nav-figure').first().waitFor({timeout: 12000}).catch(() => {});
      await this.ensureLoggedIn(page); signal.throwIfAborted();
      const cards = await page.evaluate(extractSearchDom);
      if (!cards.length && !await page.locator('.job-list-empty, .search-empty').first().isVisible().catch(() => false)) throw new AppError('ADAPTER_CHANGED', '未识别到职位卡片或明确的空结果，停止采集。');
      const seen = new Set<string>();
      for (const raw of cards) {
        signal.throwIfAborted(); const job = normalizeCard(raw);
        if (seen.has(job.id)) continue;
        seen.add(job.id); onJob(job);
        if (seen.size >= profile.maxJobs) break;
      }
      return seen.size;
    });
  }
  readJob(job: JobRecord, signal?: AbortSignal) {
    return this.serial(async () => {
      const page = this.activePage();
      if (job.source !== 'boss' || !/^https:\/\/www\.zhipin\.com\/job_detail\/[a-zA-Z0-9_-]+\.html$/.test(job.url)) throw new AppError('INVALID_JOB_URL', '无效的 BOSS 职位链接。');
      signal?.throwIfAborted();
      await page.goto(job.url, {waitUntil: 'domcontentloaded', timeout: 30000});
      await page.locator('.job-sec-text, .job-description, .sign-wrap').first().waitFor({timeout: 12000}).catch(() => {});
      await this.ensureLoggedIn(page); signal?.throwIfAborted();
      const detail = await page.evaluate(extractDetailDom);
      if (!detail.jdText || !detail.title) throw new AppError('ADAPTER_CHANGED', '职位详情结构不符合预期，未保存不完整内容。');
      const jdText = redact(detail.jdText).slice(0, 30000);
      return {...job, jdText, jdHash: createHash('sha256').update(jdText).digest('hex'), recruiterId: detail.recruiterId ?? job.recruiterId, alreadyContacted: job.alreadyContacted || detail.alreadyContacted, fetchedAt: new Date().toISOString(), snapshot: JSON.stringify({adapterVersion: 'boss-dom-m1', title: redact(detail.title), jdText, url: job.url})};
    });
  }
  close() { return this.serial(async () => { await this.context?.close(); this.context = undefined; this.page = undefined; return this.status(); }); }
  async dispose() { await this.context?.close().catch(() => {}); await this.tail.catch(() => {}); this.context = undefined; this.page = undefined; }
}
