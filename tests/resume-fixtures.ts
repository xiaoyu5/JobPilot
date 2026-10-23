import {readFile,writeFile} from 'node:fs/promises';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {docxFixture} from './fixtures.js';

export async function structuredResumeFixture(dir:string){
  const path=await docxFixture(dir),zip=unzipSync(await readFile(path));
  const rows=[['Title','匿名开发者'],['Subtitle','资深 iOS 开发工程师 | 智能硬件'],['','13800138000 | anonymous@example.com | GitHub：github.com/anonymous'],['','本科 | 计算机科学与技术 | 10 年 iOS 开发经验 | 求职意向：iOS 开发'],['Heading1','个人优势'],['','能够独立完成 App 开发并发布上线。'],['Heading1','专业技能'],['','Swift 和 Objective-C 客户端开发。'],['Heading1','工作经历'],['','2020.01 - 2025.01 匿名设备公司 iOS 开发工程师'],['Heading1','项目经历'],['Heading2','匿名地图项目'],['','匿名设备公司 | Swift、UIKit、厂商 SDK'],['','仅集成 P2P SDK，未独立实现协议栈或内核。'],['','设计 Render 与 Overlay，分离绘制和交互。'],['Heading1','开源项目'],['Heading2','匿名桌面工具'],['','github.com/anonymous/tool | Tauri、TypeScript'],['','通过 Worker 解析文件并保留人工审核。'],['','敏感数据不出本机。']];
  zip['word/document.xml']=strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${rows.map(([style,text])=>`<w:p>${style?`<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`:''}<w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  zip['word/styles.xml']=strToU8(`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${['Title','Subtitle','Heading1','Heading2'].map(name=>`<w:style w:type="paragraph" w:styleId="${name}"><w:name w:val="${name.replace('Heading','heading ')}"/></w:style>`).join('')}</w:styles>`);
  await writeFile(path,zipSync(zip));return path;
}
