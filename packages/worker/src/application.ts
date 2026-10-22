import { z } from 'zod';
import { AppError, AnalyzeInput, ConfigUpdate, DraftInput, DraftUpdate, DryRunInput, FactUpdate, JobListQuery, QueueInput, QueueList, QueueReview, ResumeImport, SearchProfile, StartRun,SendSelection,SendCommit,SendResolve, type Request, type JobSource, type JobRecord, type WorkerStatus, type LlmConfiguration } from '@jobpilot/contracts';
import { Store,listOutcomes,updateOutcome,conversionStats } from '@jobpilot/store';
import {OutcomeList,OutcomeUpdate,StatsQuery} from '@jobpilot/contracts';
import { BrowserProbe, searchUrl } from '@jobpilot/boss-adapter';
import { parseResume } from '@jobpilot/resume';
import { testConnection, validateEndpoint } from '@jobpilot/llm';
import { demoJobs } from '../../../fixtures/boss/demo-jobs.js';
import { MatchingService } from '@jobpilot/core';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {EnvironmentSave,readEnvironment,saveEnvironment} from './environment.js';
import {ChattingService,type ChatTransport} from '../../core/src/chatting.js';
import {SendingService,type SendTransport} from '../../core/src/sending.js';
import {DataService} from './data.js';

