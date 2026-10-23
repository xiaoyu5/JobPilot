import {AppError} from '@jobpilot/contracts';

// BOSS's kanzhun digit fonts use these two published/observed codepoint blocks.
// Unknown private-use characters are never guessed as numbers.
export function decodeBossDigits(text:string){
  return text.replace(/[\uE031-\uE03A\uE8F0-\uE8F9]/g,character=>{const n=character.charCodeAt(0);return String(n>=0xe8f0?n-0xe8f0:n-0xe031);});
}
export function normalizeJobText(title:string,salary:string){
  let name=decodeBossDigits(title).trim(),amount=decodeBossDigits(salary).trim();
  // Some .job-title containers include their nested salary with no whitespace.
  if(amount&&name.endsWith(amount))name=name.slice(0,-amount.length).replace(/[\s|｜·]+$/g,'');
  if(!amount){const match=name.match(/(\d+(?:\.\d+)?(?:\s*[-–~至]\s*\d+(?:\.\d+)?)?\s*(?:[Kk千]|万元?\/月|元\/(?:天|时))(?:\s*[·•]\s*\d+薪)?)$/);if(match){amount=match[1];name=name.slice(0,-match[1].length).trim();}}
  if(!name||/[\uE000-\uF8FF]/.test(name))throw new AppError('ADAPTER_CHANGED','职位名称包含未识别的字体编码，请刷新页面核对。');
  return {title:name,salary:/[\uE000-\uF8FF]/.test(amount)?'薪资待核对':amount};
}
