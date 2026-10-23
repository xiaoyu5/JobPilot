import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { getDocumentProxy, extractText } from 'unpdf';
import { unzipSync } from 'fflate';
import { AppError, type PendingFact } from '@jobpilot/contracts';
import {docxBlocks,extractFacts,type ResumeBlock} from './blocks.js';

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
  let structured:ResumeBlock[][]|undefined;
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
      const result = await mammoth.convertToHtml({buffer},{styleMap:["p[style-name='Title'] => p.resume-title:fresh","p[style-name='Subtitle'] => p.resume-subtitle:fresh"],convertImage:mammoth.images.imgElement(async()=>({src:''}))});
      structured=[docxBlocks(result.value)];pages.push(structured[0].map(block=>block.text).join('\n'));
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
  const result=extractFacts(structured??pages.map(page=>page.split(/\n+/).map(text=>({text}))),file,extension==='.pdf'?'pdf':'docx'),facts=result.facts;
  warnings.push(...result.warnings);
  if (!facts.length) throw new AppError('NO_TEXT', '没有提取到可审核文字。扫描版 PDF 需要先转换为文字，或使用 DOCX。');
  if (facts.length > 300) throw new AppError('RESUME_TOO_COMPLEX', '提取条目超过 300 条，请精简简历。');
  warnings.push('以上条目是原稿文本提取结果，逐条确认后才能进入已批准事实库。');
  return {file, hash, facts, warnings};
}
