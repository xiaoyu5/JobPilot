import { zipSync, strToU8 } from 'fflate';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function docxFixture(directory: string) {
  const paragraphs = ['匿名测试简历', '专业技能', '熟悉 Swift 与 Objective-C 客户端开发。', '项目经历', '参与匿名智能设备项目的 BLE 通信模块与地图展示。', '教育背景', '计算机相关专业（匿名测试数据）。'];
  const content = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
  const data = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(content),
  });
  const path = join(directory, 'anonymous-resume.docx'); await writeFile(path, data); return path;
}
export async function pdfFixture(directory: string) {
  const content = 'BT /F1 12 Tf 72 740 Td (Anonymous resume: Swift and BLE integration.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index+1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const path = join(directory, 'anonymous-resume.pdf'); await writeFile(path, text); return path;
}
export function bossFixtureHtml() {
  return `<!doctype html><html><meta charset="utf-8"><div class="nav-figure">匿名账号标识</div><main class="job-list-box">${Array.from({length: 20}, (_,index) => `<div class="job-card-wrapper" data-boss-id="recruiter-${index+1}"><a class="job-card-left" href="https://www.zhipin.com/job_detail/fixture_${index+1}.html"><span class="job-name">匿名 iOS 岗位 ${index+1}</span></a><span class="company-name">匿名公司 ${index+1}</span><span class="salary">20-30K</span><span class="job-area">深圳</span><ul class="tag-list"><li>5-10年</li><li>本科</li></ul></div>`).join('')}</main></html>`;
}

export function modernBossFixtureHtml() {
  return `<!doctype html><meta charset="utf-8"><div class="nav-figure"><span class="label-text">匿名用户</span></div>${Array.from({length:20},(_,index)=>`<li class="job-card-wrap"><div class="job-card-box"><a href="https://www.zhipin.com/job_detail/modern_${index+1}.html"><span class="job-name">匿名 Swift 岗位 ${index+1}</span></a><span class="job-salary">20-30K</span><ul class="tag-list"><li>5-10年</li><li>本科</li></ul></div><div class="job-card-footer"><div class="boss-info"><span class="boss-name">匿名现代公司 ${index+1}</span></div><span class="company-location">深圳·南山</span></div></li>`).join('')}`;
}
