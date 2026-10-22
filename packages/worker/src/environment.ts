import {openSync,closeSync,readSync,writeFileSync,fsyncSync,renameSync,unlinkSync,realpathSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import {AppError,LlmConfig} from '@jobpilot/contracts';
import {validateEndpoint} from '@jobpilot/llm';
import {z} from 'zod';
const MAX_ENV=64*1024;
export const EnvironmentSave=z.object({path:z.string().min(1).max(4096).optional(),baseUrl:z.string().url().max(2048),model:z.string().trim().min(1).max(200),apiKey:z.string().max(4096).refine(s=>!/[\r\n\0]/.test(s)).optional(),clearKey:z.boolean().default(false),allowLan:z.boolean().default(false),timeoutMs:z.number().int().min(100).max(60000).default(60000)}).strict();
export function envPath(path:string){
  const absolute=resolve(path);
  if(!/^\.env(?:\.[\w-]+)?$/.test(basename(absolute)))throw new AppError('ENV_PATH_INVALID','请选择 .env 或 .env.local 等配置文件。');
  return absolute;
}
function readText(path:string,allowMissing=false){
  let fd:number;try{fd=openSync(path,'r');}catch(error){if(allowMissing&&(error as NodeJS.ErrnoException).code==='ENOENT')return '';throw new AppError('ENV_READ_FAILED','无法读取环境配置文件，请检查路径和权限。');}
  try{const buffer=Buffer.alloc(MAX_ENV+1);let length=0;while(length<buffer.length){const n=readSync(fd,buffer,length,buffer.length-length,null);if(!n)break;length+=n;}if(length>MAX_ENV)throw new AppError('ENV_TOO_LARGE','环境配置文件超过 64 KiB 上限。');return buffer.subarray(0,length).toString('utf8');}finally{closeSync(fd);}
}
function configuration(text:string){
  try{
    const values=parseEnv(text);
    return validateEndpoint(LlmConfig.parse({baseUrl:values.OPENAI_BASE_URL,model:values.OPENAI_MODEL,apiKey:values.OPENAI_API_KEY??'',timeoutMs:values.OPENAI_TIMEOUT_MS?Number(values.OPENAI_TIMEOUT_MS):60000,allowLan:values.OPENAI_ALLOW_LAN==='true'}));
  }catch(error){if(error instanceof AppError)throw error;throw new AppError('ENV_INVALID','配置文件需要有效的 OPENAI_BASE_URL、OPENAI_MODEL；API Key 使用 OPENAI_API_KEY。');}
}
function encode(value:string){
  const quote=['"',"'",'`'].find(character=>!value.includes(character));
  if(!quote||/[\r\n\0]/.test(value))throw new AppError('ENV_ENCODING_ERROR','配置值包含不支持的控制字符或引号组合，请检查输入。');
  return quote+value+quote;
}
export function readEnvironment(path:string){const resolved=envPath(path),text=readText(resolved);return {path:realpathSync(resolved),configuration:configuration(text)};}
export function readEnvironmentValues(path:string,allowMissing=false){
  try{return parseEnv(readText(envPath(path),allowMissing));}catch(error){if(error instanceof AppError)throw error;throw new AppError('ENV_INVALID','环境配置格式无效，请先修正配置文件。');}
}
export function saveEnvironmentValues(path:string,updates:Record<string,string>){
  const target=envPath(path);let text=readText(target,true);let original:NodeJS.Dict<string>;
  try{original=parseEnv(text);}catch{throw new AppError('ENV_INVALID','现有配置格式无效，请先修正配置文件。');}
  const remaining=new Set(Object.keys(updates));
  text=text.split(/\r?\n/).map(line=>{const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=/);if(!match||!(match[1]in updates))return line;if(!remaining.delete(match[1]))return '';return `${match[1]}=${encode(updates[match[1]])}`;}).join('\n').replace(/\n*$/,'\n');
  for(const key of remaining)text+=`${key}=${encode(updates[key])}\n`;
  let decoded:NodeJS.Dict<string>;try{decoded=parseEnv(text);}catch{throw new AppError('ENV_ENCODING_ERROR','配置无法完整保存，原文件未修改。');}
  if(Object.entries({...original,...updates}).some(([key,value])=>decoded[key]!==value)||Object.keys(decoded).some(key=>!(key in original)&&!(key in updates)))throw new AppError('ENV_ENCODING_ERROR','配置无法完整保存，原文件未修改。');
  let actual=target;try{actual=realpathSync(target);}catch{}
  const temp=join(dirname(actual),`.jobpilot-env-${randomUUID()}.tmp`);
  try{writeFileSync(temp,text,{mode:0o600,flag:'wx'});const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,actual);}
  catch{try{unlinkSync(temp);}catch{}throw new AppError('ENV_WRITE_FAILED','无法保存环境配置，请检查目录权限。');}
  return actual;
}
export function saveEnvironment(path:string,input:z.infer<typeof EnvironmentSave>){
  const values=readEnvironmentValues(path,true);
  const apiKey=input.clearKey?'':input.apiKey||values.OPENAI_API_KEY||'';
  const config=validateEndpoint({baseUrl:input.baseUrl,model:input.model,apiKey,timeoutMs:input.timeoutMs,allowLan:input.allowLan});
  const updates:Record<string,string>={OPENAI_BASE_URL:config.baseUrl,OPENAI_MODEL:config.model,OPENAI_API_KEY:apiKey,OPENAI_TIMEOUT_MS:String(config.timeoutMs),OPENAI_ALLOW_LAN:String(config.allowLan)};
  const actual=saveEnvironmentValues(path,updates);
  return {path:actual,configuration:config};
}
