import { AppError, redact, type JobRecord, type SearchProfileData } from '@jobpilot/contracts';

export function searchUrl(profile: SearchProfileData) {
  const url = new URL(profile.searchUrl || 'https://www.zhipin.com/web/geek/jobs');
  if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || !/^\/web\/geek\/jobs?$/.test(url.pathname) || url.username || url.password) throw new AppError('INVALID_SEARCH_URL', '筛选链接必须是 BOSS 官网的职位搜索页。');
  const allowed = new Set(['query', 'city', 'experience', 'degree', 'salary', 'industry', 'position', 'stage', 'scale', 'jobType']);
  for (const key of [...url.searchParams.keys()]) if (!allowed.has(key)) url.searchParams.delete(key);
  url.hash = ''; url.searchParams.set('query', profile.keyword);
  return url.toString();
}

export {extractSearchDom, extractDetailDom} from './extractors.js';
import {extractSearchDom} from './extractors.js';
export function normalizeCard(raw: ReturnType<typeof extractSearchDom>[number]): JobRecord {
  let url: URL;
  try { url = new URL(raw.url); } catch { throw new AppError('ADAPTER_CHANGED', '职位链接无效，已停止读取。'); }
  const match = url.pathname.match(/^\/job_detail\/([a-zA-Z0-9_-]+)\.html$/);
  if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || !match || !raw.title || !raw.company) throw new AppError('ADAPTER_CHANGED', '职位卡片缺少必要字段，已停止读取。');
  const jobId = match[1]; url.search = ''; url.hash = '';
  const title = redact(raw.title).slice(0, 200), company = redact(raw.company).slice(0, 200);
  const salary = redact(raw.salary).slice(0, 80), city = redact(raw.city).slice(0, 100), tags = raw.tags.map(tag => redact(tag).slice(0, 100));
  return {id: `boss:${jobId}`, platformJobId: jobId, recruiterId: raw.recruiterId, source: 'boss', title, company, salary, city, experience: tags.find(t => /经验|[0-9].*年/.test(t)) ?? '', education: tags.find(t => /本科|大专|硕士|博士|学历/.test(t)) ?? '', url: url.toString(), jdText: '', jdHash: '', fetchedAt: new Date().toISOString(), snapshot: JSON.stringify({adapterVersion: 'boss-dom-m1', card: {title, company, salary, city, url: url.toString()}}), alreadyContacted: raw.alreadyContacted};
}
