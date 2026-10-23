import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chmod,copyFile,lstat,mkdir,mkdtemp,open,readFile,readdir,readlink,rename,rm,stat,writeFile} from 'node:fs/promises';
import {join,basename,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {z} from 'zod';
import {AppError,type CleanupPlan,type DataStatus,type ExportResult,type RestorePlan,type WorkerStatus} from '@jobpilot/contracts';
import {Store,SCHEMA_VERSION} from '@jobpilot/store';
import {recruiterHistory} from '../../core/src/recruiter-identity.js';

const MAX_BACKUP=128*1024*1024;
const Pending=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('restore'),id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({kind:z.literal('reset'),id:z.string().uuid(),environmentFile:z.string().regex(/^\.env(?:\.[\w-]+)?$/).optional()}).strict(),
]);
const digest=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
async function privateDirectory(path:string){
  await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);
  if(info.isSymbolicLink()||!info.isDirectory())throw new AppError('DATA_PATH_INVALID','数据目录不能是符号链接。');await chmod(path,0o700);
}
async function syncFile(path:string){const file=await open(path,'r');try{await file.sync();}finally{await file.close();}}
async function atomicJson(path:string,data:unknown){
  const temporary=path+'.'+randomUUID();
  try{await writeFile(temporary,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});await syncFile(temporary);await rename(temporary,path);}finally{await rm(temporary,{force:true});}
}
async function regularBytes(path:string){
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_BACKUP)throw new AppError('BACKUP_INVALID','请选择不超过 128 MiB 的 JobPilot SQLite 备份。');
  const file=await open(path,'r');try{const current=await file.stat();if(current.dev!==info.dev||current.ino!==info.ino||current.size>MAX_BACKUP)throw new AppError('BACKUP_CHANGED','备份文件已变化。');const bytes=await file.readFile();if(bytes.length>MAX_BACKUP)throw new AppError('BACKUP_INVALID','备份超过大小上限。');return bytes;}finally{await file.close();}
}
function schemaHash(db:DatabaseSync){return digest(JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()));}
let expectedSchema:Promise<string>|undefined;
function canonicalSchema(){return expectedSchema??=(async()=>{const directory=await mkdtemp(join(tmpdir(),'jp-schema-')),store=new Store(directory);try{return schemaHash(store.db);}finally{store.close();await rm(directory,{recursive:true,force:true});}})();}
async function inspectBackup(path:string){
  const expected=await canonicalSchema(),db=new DatabaseSync(path,{readOnly:true,allowExtension:false});
  try{
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    if(db.prepare('PRAGMA user_version').get()!.user_version!==SCHEMA_VERSION||schemaHash(db)!==expected)throw new AppError('BACKUP_SCHEMA_INVALID','备份版本或结构不兼容，请选择当前版本导出的备份。');
    if(db.prepare('PRAGMA quick_check').get()!.quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').get())throw new AppError('BACKUP_INVALID','备份完整性检查未通过。');
    const count=(table:string)=>Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
    return {schema:SCHEMA_VERSION,counts:{jobs:count('jobs'),facts:count('resume_facts'),conversations:count('chat_conversations'),firstContactIntents:count('send_outbox'),replyIntents:count('chat_outbox')}};
  }finally{db.close();}
}
type SafetyLock={id:string;kind:string;job_id:string|null;recruiter_id:string;inbound_id:string|null;name:string;company:string};
function safetyLocks(db:DatabaseSync){
  const locks=db.prepare('SELECT * FROM contact_locks').all() as SafetyLock[];
  const append=(kind:string,jobId:string|null,recruiterId:string,inboundId:string|null,name='',company='')=>{
    const ids=recruiterHistory({db} as Store,[recruiterId]).ids;
    for(const id of ids)locks.push({id:digest(JSON.stringify([kind,jobId,id,inboundId])),kind,job_id:jobId,recruiter_id:id,inbound_id:inboundId,name,company});
  };
  for(const row of db.prepare('SELECT job_id,recruiter_id FROM send_outbox').all())append('initial',row.job_id as string,row.recruiter_id as string,null);
  for(const row of db.prepare('SELECT conversation_id,recruiter_id,inbound_id FROM chat_outbox').all())append('reply',null,row.recruiter_id as string,row.inbound_id as string);
  for(const row of db.prepare("SELECT recruiter_id,name,company FROM chat_conversations WHERE state='REJECTED' UNION ALL SELECT j.recruiter_id,'' name,j.company FROM job_outcomes o JOIN jobs j ON j.id=o.job_id WHERE o.rejected=1 AND j.recruiter_id IS NOT NULL").all())append('rejected',null,row.recruiter_id as string,null,row.name as string,row.company as string);
  return locks;
}
const safeCodes=new Set('DISCOVERING ANALYZING DRAFTING PREFLIGHT SENDING VERIFYING COMPLETED PAUSED NEEDS_HUMAN FAILED RUN_STARTED RUN_COMPLETED RUN_PAUSED WORKER_INTERRUPTED JOBS_DISCOVERED JD_CAPTURED DRY_RUN_STARTED DRY_RUN_COMPLETED ANALYSIS_COMPLETED DRAFT_READY DRAFT_BLOCKED SKIP_RULE SKIPPED USER_PAUSED PAUSE_REQUESTED SEND_INTENT SEND_CLICK_DISPATCHED SENT_CONFIRMED NEEDS_VERIFY CHAT_SEND_INTENT CHAT_CLICK_DISPATCHED CHAT_SENT_CONFIRMED MANUAL_RECONCILIATION BOSS_LOGIN_REQUIRED BOSS_CHALLENGE ADAPTER_CHANGED BROWSER_CLOSED BROWSER_AUTOMATION_PERMISSION CHROME_JAVASCRIPT_PERMISSION CHROME_UNAVAILABLE LLM_UNAVAILABLE LLM_INVALID_OUTPUT LLM_TIMEOUT LLM_LOCKED LLM_NOT_CONFIGURED CONSENT_REQUIRED GUI_AUTH_REQUIRED DAILY_LIMIT DAILY_RUN_LIMIT OUTSIDE_WORK_HOURS CONVERSATION_REJECTED CONVERSATION_CHANGED TARGET_MISMATCH CONTEXT_CHANGED SYSTEM_RESUMED EMERGENCY_STOPPED COLLECTION_FAILED DRY_RUN_FAILED SEND_FAILED CHAT_FAILED'.split(' '));
const knownCode=(value:unknown)=>typeof value==='string'&&safeCodes.has(value)?value:'REDACTED';
const safeId=(value:unknown)=>typeof value==='string'&&z.string().uuid().safeParse(value).success?value:null;
const safeTime=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
const safeCount=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:0;

export class DataService{
  private restores=new Map<string,RestorePlan>();private cleanups=new Map<string,{plan:CleanupPlan;ids:string[]}>();
  constructor(readonly store:Store,readonly root:string,readonly status:()=>WorkerStatus,private clock=()=>Date.now()){}
  async pending(){try{return Pending.parse(JSON.parse(await readFile(join(this.root,'data-operation.json'),'utf8'))).kind;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new AppError('DATA_OPERATION_INVALID','待处理数据操作无效，请检查本机数据目录。');}}
  async statusData():Promise<DataStatus>{
    const path=join(this.root,'backups');await privateDirectory(path);const backups=[];
    for(const name of (await readdir(path)).filter(name=>/^backup-[\w-]+\.sqlite$/.test(name))){const file=join(path,name),info=await lstat(file);if(info.isFile()&&!info.isSymbolicLink())backups.push({name,path:file,bytes:info.size,createdAt:info.birthtime.toISOString()});}
    backups.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return {schema:SCHEMA_VERSION,backups:backups.slice(0,20),retentionDays:this.store.getSetting<number>('retentionDays')??90,pendingOperation:await this.pending(),operationError:this.store.getSetting('dataOperationError')??null};
  }
  async exportDiagnostics(runId?:string):Promise<ExportResult>{
    const db=this.store.db,status=this.status();if(runId&&!this.store.getRun(runId))throw new AppError('RUN_NOT_FOUND','任务不存在。');
    const runs=runId?[this.store.getRun(runId)!]:this.store.listRuns();
    const report={format:'JobPilot diagnostics',version:1,createdAt:new Date(this.clock()).toISOString(),schema:SCHEMA_VERSION,runtime:{node:process.versions.node,arch:process.arch,milestone:status.milestone,mode:status.mode,browserOpen:status.browser.open,modelConfigured:status.llm.configured,modelReady:status.llm.sessionReady},counts:{jobs:Number(db.prepare('SELECT count(*) n FROM jobs').get()!.n),facts:Number(db.prepare('SELECT count(*) n FROM resume_facts WHERE deleted=0').get()!.n),firstContactIntents:Number(db.prepare('SELECT count(*) n FROM send_outbox').get()!.n),replyIntents:Number(db.prepare('SELECT count(*) n FROM chat_outbox').get()!.n)},runs:runs.map(run=>({id:safeId(run.id),state:knownCode(run.state),mode:['preview','review','auto'].includes(run.mode)?run.mode:'REDACTED',kind:['collection','dry-run','send','chat','workflow'].includes(run.kind)?run.kind:'REDACTED',startedAt:safeTime(run.startedAt),finishedAt:safeTime(run.finishedAt),errorCode:run.errorCode?knownCode(run.errorCode):null,processed:safeCount(run.processedCount),sent:safeCount(run.sentCount),needsVerify:safeCount(run.needsVerifyCount),events:this.store.events(run.id).map(event=>({traceId:safeId(event.traceId),type:knownCode(event.type),createdAt:safeTime(event.createdAt)}))})),omitted:['credentials','cookies','headers','URLs','paths','job and recruiter identities','resume and JD text','chat and draft text','notes','free-text event messages']};
    const bytes=Buffer.from(JSON.stringify(report,null,2));if(bytes.length>768*1024)throw new AppError('EXPORT_TOO_LARGE','诊断结果过大，请选择单个任务导出。');
    const directory=join(this.root,'exports');await privateDirectory(directory);const path=join(directory,`diagnostics-${Date.now()}-${randomUUID()}.json`);await writeFile(path,bytes,{flag:'wx',mode:0o600});return {path,bytes:bytes.length,sha256:digest(bytes)};
  }
  async backup():Promise<ExportResult>{
    const directory=join(this.root,'backups');await privateDirectory(directory);const path=join(directory,`backup-${new Date(this.clock()).toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.sqlite`);
    this.store.db.prepare('VACUUM INTO ?').run(path);await chmod(path,0o600);await syncFile(path);const bytes=await readFile(path);return {path,bytes:bytes.length,sha256:digest(bytes)};
  }
  async prepareRestore(path:string):Promise<RestorePlan>{
    const bytes=await regularBytes(path),id=randomUUID(),directory=join(this.root,'recovery');await privateDirectory(directory);const file=join(directory,`${id}.sqlite`);
    for(const old of this.restores.keys())await rm(join(directory,`${old}.sqlite`),{force:true});this.restores.clear();
    await writeFile(file,bytes,{flag:'wx',mode:0o600});try{const summary=await inspectBackup(file);const plan={id,expiresAt:new Date(this.clock()+300000).toISOString(),...summary,sha256:digest(bytes)};this.restores.set(id,plan);return plan;}catch(error){await rm(file,{force:true});throw error;}
  }
  async commitRestore(id:string){
    const plan=this.restores.get(id);if(!plan||Date.parse(plan.expiresAt)<=this.clock())throw new AppError('CONFIRMATION_EXPIRED','恢复确认已失效，请重新选择备份。');
    const path=join(this.root,'recovery',`${id}.sqlite`),bytes=await regularBytes(path);if(digest(bytes)!==plan.sha256)throw new AppError('BACKUP_CHANGED','备份已变化，请重新选择。');await inspectBackup(path);
    await atomicJson(join(this.root,'data-operation.json'),{kind:'restore',id,sha256:plan.sha256});this.restores.delete(id);return {restartRequired:true};
  }
  async reset(){const path=this.store.config().llmEnvPath,environmentFile=path&&dirname(resolve(path))===resolve(this.root)&&/^\.env(?:\.[\w-]+)?$/.test(basename(path))?basename(path):undefined;await atomicJson(join(this.root,'data-operation.json'),{kind:'reset',id:randomUUID(),environmentFile});return {restartRequired:true};}
  async cancel(){await rm(join(this.root,'data-operation.json'),{force:true});await rm(join(this.root,'recovery'),{recursive:true,force:true});this.store.setSetting('dataOperationError',null);this.restores.clear();return {cancelled:true};}
  retention(days:number){this.store.setSetting('retentionDays',days);return {days};}
  private cleanupIds(source:string,before:string){return (this.store.db.prepare(`SELECT j.id FROM jobs j WHERE source=? AND fetched_at<? AND j.already_contacted=0 AND NOT EXISTS(SELECT 1 FROM send_outbox s WHERE s.job_id=j.id) AND NOT EXISTS(SELECT 1 FROM review_queue q WHERE q.job_id=j.id) AND NOT EXISTS(SELECT 1 FROM job_outcomes o WHERE o.job_id=j.id) ORDER BY j.id`).all(source,before) as {id:string}[]).map(row=>row.id);}
  previewCleanup(source:'boss'|'demo',before:string):CleanupPlan{
    const ids=this.cleanupIds(source,before),plan={id:randomUUID(),source,before,count:ids.length,expiresAt:new Date(this.clock()+300000).toISOString()};this.cleanups.clear();this.cleanups.set(plan.id,{plan,ids});return plan;
  }
  commitCleanup(id:string){
    const value=this.cleanups.get(id);if(!value||Date.parse(value.plan.expiresAt)<=this.clock())throw new AppError('CONFIRMATION_EXPIRED','清理确认已失效，请重新预览。');const current=this.cleanupIds(value.plan.source,value.plan.before);if(digest(JSON.stringify(current))!==digest(JSON.stringify(value.ids)))throw new AppError('CONTEXT_CHANGED','清理范围已变化，请重新预览。');
    this.store.transaction(()=>{for(const job of current){this.store.db.prepare('DELETE FROM draft_revisions WHERE draft_id IN (SELECT id FROM greeting_drafts WHERE job_id=?)').run(job);this.store.db.prepare('DELETE FROM greeting_drafts WHERE job_id=?').run(job);this.store.db.prepare('DELETE FROM analysis_results WHERE job_id=?').run(job);this.store.db.prepare('DELETE FROM job_assessments WHERE job_id=?').run(job);this.store.db.prepare('DELETE FROM jobs WHERE id=?').run(job);}});this.cleanups.delete(id);return {removed:current.length};
  }
}

// Called only after acquiring the unique Worker lock, before opening Application.
export async function applyPendingDataOperation(root:string){
  const manifest=join(root,'data-operation.json');let operation:z.infer<typeof Pending>;
  try{operation=Pending.parse(JSON.parse(await readFile(manifest,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){await rm(join(root,'recovery'),{recursive:true,force:true});await rm(join(root,'jobpilot.restore-next.sqlite'),{force:true});return;}throw new AppError('DATA_OPERATION_INVALID','待处理的数据操作无法验证。');}
  if(operation.kind==='reset'){
    try{const pid=Number((await readlink(join(root,'chrome-profile','SingletonLock'))).match(/-(\d+)$/)?.[1]);if(pid){try{process.kill(pid,0);throw new AppError('DATA_PROFILE_ACTIVE','请先关闭专用 Chrome，再重新打开 JobPilot 完成清理。');}catch(error){if(error instanceof AppError)throw error;if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const owned=['jobpilot.sqlite','jobpilot.sqlite-wal','jobpilot.sqlite-shm','jobpilot.restore-next.sqlite','.env',...(operation.environmentFile?[operation.environmentFile]:[]),'chrome-profile','backups','exports','recovery','desktop-stderr.log','desktop-stdout.log','send-safety.json',...(await readdir(root)).filter(name=>/^jobpilot\.pre-[\w.]+\.sqlite(?:-wal|-shm)?$/.test(name))];
    for(const name of owned)await rm(join(root,name),{recursive:true,force:true});
    await rm(manifest,{force:true});return;
  }
  const source=join(root,'recovery',`${operation.id}.sqlite`),bytes=await regularBytes(source);if(digest(bytes)!==operation.sha256)throw new AppError('BACKUP_CHANGED','恢复快照已变化，未覆盖现有数据。');await inspectBackup(source);
  const primary=join(root,'jobpilot.sqlite'),original=new DatabaseSync(primary,{allowExtension:false});let locks:SafetyLock[];
  if(original.prepare("SELECT value_json FROM settings WHERE key='appliedDataOperation'").get()?.value_json===JSON.stringify(operation.id)){original.close();await rm(manifest,{force:true});await rm(source,{force:true});await rm(join(root,'recovery',`apply-${operation.id}`),{recursive:true,force:true});return;}
  const backup=join(root,'backups',`backup-before-restore-${operation.id}.sqlite`);await privateDirectory(join(root,'backups'));
  try{
    if(Number(original.prepare("SELECT ((SELECT count(*) FROM send_outbox WHERE state IN ('SENDING','NEEDS_VERIFY'))+(SELECT count(*) FROM chat_outbox WHERE state IN ('SENDING','NEEDS_VERIFY'))) n").get()!.n))throw new AppError('NEEDS_VERIFY','请先核验当前不确定发送，再恢复备份。');
    locks=safetyLocks(original);if(!await stat(backup).then(()=>true,()=>false)){original.prepare('VACUUM INTO ?').run(backup);await chmod(backup,0o600);}original.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }finally{original.close();}
  const working=join(root,'recovery',`apply-${operation.id}`);await rm(working,{recursive:true,force:true});await privateDirectory(working);await writeFile(join(working,'jobpilot.sqlite'),bytes,{mode:0o600});const restored=new Store(working);
  try{restored.transaction(()=>{
    for(const row of locks)restored.db.prepare('INSERT OR IGNORE INTO contact_locks VALUES(?,?,?,?,?,?,?)').run(row.id,row.kind,row.job_id,row.recruiter_id,row.inbound_id,row.name,row.company);
    const config=restored.config();restored.setSetting('config',{...config,llm:null,llmEnvPath:join(root,'.env'),bossReadOnlyConsent:false,version:config.version+1});
    const policy=restored.getSetting<Record<string,unknown>>('sendPolicy');if(policy)restored.setSetting('sendPolicy',{...policy,liveEnabled:false,confirmed:false,version:Number(policy.version??0)+1});
    const notifications=restored.getSetting<Record<string,unknown>>('notificationSettings');if(notifications)restored.setSetting('notificationSettings',{...notifications,enabled:false});
    restored.setSetting('notificationDestination',null);restored.setSetting('notificationDelivery',null);
    restored.db.exec('DELETE FROM send_plans; DELETE FROM chat_plans;');
    restored.setSetting('appliedDataOperation',operation.id);
  });}finally{restored.close();}
  const next=join(root,'jobpilot.restore-next.sqlite');await copyFile(join(working,'jobpilot.sqlite'),next);await chmod(next,0o600);await syncFile(next);
  await rm(primary+'-wal',{force:true});await rm(primary+'-shm',{force:true});await rename(next,primary);
  await rm(manifest,{force:true});await rm(working,{recursive:true,force:true});await rm(source,{force:true});
}

export async function recoverPendingData(root:string){
  try{await applyPendingDataOperation(root);return null;}catch(error){
    // A failed validation must not make a healthy, unchanged database impossible
    // to open. Continue only after verifying the remaining primary database.
    await inspectBackup(join(root,'jobpilot.sqlite'));
    await rm(join(root,'data-operation.json'),{force:true});await rm(join(root,'recovery'),{recursive:true,force:true});await rm(join(root,'jobpilot.restore-next.sqlite'),{force:true});
    return {code:error instanceof AppError?error.code:'DATA_RECOVERY_FAILED',message:'上次数据操作未能全部完成，已停止该操作。请检查现有数据后重新选择备份或清理。'};
  }
}
