import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, chmod, readlink, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AppError, redact, type JobRecord, type LoginState, type SearchProfileData,type CommunicationInspection,type SendVerification,type ContactKind,type ConversationSnapshot } from '@jobpilot/contracts';
import { normalizeCard, searchUrl, normalizeJobText, decodeBossDigits, type extractSearchDom, type extractDetailDom } from './dom.js';

const execute = promisify(execFile), wait = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
export function ownsChromeCommand(command:string,profilePath:string){
  const value=command.trim(),argument=`--user-data-dir=${profilePath}`;
  return value.startsWith('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ')&&(value.includes(`${argument} `)||value.endsWith(argument));
}
type Snapshot = LoginState & {filters?:Record<string,string>;cards?:ReturnType<typeof extractSearchDom>;detail?:ReturnType<typeof extractDetailDom>;empty?:boolean;structure?:unknown;conversation?:ConversationSnapshot;communication?:{entryKind:ContactKind;jobIds:string[];recruiterIds:string[];composerReady:boolean;canOpenPreview:boolean;alreadyContacted:boolean;message:string}};
export class NativeChrome {
  readonly profilePath:string;
  private pid:number|undefined;
  private process:ChildProcess|undefined;
  private tail:Promise<unknown>=Promise.resolve();
  private disposed=false;
  private last:Snapshot|undefined;
  private navigation:string[]=[];
  constructor(dataDir:string){this.profilePath=join(dataDir,'chrome-profile');}
  private alive(){try{if(!this.pid)return false;process.kill(this.pid,0);return true;}catch{return false;}}
  status(){return {open:this.alive(),profilePath:this.profilePath};}
  private serial<T>(action:()=>Promise<T>):Promise<T>{const next=this.tail.then(()=>{if(this.disposed)throw new AppError('BROWSER_CLOSED','专用浏览器正在退出。');return action();});this.tail=next.catch(()=>{});return next;}
  private async profilePid(){
    try{
      const lock=await readlink(join(this.profilePath,'SingletonLock')),pid=Number(lock.match(/-(\d+)$/)?.[1]);
      if(!pid)return;
      const {stdout}=await execute('/bin/ps',['-ww','-p',String(pid),'-o','command='],{timeout:2000,maxBuffer:16000});
      if(ownsChromeCommand(stdout,this.profilePath))return pid;
    }catch{}
  }
  private async ensureOpen(){
    if(this.alive())return;
    await mkdir(this.profilePath,{recursive:true,mode:0o700});await chmod(this.profilePath,0o700);
    this.pid=await this.profilePid();if(this.pid)return;
    const browser='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    await access(browser).catch(()=>{throw new AppError('CHROME_UNAVAILABLE','请先安装 Google Chrome。');});
    // Launch Services gives Chrome its own macOS responsibility identity. Direct spawning
    // attributes Chrome's bundle maintenance/permissions to JobPilot and causes App Management alerts.
    this.process=spawn('/usr/bin/open',['-n','-a','/Applications/Google Chrome.app','--args',`--user-data-dir=${this.profilePath}`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
    this.process.on('error',()=>{});
    for(let i=0;i<100;i++){
      this.pid=await this.profilePid();
      if(this.pid&&(await this.command('ready')).ready){await wait(300);return;}
      if(this.disposed)break;await wait(100);
    }
    throw new AppError('CHROME_UNAVAILABLE','无法启动专用 Chrome，请检查目录是否被占用。');
  }
  open(){return this.serial(async()=>{await this.ensureOpen();return this.status();});}
  private async command(operation:'ready'|'read'|'navigate'|'scroll'|'greeting-prepare'|'greeting-submit'|'greeting-verify'|'greeting-contact-submit'|'greeting-contact-verify'|'greeting-chat-open',url?:string,payload?:unknown,signal?:AbortSignal):Promise<any>{
    if(!this.alive()||await this.profilePid()!==this.pid)throw new AppError('BROWSER_CLOSED','专用 Chrome 已关闭，请重新打开。');
    let helper=join(dirname(process.execPath),'jobpilot-browser');
    if(!await access(helper).then(()=>true,()=>false))helper=resolve('apps/desktop/src-tauri/binaries/jobpilot-browser-aarch64-apple-darwin');
    const resource=operation.startsWith('greeting-')?'browser-actions.js':'browser-snapshot.js';
    const snapshot=import.meta.url.endsWith('.ts')?resolve('dist/worker',resource):fileURLToPath(new URL('./'+resource,import.meta.url));
    let stdout='';
    try{const request=execute(helper,[String(this.pid),operation,snapshot,...(url?[url]:[])],{timeout:12000,maxBuffer:1024*1024,signal});request.child.stdin?.end(payload?JSON.stringify(payload):undefined);stdout=(await request).stdout;}
    catch(error){signal?.throwIfAborted();stdout=String((error as {stdout?:string}).stdout??'');if(!stdout)throw new AppError('BROWSER_NATIVE_UNAVAILABLE','浏览器原生接口不可用，请确认已安装完整 JobPilot。');}
    let response:any;try{response=JSON.parse(stdout);}catch{throw new AppError('BROWSER_READ_FAILED','浏览器读取结果无效。');}
    if(!response.ok)throw new AppError(response.code,response.message);
    return response.data;
  }
  private async read():Promise<Snapshot>{
    const snapshot=await this.command('read') as Snapshot;
    if(!['LOGGED_IN','LOGIN_REQUIRED','CHALLENGE','UNKNOWN'].includes(snapshot.state))throw new AppError('ADAPTER_CHANGED','页面状态不符合预期。');
    this.last=snapshot;
    if(snapshot.url&&snapshot.url!==this.navigation.at(-1)){this.navigation.push(snapshot.url);this.navigation=this.navigation.slice(-10);}
    return snapshot;
  }
  private state(snapshot:Snapshot):LoginState{return {state:snapshot.state,message:snapshot.message,url:snapshot.url};}
  private requireLogin(snapshot:Snapshot){if(snapshot.state!=='LOGGED_IN')throw new AppError(snapshot.state==='CHALLENGE'?'BOSS_CHALLENGE':snapshot.state==='LOGIN_REQUIRED'?'BOSS_LOGIN_REQUIRED':'ADAPTER_CHANGED',snapshot.message);}
  async openLogin(){return this.serial(async()=>{await this.ensureOpen();const current=await this.read();if(current.state==='LOGGED_IN')return this.state(current);await this.command('navigate','https://www.zhipin.com/web/geek/jobs');await wait(1200);return this.state(await this.read());});}
  loginStatus():Promise<LoginState>{return this.serial(async()=>{if(!this.alive())this.pid=await this.profilePid();return this.alive()?this.state(await this.read()):{state:'CLOSED',message:'专用 Chrome 未打开。',url:null};});}
  diagnostics(){return {backend:'chrome-apple-events',navigation:[...this.navigation],pages:this.last?.url?[this.last.url]:[],structure:this.last?.structure??null,communication:this.last?.communication?{entryKind:this.last.communication.entryKind,recruiterKnown:this.last.communication.recruiterIds.length===1,composerReady:this.last.communication.composerReady,message:this.last.communication.message}:null};}
  search(profile:SearchProfileData,signal:AbortSignal,onJob:(job:JobRecord)=>void){return this.serial(async()=>{
    this.requireLogin(await this.read());signal.throwIfAborted();const expected=new URL(searchUrl(profile));await this.command('navigate',expected.toString());
    let snapshot:Snapshot|undefined;
    for(let i=0;i<25;i++){signal.throwIfAborted();await wait(400);snapshot=await this.read();if(snapshot.state==='CHALLENGE'||snapshot.state==='LOGIN_REQUIRED')this.requireLogin(snapshot);if(snapshot.state==='LOGGED_IN'&&snapshot.url===expected.origin+expected.pathname&&[...expected.searchParams].every(([key,value])=>snapshot!.filters?.[key]===value)&&(snapshot.cards?.length||snapshot.empty))break;}
    if(!snapshot)throw new AppError('ADAPTER_CHANGED','未读取到搜索结果。');this.requireLogin(snapshot);
    if(snapshot.url!==expected.origin+expected.pathname||![...expected.searchParams].every(([key,value])=>snapshot!.filters?.[key]===value))throw new AppError('ADAPTER_CHANGED','搜索页尚未切换到保存的筛选条件，已停止读取。');
    const seen=new Set<string>();
    for(let attempt=0;attempt<4;attempt++){
      for(const raw of snapshot.cards??[]){signal.throwIfAborted();const job=normalizeCard(raw);if(seen.has(job.id))continue;seen.add(job.id);onJob(job);if(seen.size>=profile.maxJobs)return seen.size;}
      if(snapshot.empty||attempt===3)break;
      await this.command('scroll');await wait(900);signal.throwIfAborted();snapshot=await this.read();this.requireLogin(snapshot);
    }
    if(!seen.size&&!snapshot.empty)throw new AppError('ADAPTER_CHANGED','未识别到岗位卡片或明确的空结果，已停止读取。');return seen.size;
  });}
  readJob(job:JobRecord,signal?:AbortSignal){return this.serial(async()=>{
    if(job.source!=='boss'||!/^https:\/\/www\.zhipin\.com\/job_detail\/[a-zA-Z0-9_-]+\.html$/.test(job.url))throw new AppError('INVALID_JOB_URL','无效的 BOSS 岗位链接。');
    signal?.throwIfAborted();await this.command('navigate',job.url);let snapshot:Snapshot|undefined;
    for(let i=0;i<25;i++){signal?.throwIfAborted();await wait(400);snapshot=await this.read();if(snapshot.state==='CHALLENGE'||snapshot.state==='LOGIN_REQUIRED')this.requireLogin(snapshot);if(snapshot.state==='LOGGED_IN'&&snapshot.url===job.url&&snapshot.detail?.jdText&&snapshot.detail.title)break;}
    if(!snapshot)throw new AppError('ADAPTER_CHANGED','未读取到职位详情。');this.requireLogin(snapshot);
    const detail=snapshot.detail;if(snapshot.url!==job.url||!detail?.jdText||!detail.title)throw new AppError('ADAPTER_CHANGED','职位详情未切换到目标岗位，或页面结构不符合预期。');
    const jdText=redact(decodeBossDigits(detail.jdText)).slice(0,30000),fields=normalizeJobText(detail.title,detail.salary||job.salary);
    return {...job,...fields,jdText,jdHash:createHash('sha256').update(jdText).digest('hex'),recruiterId:snapshot.communication?.recruiterIds.length===1?snapshot.communication.recruiterIds[0]:detail.recruiterId??job.recruiterId,alreadyContacted:job.alreadyContacted||detail.alreadyContacted,fetchedAt:new Date().toISOString(),snapshot:JSON.stringify({adapterVersion:'boss-native-m4.4',...fields,recruiterName:redact(detail.recruiterName),jdText,url:job.url})};
  });}
  async inspectCommunication(job:JobRecord,signal:AbortSignal):Promise<{job:JobRecord;inspection:CommunicationInspection}>{
    const refreshed=await this.readJob(job,signal);
    return this.serial(async()=>{
      signal.throwIfAborted();const snapshot=await this.read();this.requireLogin(snapshot);const info=snapshot.communication;
      const recruiterId=info?.recruiterIds.length===1?info.recruiterIds[0]:null;
      const identityBound=!!info&&snapshot.url===job.url&&info.jobIds.length===1&&info.jobIds[0]===job.platformJobId&&!!recruiterId&&(!job.recruiterId||job.recruiterId===recruiterId);
      return {job:{...refreshed,recruiterId:identityBound?recruiterId:refreshed.recruiterId,alreadyContacted:refreshed.alreadyContacted||!!info?.alreadyContacted},inspection:{entryKind:info?.entryKind,jobId:job.id,recruiterId,identityBound,composerReady:!!info?.composerReady,canOpenPreview:!!info?.canOpenPreview,alreadyContacted:!!info?.alreadyContacted,message:identityBound?(info?.message??'未识别沟通结构。'):'当前页面无法可靠绑定目标岗位及招聘人，禁止发送。',url:snapshot.url??'',adapterVersion:'boss-native-m3'}};
    });
  }
  private sendPayload(job:JobRecord,content:string,intentId:string){if(!job.recruiterId)throw new AppError('RECRUITER_UNKNOWN','招聘人身份未知。');return {jobId:job.platformJobId,recruiterId:job.recruiterId,content,intentId,deadline:Date.now()+3000};}
  prepareGreeting(job:JobRecord,content:string,signal:AbortSignal,intentId:string,initialMessageId?:string){return this.serial(async()=>{for(let i=0;i<5;i++){signal.throwIfAborted();const result=await this.command('greeting-prepare',undefined,{...this.sendPayload(job,content,intentId),...(initialMessageId?{purpose:'first-contact-ai',initialMessageId}:{})},signal);if(result.prepared)return;await wait(300);}throw new AppError('ADAPTER_CHANGED','招呼语编辑框未准备完成，请人工检查。');});}
  submitGreeting(job:JobRecord,content:string,signal:AbortSignal,intentId:string,initialMessageId?:string){return this.serial(async()=>{signal.throwIfAborted();const result=await this.command('greeting-submit',undefined,{...this.sendPayload(job,content,intentId),...(initialMessageId?{purpose:'first-contact-ai',initialMessageId}:{})},signal);if(!result.submitted)throw new AppError('NEEDS_VERIFY','未能确认提交动作，请人工核验，禁止重试。');});}
  verifyGreeting(job:JobRecord,content:string,signal:AbortSignal):Promise<SendVerification>{return this.serial(async()=>{let result:SendVerification={state:'UNKNOWN',message:'未确认消息，请人工核验。'};for(let i=0;i<10;i++){signal.throwIfAborted();result=await this.command('greeting-verify',undefined,this.sendPayload(job,content,'read-only-verification'),signal);if(result.state==='CONFIRMED')return result;await wait(700);}return result;});}
  startContact(job:JobRecord,signal:AbortSignal,intentId:string){return this.serial(async()=>{signal.throwIfAborted();const result=await this.command('greeting-contact-submit',undefined,{...this.sendPayload(job,'',intentId),purpose:'default-then-ai'},signal);if(!result.submitted)throw new AppError('NEEDS_VERIFY','首次沟通提交结果未知。');});}
  verifyContact(job:JobRecord,signal:AbortSignal):Promise<SendVerification>{return this.serial(async()=>{let result:SendVerification={state:'UNKNOWN',message:'默认招呼未确认。'};for(let i=0;i<10;i++){signal.throwIfAborted();result=await this.command('greeting-contact-verify',undefined,this.sendPayload(job,'','verify-contact'),signal);if(result.state==='CONFIRMED')return result;await wait(700);}return result;});}
  openChats(){return this.serial(async()=>{await this.ensureOpen();await this.command('navigate','https://www.zhipin.com/web/geek/chat');await wait(1200);return this.state(await this.read());});}
  readConversation(signal:AbortSignal,target?:ConversationSnapshot):Promise<ConversationSnapshot>{return this.serial(async()=>{
    signal.throwIfAborted();let snapshot=await this.read();this.requireLogin(snapshot);
    if(target&&snapshot.conversation?.recruiterId!==target.recruiterId){
      // Stay in the connected chat page: full navigation would discard activeTab's
      // user-enabled bridge and silently break the next authorized conversation.
      await this.command('greeting-chat-open',undefined,{jobId:'',recruiterId:target.recruiterId,content:'',purpose:'reply',intentId:'read-only-open',deadline:Date.now()+3000},signal);
      for(let i=0;i<15;i++){signal.throwIfAborted();await wait(400);snapshot=await this.read();this.requireLogin(snapshot);if(snapshot.conversation?.recruiterId===target.recruiterId)break;}
    }
    if(!snapshot.conversation?.identityBound)throw new AppError('CHAT_IDENTITY_UNKNOWN','请在专用 Chrome 打开一个能可靠确认身份的聊天会话。');
    if(target&&snapshot.conversation.id!==target.id)throw new AppError('TARGET_MISMATCH','切换后会话身份不符。');return snapshot.conversation;
  });}
  private replyPayload(chat:ConversationSnapshot,content:string,intentId:string,inboundId:string){return {jobId:chat.jobId??'',recruiterId:chat.recruiterId,content,intentId,expectedInboundId:inboundId,purpose:'reply',deadline:Date.now()+3000};}
  prepareReply(chat:ConversationSnapshot,content:string,inboundId:string,signal:AbortSignal,intentId:string){return this.serial(async()=>{const result=await this.command('greeting-prepare',undefined,this.replyPayload(chat,content,intentId,inboundId),signal);if(!result.prepared)throw new AppError('ADAPTER_CHANGED','会话编辑器未准备好。');});}
  submitReply(chat:ConversationSnapshot,content:string,inboundId:string,signal:AbortSignal,intentId:string){return this.serial(async()=>{const result=await this.command('greeting-submit',undefined,this.replyPayload(chat,content,intentId,inboundId),signal);if(!result.submitted)throw new AppError('NEEDS_VERIFY','回复结果未知。');});}
  verifyReply(chat:ConversationSnapshot,content:string,signal:AbortSignal):Promise<SendVerification>{return this.serial(async()=>{const inboundId=chat.messages.filter(message=>message.direction!=='system').at(-1)?.id??'';for(let i=0;i<10;i++){const result=await this.command('greeting-verify',undefined,this.replyPayload(chat,content,'verify-reply',inboundId),signal);if(result.state==='CONFIRMED')return result;await wait(700);}return {state:'UNKNOWN',message:'回复未确认，不自动重发。'};});}
  private async stop(){
    const pid=this.pid??await this.profilePid();if(!pid)return;this.pid=pid;
    if(await this.profilePid()===pid){try{process.kill(pid,'SIGTERM');}catch{}for(let i=0;i<40&&this.alive();i++)await wait(100);}
    this.pid=undefined;this.process=undefined;
  }
  close(){return this.serial(async()=>{await this.stop();return this.status();});}
  async dispose(){this.disposed=true;await this.stop();await this.tail.catch(()=>{});await this.stop();}
}
