import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { getDocumentProxy, extractText } from 'unpdf';
import { unzipSync } from 'fflate';
import { AppError, redact, type FactCategoryName, type PendingFact } from '@jobpilot/contracts';

export type ParsedResume = {file: string; hash: string; facts: PendingFact[]; warnings: string[]};
// The serverless PDF.js build cannot fetch file:// assets. Read only shipped assets.
class LocalPdfAssets {
  async fetch({kind, filename}: {kind: string; filename: string}) {
    const directories: Record<string,string> = {cMapUrl:'cmaps',standardFontDataUrl:'standard_fonts',wasmUrl:'wasm'};
    if (!directories[kind] || !/^[A-Za-z0-9_.-]+$/.test(filename) || filename === '.' || filename === '..') throw new Error('Invalid PDF asset');
    const root = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
    return new Uint8Array(await readFile(join(root,directories[kind],filename)));
  }
}
export async function parseResumeFile(path: string): Promise<ParsedResume> {
  const extension = extname(path).toLowerCase();
  if (!isAbsolute(path) || !['.docx', '.pdf'].includes(extension)) throw new AppError('INVALID_RESUME', '请选择本机的 DOCX 或 PDF 简历。');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > 8 * 1024 * 1024 || info.size === 0) throw new AppError('INVALID_RESUME', '简历必须为 1 byte–8 MiB 的普通文件。');
  const buffer = await readFile(path);
  const file = basename(path);
  const hash = createHash('sha256').update(buffer).digest('hex');
  const pages: string[] = [];
  const warnings: string[] = [];
  try {
    if (extension === '.docx') {
      let expanded = 0;
      // Check declared sizes before Mammoth decompresses XML; no external relationships are followed.
      unzipSync(buffer, {filter(entry) {
        expanded += entry.originalSize;
        if (expanded > 24 * 1024 * 1024) throw new AppError('RESUME_TOO_COMPLEX', 'DOCX 解压内容过大。');
        return false;
      }});
      const result = await mammoth.extractRawText({buffer});
      pages.push(result.value);
      if (result.messages.length) warnings.push('DOCX 包含未能完整识别的格式，请对照原稿审核提取结果。');
    } else {
      const document = await getDocumentProxy(new Uint8Array(buffer), {maxImageSize: 16_777_216, useSystemFonts: false, useWorkerFetch: false, BinaryDataFactory: LocalPdfAssets});
      try {
        if (document.numPages > 30) throw new AppError('RESUME_TOO_COMPLEX', 'PDF 超过 30 页，请选择简历文件。');
        const result = await extractText(document, {mergePages: false});
        pages.push(...result.text);
      } finally { await document.loadingTask.destroy(); }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('PARSE_FAILED', '无法解析该简历。请确认文件未加密、未损坏，并包含可复制的文字。');
  }
  if (pages.join('').length > 100000) throw new AppError('RESUME_TOO_COMPLEX', '提取文本过长，请精简后导入。');
  const facts: PendingFact[] = [];
  let category: FactCategoryName = 'other';
  pages.forEach((page, pageIndex) => {
    const paragraphs = page.split(/\n+/).map(line => line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()).filter(Boolean);
    paragraphs.forEach((paragraph, index) => {
      if (/^(专业技能|技术栈|技能|skills?)[:：]?$/i.test(paragraph)) { category = 'skill'; return; }
      if (/^(工作经历|工作经验|职业经历|experience)[:：]?$/i.test(paragraph)) { category = 'experience'; return; }
      if (/^(项目经历|项目经验|projects?)[:：]?$/i.test(paragraph)) { category = 'project'; return; }
      if (/^(教育经历|教育背景|学历|education)[:：]?$/i.test(paragraph)) { category = 'education'; return; }
      if (paragraph.length < 5 || /^(电话|手机|邮箱|email|联系方式|姓名)[:：]/i.test(paragraph)) return;
      const text = redact(paragraph);
      if (/^(\[PHONE\]|\[EMAIL\])(?:[\s|/·]*\[(?:PHONE|EMAIL)\])*$/.test(text)) return;
      for (let offset = 0; offset < text.length; offset += 1500) {
        const chunk = text.slice(offset, offset + 1500);
        facts.push({text: chunk, category, source: {file, kind: extension === '.pdf' ? 'pdf' : 'docx', ...(extension === '.pdf' ? {page: pageIndex + 1} : {}), paragraph: index + 1, quote: chunk}});
      }
    });
  });
  if (!facts.length) throw new AppError('NO_TEXT', '没有提取到可审核文字。扫描版 PDF 需要先转换为文字，或使用 DOCX。');
  if (facts.length > 300) throw new AppError('RESUME_TOO_COMPLEX', '提取条目超过 300 条，请精简简历。');
  warnings.push('以上条目是原稿文本提取结果，逐条确认后才能进入已批准事实库。');
  return {file, hash, facts, warnings};
}
