// Evaluated inside the visible browser. All platform selectors stay in this package.
export function extractSearchDom() {
  const selector='.job-card-wrap, .job-card-wrapper, .job-card-box, .job-list-box .job-card-item';
  return [...document.querySelectorAll(selector)].filter(card=>!card.parentElement?.closest(selector)).map(card => {
    const link = card.querySelector<HTMLAnchorElement>('a[href*="/job_detail/"]');
    const title=(card.querySelector('.job-name')??card.querySelector('.job-title'))?.cloneNode(true) as Element|undefined;
    for(const child of title?.querySelectorAll('.salary,.job-salary')??[])child.remove();
    return {
      url: link?.href ?? '', title: title?.textContent?.trim() ?? '',
      company: card.querySelector('.company-name, .job-card-footer .boss-name')?.textContent?.trim() ?? '', salary: card.querySelector('.salary, .job-salary')?.textContent?.trim() ?? '',
      city: card.querySelector('.job-area, .job-area-wrapper, .company-location')?.textContent?.trim() ?? '',
      tags: [...card.querySelectorAll('.tag-list li, .job-info .tag-list span')].map(tag => tag.textContent?.trim() ?? ''),
      recruiterId: card.getAttribute('data-boss-id'), alreadyContacted: /已沟通|继续沟通/.test(card.textContent ?? ''),
    };
  });
}
export function extractDetailDom() {
  const root=document.querySelector('.job-banner')??document.querySelector('.job-detail');
  const description=document.querySelector<HTMLElement>('.job-sec-text, .job-detail .job-description');
  const recruiter=document.querySelector('.job-boss-info .name')?.cloneNode(true) as Element|undefined;
  for(const status of recruiter?.querySelectorAll('.boss-online-tag,.boss-active-time')??[])status.remove();
  const title=(document.querySelector('.job-banner .name h1')??document.querySelector('.job-detail .job-name')??document.querySelector('.job-detail .job-title'))?.cloneNode(true) as Element|undefined;
  for(const child of title?.querySelectorAll('.salary,.job-salary')??[])child.remove();
  return {
    title: title?.textContent?.trim() ?? '',
    salary:document.querySelector('.job-banner .salary,.job-banner .job-salary,.job-detail .salary,.job-detail .job-salary')?.textContent?.trim()??'',
    // Read the rendered description. textContent also includes hidden, changing page labels.
    // Do not strip brand words: they can be legitimate visible job requirements.
    jdText: description?.innerText.replace(/\r\n?/g,'\n').trim() ?? '',
    recruiterId: document.querySelector('[data-boss-id]')?.getAttribute('data-boss-id') ?? null,
    recruiterName: recruiter?.textContent?.trim().slice(0,80)??'',
    alreadyContacted: [...(root?.querySelectorAll('a,button')??[])].some(node => !node.closest('.more-job-section,.job-card-wrapper,.job-card-box')&&node.getClientRects().length>0&&/^(继续沟通|已沟通)$/.test(node.textContent?.trim() ?? '')),
  };
}