const Identifier = z.object({id: z.string().min(1).max(200)}).strict();
const StartPreview = StartRun.extend({maxJobs: z.number().int().min(1).max(50).optional()}).strict();
export class Application {
  readonly store: Store;
  readonly browser: BrowserProbe;
  readonly matching: MatchingService;
  readonly sending:SendingService;
  readonly chatting:ChattingService;
  readonly data:DataService;
  private dataBusy=false;
  private credentials: {baseUrl: string; apiKey: string} | null = null;
  private environmentError: string|null = null;
  private environmentPath: string;
  private active: {id: string; controller: AbortController; promise: Promise<void>} | undefined;
  private llmBusy = false;
  private importing = false;
  private started = Date.now();
  constructor(dataDir: string,options:{chatTransport?:ChatTransport;transport?:SendTransport;health?:(signal:AbortSignal)=>Promise<boolean>;clock?:()=>number}={}) {
    this.store = new Store(dataDir); this.browser = new BrowserProbe(dataDir); this.matching = new MatchingService(this.store,()=>this.llmConfiguration());
    this.environmentPath=this.store.config().llmEnvPath??join(dataDir,'.env');
    if(this.store.config().llmEnvPath||existsSync(this.environmentPath))try{this.useEnvironment(readEnvironment(this.environmentPath));}catch(error){this.environmentError=error instanceof AppError?error.message:'环境配置读取失败，请在设置重新选择文件。';}
    this.sending=new SendingService(this.store,this.matching,options.transport??this.browser,options.health??(signal=>this.llm(async()=>{const result=await testConnection(this.llmConfiguration(),signal);this.store.setSetting('llmHealth',{healthy:result.healthy,checkedAt:new Date().toISOString()});return result.healthy;},true)),options.clock);
    this.chatting=new ChattingService(this.store,this.sending,options.chatTransport??this.browser,()=>this.llmConfiguration(),()=>!!this.active||this.llmBusy||!!this.sending.active||this.dataBusy,options.clock,options.health);
    this.data=new DataService(this.store,dataDir,()=>this.status(),options.clock);
  }
  private useEnvironment(value:ReturnType<typeof readEnvironment>,explicit=false) {
    const {apiKey,...settings}=value.configuration;
    this.store.updateConfig({llm:settings,llmEnvPath:value.path});
    if(explicit)this.store.setSetting('sendEnvironmentRevision',(this.store.getSetting<number>('sendEnvironmentRevision')??0)+1);
    this.credentials={baseUrl:settings.baseUrl,apiKey:apiKey??''};this.environmentPath=value.path;this.environmentError=null;
    return {path:value.path,hasApiKey:!!apiKey,loaded:true};
  }
  private llmConfiguration(): LlmConfiguration {
    const config = this.store.config().llm;
    if (!config) throw new AppError('LLM_NOT_CONFIGURED','请先在设置中保存 Cockpit 地址和模型。');
    if (this.credentials?.baseUrl!==config.baseUrl) throw new AppError('LLM_LOCKED',this.environmentError??'请在设置加载 .env 配置，或填写 API Key 并保存到配置文件。');
    return {...config,...(this.credentials?.baseUrl===config.baseUrl?{apiKey:this.credentials.apiKey}:{})};
  }
  private async llm<T>(action:()=>Promise<T>,inRun=false) {
    if (this.llmBusy || ((this.active||this.sending?.active) && !inRun)) throw new AppError('LLM_BUSY','已有任务或模型操作正在运行，请稍后重试。');
    this.llmBusy=true;try{return await action();}finally{this.llmBusy=false;}
  }
  status(): WorkerStatus {
    return {milestone: 'M4', pid: process.pid, node: process.versions.node, arch: process.arch, uptimeSeconds: Math.floor((Date.now() - this.started) / 1000), mode: this.sending.status().mode as WorkerStatus['mode'], autoModeConsent: this.sending.status().autoModeConsent, sendingAvailable: true, browser: this.browser.status(),llm:{configured:!!this.store.config().llm,sessionReady:!!this.credentials&&this.credentials.baseUrl===this.store.config().llm?.baseUrl,envPath:this.environmentPath,hasApiKey:!!this.credentials?.apiKey,error:this.environmentError},dataOperationError:this.store.getSetting('dataOperationError')??null};
  }
  private gui(authorized:boolean){if(!authorized)throw new AppError('GUI_AUTH_REQUIRED','数据导出、恢复、清理和结果标记需要在应用界面操作。');}
  private async maintain<T>(authorized:boolean,action:()=>Promise<T>|T){
    this.gui(authorized);if(this.dataBusy||this.active||this.llmBusy||this.importing||this.sending.active||this.chatting.busy||this.sending.status().autoModeConsent||this.chatting.list().autoEnabled)throw new AppError('RUN_ACTIVE','请先停止任务和两种 Auto，再操作本机数据。');
    this.dataBusy=true;try{return await action();}finally{this.dataBusy=false;}
  }
  private consent() { if (!this.store.config().bossReadOnlyConsent) throw new AppError('CONSENT_REQUIRED', '请先在设置中明确授权 BOSS 只读访问。'); }
  private start(source: JobSource, maxJobs?: number) {
    if (this.active || this.llmBusy||this.sending.active||this.chatting?.busy) throw new AppError('RUN_ACTIVE', '已有任务运行中。');
    if (source === 'boss') this.consent();
    const profile = this.store.getSearch()!;
    if (maxJobs) profile.maxJobs = Math.min(maxJobs, profile.maxJobs);
    const run = this.store.createRun(source);
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      this.store.event(run.id, 'RUN_STARTED', source === 'demo' ? '载入 20 条匿名演示岗位；不连接 BOSS。' : '开始只读采集，本次任务无发送能力。');
      try {
        if (source === 'demo') {
          for (const job of demoJobs()) { controller.signal.throwIfAborted(); this.store.upsertJob(job); this.store.incrementRun(run.id); }
        } else {
          const discovered: JobRecord[] = [];
          await this.browser.search(profile, controller.signal, job => { discovered.push(job); this.store.upsertJob(job); this.store.incrementRun(run.id); });
          this.store.event(run.id, 'JOBS_DISCOVERED', `已采集 ${discovered.length} 条职位卡片，开始逐条读取 JD。`);
          for (const job of discovered) { controller.signal.throwIfAborted(); this.store.upsertJob(await this.browser.readJob(job, controller.signal)); this.store.event(run.id, 'JD_CAPTURED', `已保存岗位 ${job.platformJobId} 的职位描述。`); }
        }
        this.store.finishRun(run.id, 'COMPLETED');
        this.store.event(run.id, 'RUN_COMPLETED', `只读任务完成，本次处理 ${this.store.getRun(run.id)!.discoveredCount} 条；岗位池按 ID 去重。`);
      } catch (error) {
        const code = controller.signal.aborted ? 'USER_PAUSED' : error instanceof AppError ? error.code : 'COLLECTION_FAILED';
        const state = controller.signal.aborted ? 'PAUSED' : ['BOSS_LOGIN_REQUIRED', 'BOSS_CHALLENGE', 'ADAPTER_CHANGED', 'BROWSER_CLOSED', 'BROWSER_AUTOMATION_PERMISSION', 'CHROME_JAVASCRIPT_PERMISSION'].includes(code) ? 'NEEDS_HUMAN' : 'FAILED';
        this.store.finishRun(run.id, state, code);
        this.store.event(run.id, code, error instanceof AppError ? error.message : controller.signal.aborted ? '任务已暂停，已保存采集结果。' : '采集失败，已保存已读取的结果。');
      } finally { if (this.active?.id === run.id) this.active = undefined; }
    });
    this.active = {id: run.id, controller, promise};
    return {runId: run.id};
  }
  private dryRun(input: z.infer<typeof DryRunInput>) {
    if(this.active||this.llmBusy||this.sending.active||this.chatting?.busy)throw new AppError('RUN_ACTIVE','已有任务或模型操作运行中。');
    const resume=this.store.frozenFacts();this.llmConfiguration();
    const jobs=input.jobIds?input.jobIds.map(id=>this.store.getJob(id)):this.store.listJobs({source:input.source,limit:input.maxJobs,offset:0}).items;
    if(jobs.some(job=>!job||job.source!==input.source))throw new AppError('JOB_NOT_FOUND','岗位不存在或来源与本次预览不一致。');
    const ids=[...new Set(jobs.map(job=>job!.id))].slice(0,input.maxJobs);
    if(!ids.length)throw new AppError('NO_JOBS','请先采集岗位或载入匿名演示。');
    const run=this.store.createRun(input.source),controller=new AbortController();
    this.store.db.prepare("UPDATE runs SET kind='dry-run',state='ANALYZING',discovered_count=? WHERE id=?").run(ids.length,run.id);
    const promise=Promise.resolve().then(async()=>{
      this.store.event(run.id,'DRY_RUN_STARTED',`开始本地预览：${ids.length} 条岗位，事实版本 v${resume.version}；仅匹配、生成和本地审核。`);
      try{
        for(const id of ids){
          controller.signal.throwIfAborted();this.store.frozenFacts(resume.version);
          this.store.db.prepare("UPDATE runs SET state='ANALYZING' WHERE id=?").run(run.id);
          const assessment=await this.llm(()=>this.matching.analyze(id,controller.signal,resume.version),true);
          this.store.db.prepare('UPDATE runs SET processed_count=processed_count+1 WHERE id=?').run(run.id);
          this.store.event(run.id,'JOB_ASSESSED',`${id}：${assessment.decision}${assessment.score===null?'':`，${assessment.score} 分`}。`);
          if(assessment.decision==='SKIP_RULE'||assessment.decision==='SKIP'||assessment.score===null||!assessment.evidenceFactIds.length){this.store.db.prepare('UPDATE runs SET skipped_count=skipped_count+1 WHERE id=?').run(run.id);continue;}
          this.store.db.prepare("UPDATE runs SET state='DRAFTING' WHERE id=?").run(run.id);
          const draft=await this.llm(()=>this.matching.generate(id,'natural',controller.signal),true);
          if(draft.audit.status==='PASS'){
            this.matching.queue(id,draft.id);this.store.db.prepare('UPDATE runs SET drafted_count=drafted_count+1 WHERE id=?').run(run.id);
            this.store.event(run.id,'DRAFT_QUEUED',`${id}：草稿通过审计，已加入本地审核队列。`);
          }else this.store.event(run.id,'DRAFT_BLOCKED',`${id}：草稿未通过审计，请在岗位详情中查看原因。`);
        }
        this.store.finishRun(run.id,'COMPLETED');this.store.event(run.id,'DRY_RUN_COMPLETED','预览完成，发送次数为 0。');
      }catch(error){
        const code=controller.signal.aborted?'USER_PAUSED':error instanceof AppError?error.code:'DRY_RUN_FAILED';
        this.store.finishRun(run.id,controller.signal.aborted?'PAUSED':'NEEDS_HUMAN',code);
        this.store.event(run.id,code,error instanceof AppError?error.message:controller.signal.aborted?'预览已暂停，已保留结果。':'预览已停止，请检查本地状态。');
      }finally{if(this.active?.id===run.id)this.active=undefined;}
    });
    this.active={id:run.id,controller,promise};return {runId:run.id};
  }
  async dispatch(action: Request['action'], payload: unknown, signal: AbortSignal,guiAuthorized=false): Promise<unknown> {
    const readOnly=['status','config.get','dashboard.get','jobs.list','jobs.get','resume.list','search.get','run.list','run.get','queue.list','send.status','send.outbox','chat.list','chat.outbox','outcomes.list','stats.get','data.status'];
    if(this.dataBusy&&!readOnly.includes(action))throw new AppError('RUN_ACTIVE','本机数据操作正在进行，请稍后重试。');
    if(!readOnly.includes(action)&&action!=='data.operation.cancel'&&action!=='send.stop'&&await this.data.pending())throw new AppError('RESTART_REQUIRED','已确认的数据操作等待重启；可在设置取消。');
    if(this.dataBusy&&!readOnly.includes(action))throw new AppError('RUN_ACTIVE','本机数据操作正在进行，请稍后重试。');
    if(this.chatting.busy&&!readOnly.includes(action)&&!['send.stop','run.pause','chat.auto.set'].includes(action))throw new AppError('RUN_ACTIVE','聊天任务持有浏览器与模型，请先停止。');
    if(this.sending.active&&['chat.open','chat.scan','chat.prepare','chat.commit','chat.auto.tick','browser.open','browser.close','boss.login.open','boss.login.status','jobs.read','boss.communication.inspect','send.prepare','llm.env.load','llm.env.save'].includes(action))throw new AppError('RUN_ACTIVE','发送任务持有浏览器，请先暂停。');
    switch (action) {
      case 'outcomes.list': return listOutcomes(this.store.db,OutcomeList.parse(payload??{}));
      case 'outcomes.update': return this.maintain(guiAuthorized,()=>{const input=OutcomeUpdate.parse(payload),value=this.store.transaction(()=>updateOutcome(this.store.db,input));if(input.rejected)this.chatting.stop();return value;});
      case 'stats.get': return conversionStats(this.store.db,StatsQuery.parse(payload??{}));
      case 'diagnostics.export': return this.maintain(guiAuthorized,()=>this.data.exportDiagnostics(payload===undefined||payload===null?undefined:Identifier.parse(payload).id));
      case 'data.status': return this.data.statusData();
      case 'data.backup': return this.maintain(guiAuthorized,()=>this.data.backup());
      case 'data.restore.prepare': return this.maintain(guiAuthorized,()=>this.data.prepareRestore(ResumeImport.parse(payload).path));
      case 'data.restore.commit': return this.maintain(guiAuthorized,()=>{const input=z.object({id:z.string().uuid(),confirmed:z.literal(true)}).strict().parse(payload);if(this.sending.statusNeedsVerify())throw new AppError('NEEDS_VERIFY','请先核验当前不确定发送，再恢复备份。');return this.data.commitRestore(input.id);});
      case 'data.reset': return this.maintain(guiAuthorized,async()=>{z.object({confirmation:z.literal('清除 JobPilot 本机数据')}).strict().parse(payload);if(this.sending.statusNeedsVerify())throw new AppError('NEEDS_VERIFY','请先核验当前不确定发送，再清除本机数据。');await this.browser.close();return this.data.reset();});
      case 'data.operation.cancel': return this.maintain(guiAuthorized,()=>this.data.cancel());
      case 'data.retention.save': return this.maintain(guiAuthorized,()=>this.data.retention(z.object({days:z.number().int().min(7).max(3650)}).strict().parse(payload).days));
      case 'data.cleanup.preview': return this.maintain(guiAuthorized,()=>{const input=z.object({source:z.enum(['boss','demo']),before:z.string().datetime()}).strict().parse(payload);return this.data.previewCleanup(input.source,input.before);});
      case 'data.cleanup.commit': return this.maintain(guiAuthorized,()=>this.data.commitCleanup(z.object({id:z.string().uuid(),confirmed:z.literal(true)}).strict().parse(payload).id));
      case 'status': return this.status();
      case 'dashboard.get': return this.store.dashboard();
      case 'config.get': return this.store.config();
      case 'chat.open': this.consent();return this.browser.openChats();
      case 'chat.list': return this.chatting.list();
      case 'chat.scan': this.consent();return this.chatting.scan(payload===undefined?undefined:Identifier.parse(payload).id);
      case 'chat.prepare': return this.chatting.prepare(Identifier.parse(payload).id);
      case 'chat.commit': return this.chatting.commit(z.object({id:z.string().uuid(),confirmed:z.literal(true)}).strict().parse(payload).id,guiAuthorized);
      case 'chat.auto.set': {const input=z.object({enabled:z.boolean(),conversationIds:z.array(z.string().min(1).max(200)).max(20).default([]),confirmed:z.literal(true)}).strict().parse(payload);return this.chatting.setAuto(input.enabled,input.conversationIds,guiAuthorized);}
      case 'chat.auto.tick': return this.chatting.tick();
      case 'chat.outbox': return this.chatting.outbox();
      case 'chat.resolve': {const input=z.object({id:z.string().uuid(),expectedVersion:z.number().int(),result:z.enum(['sent','not-sent']),confirmed:z.literal(true)}).strict().parse(payload);return this.chatting.resolve(input.id,input.expectedVersion,input.result,guiAuthorized);}
      case 'send.status': return this.sending.status();
      case 'send.policy.save': return this.sending.savePolicy(payload,guiAuthorized);
      case 'send.auto.set': return this.sending.setAuto(z.object({enabled:z.boolean()}).strict().parse(payload).enabled,guiAuthorized);
      case 'send.prepare': {if(this.active||this.llmBusy)throw new AppError('RUN_ACTIVE','请先等待当前任务结束。');return this.sending.prepare(SendSelection.parse(payload).queueIds,signal);}
      case 'send.commit': {if(this.active||this.llmBusy)throw new AppError('RUN_ACTIVE','已有任务运行中。');return this.sending.commit(SendCommit.parse(payload).planId,guiAuthorized);}
      case 'send.outbox': {const input=QueueList.parse(payload??{});return this.sending.outbox(input.limit,input.offset);}
      case 'send.verify': return this.sending.verify(Identifier.parse(payload).id,signal);
      case 'send.resolve': {const input=SendResolve.parse(payload);return this.sending.resolve(input.id,input.expectedVersion,input.result,guiAuthorized);}
      case 'send.stop': this.active?.controller.abort();this.chatting.stop();return this.sending.stop();
      case 'send.reset': return this.sending.reset(guiAuthorized);
      case 'send.resume': return this.sending.resume(z.object({id:z.string().uuid(),confirmed:z.literal(true)}).strict().parse(payload).id,guiAuthorized);
      case 'send.cancel': return this.sending.cancel(z.object({id:z.string().uuid(),confirmed:z.literal(true)}).strict().parse(payload).id,guiAuthorized);
      case 'send.checkpoint': return this.sending.checkpoint(Identifier.parse(payload).id);
      case 'boss.communication.inspect': this.consent();return this.sending.inspect(Identifier.parse(payload).id,signal);
      case 'llm.env.load': {const input=z.object({path:z.string().min(1).max(4096).optional()}).strict().parse(payload??{});return this.useEnvironment(readEnvironment(input.path??this.environmentPath),true);}
      case 'llm.env.save': {const input=EnvironmentSave.parse(payload);return this.useEnvironment(saveEnvironment(input.path??this.environmentPath,input),true);}
      case 'policy.get': return this.matching.policy();
      case 'policy.save': return this.matching.savePolicy(payload);
      case 'analysis.get': return this.matching.details(AnalyzeInput.parse(payload).jobId);
      case 'analysis.analyze': {const input=AnalyzeInput.parse(payload);return this.llm(()=>this.matching.analyze(input.jobId,signal,input.resumeVersion));}
      case 'draft.generate': {const input=DraftInput.parse(payload);return this.llm(()=>this.matching.generate(input.jobId,input.style,signal));}
      case 'draft.update': {const input=DraftUpdate.parse(payload);return this.matching.updateDraft(input.id,input.expectedVersion,input.content);}
      case 'queue.list': {const input=QueueList.parse(payload??{});return {items:this.matching.listQueue(input.limit,input.offset),total:this.matching.queueCount()};}
      case 'queue.add': {const input=QueueInput.parse(payload);return this.matching.queue(input.jobId,input.draftId);}
      case 'queue.review': {const input=QueueReview.parse(payload);return this.matching.review(input.id,input.expectedVersion);}
      case 'queue.remove': {const input=QueueReview.parse(payload);return this.matching.remove(input.id,input.expectedVersion);}
      case 'dryrun.start': return this.dryRun(DryRunInput.parse(payload));
      case 'config.validate': case 'config.update': {
        const update = ConfigUpdate.parse(payload);
        if (update.llm) validateEndpoint(update.llm);
        if (action === 'config.validate') return {valid: true};
        if (update.bossReadOnlyConsent === false && this.active) this.active.controller.abort();
        if (update.bossReadOnlyConsent === false){this.sending.stop();this.chatting.stop();}
        return this.store.updateConfig(update);
      }
      case 'browser.open': return this.browser.open();
      case 'browser.close':
        if (this.active) throw new AppError('RUN_ACTIVE', '请先暂停采集任务。');
        return this.browser.close();
      case 'boss.login.open': this.consent(); return this.browser.openLogin();
      case 'boss.login.status': this.consent(); return this.browser.loginStatus();
      case 'boss.diagnostics': this.consent(); return this.browser.diagnostics();
      case 'llm.test':
        return this.llm(async()=>{const result=await testConnection(payload??this.llmConfiguration(),signal);this.store.setSetting('llmHealth',{healthy:result.healthy,checkedAt:new Date().toISOString()});return result;});
      case 'resume.import': {
        if (this.importing) throw new AppError('IMPORT_BUSY', '已有简历正在解析。');
        this.importing = true;
        try { const parsed = await parseResume(ResumeImport.parse(payload).path, signal); signal.throwIfAborted(); return {...this.store.importFacts(parsed.file, parsed.hash, parsed.facts), warnings: parsed.warnings}; }
        finally { this.importing = false; }
      }
      case 'resume.list': return this.store.resume();
      case 'resume.update': return this.store.updateFact(FactUpdate.parse(payload));
      case 'resume.freeze': return this.store.freezeResume(z.object({expectedVersion: z.number().int().min(1)}).strict().parse(payload).expectedVersion);
      case 'search.get': return this.store.getSearch();
      case 'search.save': {
        if (this.active) throw new AppError('RUN_ACTIVE', '请等待或暂停当前任务后再修改方案。');
        const profile = SearchProfile.parse(payload), safeUrl = searchUrl(profile);
        if (profile.searchUrl) profile.searchUrl = safeUrl;
        return this.store.saveSearch(profile);
      }
      case 'jobs.list': { const result = this.store.listJobs(JobListQuery.parse(payload ?? {})); return {...result, items: result.items.map(job => ({...job, jdText: job.jdText.slice(0, 240), snapshot: ''}))}; }
      case 'jobs.get': case 'jobs.read': {
        const job = this.store.getJob(Identifier.parse(payload).id);
        if (!job) throw new AppError('JOB_NOT_FOUND', '岗位不存在。');
        if (action === 'jobs.read' && job.source === 'boss') {
          this.consent(); if (this.active) throw new AppError('RUN_ACTIVE', '请等待当前任务完成再刷新 JD。');
          const read = await this.browser.readJob(job, signal); this.store.upsertJob(read); return read;
        }
        return job;
      }
      case 'demo.load': return this.start('demo');
      case 'run.start': {
        const run = StartPreview.parse(payload);
        if (run.mode === 'auto') {if(this.active||this.llmBusy)throw new AppError('RUN_ACTIVE','已有任务运行中。');return this.sending.startAuto();}
        if (run.mode !== 'preview') throw new AppError('CONSENT_REQUIRED', 'Review 需要在界面检查具体岗位和最终文案后确认发送。');
        if (run.profileId !== 'primary') throw new AppError('PROFILE_NOT_FOUND', '搜索方案不存在。');
        return this.start('boss', run.maxJobs);
      }
      case 'run.list': return this.store.listRuns();
      case 'run.get': {
        const id = Identifier.parse(payload).id, run = this.store.getRun(id);
        if (!run) throw new AppError('RUN_NOT_FOUND', '任务不存在。');
        return {...run, events: this.store.events(id)};
      }
      case 'run.pause': {
        const id = Identifier.parse(payload).id;
        if (!this.store.getRun(id)) throw new AppError('RUN_NOT_FOUND', '任务不存在。');
        if (this.active?.id === id) { this.active.controller.abort(); this.store.event(id, 'PAUSE_REQUESTED', '已请求暂停，当前只读操作结束后停止。'); }
        if(this.chatting.busy)this.chatting.stop();
        if(this.sending.active?.id===id){this.sending.pause(id);this.store.event(id,'PAUSE_REQUESTED','已请求暂停，已提交动作不可撤回；不确定发送会锁定待核验。');}
        return {accepted: true};
      }
      default: throw new AppError('ACTION_UNAVAILABLE', '不支持的操作。');
    }
  }
  async prepareShutdown() {
    this.active?.controller.abort();
    this.sending.pause();
    this.chatting.stop();
    await this.browser.dispose();
  }
  async close() {
    await this.prepareShutdown();
    await this.active?.promise;
    await this.sending.close();
    await this.chatting.close();
    this.store.close();
  }
}
