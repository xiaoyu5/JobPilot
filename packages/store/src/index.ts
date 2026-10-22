import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export {listOutcomes,updateOutcome,conversionStats} from './outcomes.js';
export const SCHEMA_VERSION=5;
import { AppError, redact, type AppConfig, type Dashboard, type JobRecord, type JobSource, type PendingFact, type ResumeFact, type ResumeState, type RunEvent, type RunRecord, type SearchProfileData } from '@jobpilot/contracts';

const migration = `
CREATE TABLE settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE resume_facts(id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL, source_json TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN (0,1)), version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE resume_imports(id TEXT PRIMARY KEY, source_file TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE, imported_at TEXT NOT NULL);
CREATE TABLE search_profiles(id TEXT PRIMARY KEY, name TEXT NOT NULL, filters_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY, platform TEXT NOT NULL DEFAULT 'boss', platform_job_id TEXT NOT NULL, recruiter_id TEXT, source TEXT NOT NULL CHECK(source IN ('boss','demo')), title TEXT NOT NULL, company TEXT NOT NULL, salary TEXT NOT NULL, city TEXT NOT NULL, experience TEXT NOT NULL, education TEXT NOT NULL, url TEXT NOT NULL, jd_text TEXT NOT NULL, jd_hash TEXT NOT NULL, fetched_at TEXT NOT NULL, snapshot TEXT NOT NULL, already_contacted INTEGER NOT NULL DEFAULT 0, UNIQUE(source,platform_job_id));
CREATE TABLE runs(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode='preview'), source TEXT NOT NULL, state TEXT NOT NULL, discovered_count INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT);
CREATE TABLE run_events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), trace_id TEXT NOT NULL, event_type TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX run_events_run ON run_events(run_id,id);
CREATE INDEX jobs_fetched ON jobs(fetched_at DESC);
CREATE TABLE resume_snapshots(version INTEGER PRIMARY KEY, facts_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE job_assessments(job_id TEXT PRIMARY KEY REFERENCES jobs(id), model TEXT NOT NULL, prompt_version TEXT NOT NULL, resume_version INTEGER NOT NULL, score INTEGER NOT NULL, decision TEXT NOT NULL, reasons_json TEXT NOT NULL, evidence_json TEXT NOT NULL);
CREATE TABLE greeting_drafts(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), content TEXT NOT NULL, fact_ids_json TEXT NOT NULL, resume_version INTEGER NOT NULL, audit_status TEXT NOT NULL, manual_override INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE send_outbox(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), recruiter_id TEXT NOT NULL, idem_key TEXT NOT NULL UNIQUE, draft_id TEXT NOT NULL REFERENCES greeting_drafts(id), state TEXT NOT NULL, authorized_at TEXT, sent_at TEXT, verify_detail TEXT);
PRAGMA user_version=1;
`;
type Row = Record<string, any>;
const migration2 = `
CREATE TABLE analysis_results(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),cache_key TEXT NOT NULL UNIQUE,report_json TEXT NOT NULL,stale INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE INDEX analysis_job ON analysis_results(job_id,created_at DESC);
ALTER TABLE greeting_drafts ADD COLUMN assessment_id TEXT REFERENCES analysis_results(id);
ALTER TABLE greeting_drafts ADD COLUMN cache_key TEXT;
ALTER TABLE greeting_drafts ADD COLUMN detail_json TEXT;
ALTER TABLE greeting_drafts ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX draft_cache ON greeting_drafts(cache_key) WHERE cache_key IS NOT NULL;
CREATE TABLE draft_revisions(draft_id TEXT NOT NULL REFERENCES greeting_drafts(id),version INTEGER NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(draft_id,version));
CREATE TABLE review_queue(id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),draft_id TEXT NOT NULL REFERENCES greeting_drafts(id),version INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL CHECK(state IN ('PENDING','REVIEWED','BLOCKED','STALE')),created_at TEXT NOT NULL,reviewed_at TEXT);
ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'collection';
ALTER TABLE runs ADD COLUMN processed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN drafted_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version=2;`;
const now = () => new Date().toISOString();
const migration3=`
ALTER TABLE runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'preview' CHECK(execution_mode IN ('preview','review','auto'));
ALTER TABLE runs ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN needs_verify_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN checkpoint_json TEXT;
ALTER TABLE send_outbox ADD COLUMN run_id TEXT REFERENCES runs(id);
ALTER TABLE send_outbox ADD COLUMN phase TEXT NOT NULL DEFAULT 'INTENT';
ALTER TABLE send_outbox ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE send_outbox ADD COLUMN resume_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE send_outbox ADD COLUMN draft_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE send_outbox ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE send_outbox ADD COLUMN content_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE send_outbox ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE send_outbox ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX send_job_once ON send_outbox(job_id);
CREATE UNIQUE INDEX send_recruiter_once ON send_outbox(recruiter_id);
CREATE TABLE send_plans(id TEXT PRIMARY KEY,detail_json TEXT NOT NULL,context_hash TEXT NOT NULL,expires_at TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE send_authorizations(id TEXT PRIMARY KEY,mode TEXT NOT NULL,policy_version INTEGER NOT NULL,context_hash TEXT NOT NULL,scope_json TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT);
PRAGMA user_version=3;`;


const migration4=`
ALTER TABLE send_outbox ADD COLUMN message_units INTEGER NOT NULL DEFAULT 1;
ALTER TABLE send_outbox ADD COLUMN confirmed_units INTEGER NOT NULL DEFAULT 0;
ALTER TABLE send_outbox ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE send_outbox ADD COLUMN default_phase TEXT NOT NULL DEFAULT 'NOT_APPLICABLE';
ALTER TABLE send_outbox ADD COLUMN default_proof TEXT;
UPDATE send_outbox SET confirmed_units=1 WHERE state IN ('SENT_CONFIRMED','MANUALLY_CONFIRMED');
CREATE TABLE chat_conversations(id TEXT PRIMARY KEY,recruiter_id TEXT NOT NULL,name TEXT NOT NULL,company TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,snapshot_json TEXT NOT NULL,last_inbound_id TEXT,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
CREATE INDEX chat_recruiter ON chat_conversations(recruiter_id);
CREATE TABLE chat_plans(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,detail_json TEXT NOT NULL,context_hash TEXT NOT NULL,expires_at TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE chat_outbox(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),conversation_id TEXT NOT NULL,recruiter_id TEXT NOT NULL,inbound_id TEXT NOT NULL,content TEXT NOT NULL,context_hash TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,UNIQUE(recruiter_id,inbound_id));
PRAGMA user_version=4;`;
const migration5=`
CREATE TABLE job_outcomes(job_id TEXT PRIMARY KEY REFERENCES jobs(id),replied INTEGER NOT NULL DEFAULT 0 CHECK(replied IN (0,1)),rejected INTEGER NOT NULL DEFAULT 0 CHECK(rejected IN (0,1)),interview INTEGER NOT NULL DEFAULT 0 CHECK(interview IN (0,1)),note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,CHECK(replied=1 OR (rejected=0 AND interview=0)));
CREATE TABLE contact_locks(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('initial','reply','rejected')),job_id TEXT,recruiter_id TEXT NOT NULL,inbound_id TEXT,name TEXT NOT NULL DEFAULT '',company TEXT NOT NULL DEFAULT '');
CREATE INDEX contact_locks_recruiter ON contact_locks(recruiter_id,kind,inbound_id);
PRAGMA user_version=5;`;

export class Store {
  readonly db: DatabaseSync;
  constructor(dataDir: string) {
    const path = join(dataDir, 'jobpilot.sqlite');
    this.db = new DatabaseSync(path, {enableForeignKeyConstraints: true, allowExtension: false});
    chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version > SCHEMA_VERSION) { this.db.close(); throw new AppError('DB_VERSION_UNSUPPORTED', '数据库来自更新版本，请使用对应版本应用。'); }
    if (version === 0) this.transaction(() => this.db.exec(migration));
    if (version === 1) {
      const backupPath=join(dataDir,'jobpilot.pre-m2.sqlite');
      if (!existsSync(backupPath)) { this.db.prepare('VACUUM INTO ?').run(backupPath); chmodSync(backupPath,0o600); }
    }
    if (version < 2) this.transaction(() => this.db.exec(migration2));
    if(version>0&&version<3){const backupPath=join(dataDir,'jobpilot.pre-m3.sqlite');if(!existsSync(backupPath)){this.db.prepare('VACUUM INTO ?').run(backupPath);chmodSync(backupPath,0o600);}}
    if(version<3)this.transaction(()=>this.db.exec(migration3));
    if(version>0&&version<4){const backupPath=join(dataDir,'jobpilot.pre-m3.1.sqlite');if(!existsSync(backupPath)){this.db.prepare('VACUUM INTO ?').run(backupPath);chmodSync(backupPath,0o600);}}
    if(version<4)this.transaction(()=>this.db.exec(migration4));
    if(version>0&&version<5){const backupPath=join(dataDir,'jobpilot.pre-m4.sqlite');if(!existsSync(backupPath)){this.db.prepare('VACUUM INTO ?').run(backupPath);chmodSync(backupPath,0o600);}}
    if(version<5)this.transaction(()=>this.db.exec(migration5));
    const chatUncertain=this.db.prepare("UPDATE chat_outbox SET state='NEEDS_VERIFY',version=version+1,detail='回复期间进程中断，禁止自动重发。' WHERE state='SENDING'").run();
    if(chatUncertain.changes)this.setSetting('sendEmergencyStop',true);
    if (!this.getSetting('config')) this.setSetting('config', {version: 1, llm: null, bossReadOnlyConsent: false});
    if (!this.getSearch()) this.saveSearch({id: 'primary', name: 'iOS 搜索方案', keyword: 'iOS', searchUrl: '', maxJobs: 20});
    if (!this.getSetting('resumeVersion')) this.setSetting('resumeVersion', 1);
    const uncertain=this.db.prepare("UPDATE send_outbox SET state='NEEDS_VERIFY',version=version+1,verify_detail='进程在发送期间中断，禁止自动重发。' WHERE state='SENDING'").run();
    if(uncertain.changes)this.setSetting('sendEmergencyStop',true);
    this.db.prepare("UPDATE runs SET needs_verify_count=((SELECT count(*) FROM send_outbox WHERE run_id=runs.id AND state='NEEDS_VERIFY')+(SELECT count(*) FROM chat_outbox WHERE run_id=runs.id AND state='NEEDS_VERIFY')) WHERE kind IN ('send','chat')").run();
    this.db.prepare('UPDATE send_authorizations SET revoked_at=? WHERE revoked_at IS NULL').run(now());
    const interrupted = this.db.prepare("SELECT id FROM runs WHERE state IN ('DISCOVERING','ANALYZING','DRAFTING','PREFLIGHT','SENDING','VERIFYING')").all() as Row[];
    for (const row of interrupted) {
      this.finishRun(row.id, 'NEEDS_HUMAN', 'WORKER_INTERRUPTED');
      this.event(row.id, 'WORKER_INTERRUPTED', '上次任务被中断，已保存结果；请检查后手动重新运行。');
    }
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key=?').get(key) as Row | undefined;
    return row ? JSON.parse(row.value_json) : null;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at').run(key, JSON.stringify(value), now());
  }
  config() { const value=this.getSetting<AppConfig>('config')!;return {...value,llmEnvPath:value.llmEnvPath??null}; }
  updateConfig(update: Partial<Pick<AppConfig, 'llm' | 'bossReadOnlyConsent' | 'llmEnvPath'>>) {
    const config = {...this.config(), ...update, version: this.config().version + 1};
    this.transaction(() => {
      if (JSON.stringify(config.llm) !== JSON.stringify(this.config().llm)) this.invalidate();
      this.setSetting('config', config);
    }); return config;
  }
  resume(): ResumeState {
    const rows = this.db.prepare('SELECT * FROM resume_facts WHERE deleted=0 ORDER BY rowid').all() as Row[];
    const facts: ResumeFact[] = rows.map(row => ({id: row.id, text: row.text, category: row.category, source: JSON.parse(row.source_json), approved: Boolean(row.approved), version: row.version, updatedAt: row.updated_at}));
    return {version: this.getSetting<number>('resumeVersion')!, frozenVersion: this.getSetting<number>('frozenVersion'), facts, approvedCount: facts.filter(f => f.approved).length};
  }
  private bumpResume() {
    const version = (this.getSetting<number>('resumeVersion') ?? 1) + 1;
    this.setSetting('resumeVersion', version); this.setSetting('frozenVersion', null);
    this.invalidate();
    return version;
  }
  importFacts(file: string, hash: string, facts: PendingFact[]) {
    if (this.db.prepare('SELECT id FROM resume_imports WHERE content_hash=?').get(hash)) throw new AppError('RESUME_ALREADY_IMPORTED', '该文件已导入，可在事实库逐条审核或修改。');
    if (this.resume().facts.length + facts.length > 500) throw new AppError('FACT_LIMIT', '事实库最多保留 500 条，请先整理现有事实。');
    if ([...this.resume().facts,...facts].reduce((n,fact)=>n+fact.text.length+fact.source.quote.length,0)>350000) throw new AppError('FACT_LIMIT', '事实文本总量过大，请先整理现有事实。');
    this.transaction(() => {
      this.bumpResume();
      this.db.prepare('INSERT INTO resume_imports VALUES(?,?,?,?)').run(randomUUID(), file, hash, now());
      const insert = this.db.prepare('INSERT INTO resume_facts VALUES(?,?,?,?,0,1,0,?)');
      for (const fact of facts) insert.run(randomUUID(), fact.text, fact.category, JSON.stringify(fact.source), now());
    });
    return this.resume();
  }
  updateFact(input: {id: string; expectedVersion: number; text?: string; category?: string; approved?: boolean; deleted?: boolean}) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM resume_facts WHERE id=? AND deleted=0').get(input.id) as Row | undefined;
      if (!row) throw new AppError('FACT_NOT_FOUND', '事实不存在。');
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', '事实已被更新，请刷新后重新审核。');
      const changed = (input.text !== undefined && input.text !== row.text) || (input.category !== undefined && input.category !== row.category);
      if (this.resume().facts.reduce((n,fact)=>n+fact.text.length+fact.source.quote.length,0)-row.text.length+(input.text??row.text).length>350000) throw new AppError('FACT_LIMIT','事实文本总量过大。');
      // Editing always invalidates approval. A separate explicit review is required.
      const approved = changed || input.deleted ? false : (input.approved ?? Boolean(row.approved));
      this.db.prepare('UPDATE resume_facts SET text=?,category=?,approved=?,version=version+1,deleted=?,updated_at=? WHERE id=?').run(input.text ?? row.text, input.category ?? row.category, approved ? 1 : 0, input.deleted ? 1 : 0, now(), input.id);
      this.bumpResume();
    });
    return this.resume();
  }
  freezeResume(expectedVersion: number) {
    const state = this.resume();
    if (state.version !== expectedVersion) throw new AppError('VERSION_CONFLICT', '事实库已更新，请刷新后重试。');
    const approved = state.facts.filter(f => f.approved);
    if (!approved.length) throw new AppError('NO_APPROVED_FACTS', '请先逐条确认事实。');
    this.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO resume_snapshots VALUES(?,?,?)').run(state.version, JSON.stringify(approved), now());
      this.setSetting('frozenVersion', state.version);
    });
    return this.resume();
  }
  frozenFacts(expectedVersion?: number): {version: number; facts: ResumeFact[]} {
    const state = this.resume();
    if (state.frozenVersion !== state.version || !state.approvedCount) throw new AppError('RESUME_NOT_FROZEN', '请先逐条确认简历事实并冻结当前版本。');
    if (expectedVersion !== undefined && expectedVersion !== state.version) throw new AppError('VERSION_CONFLICT', '请求的简历版本已失效，请刷新后重试。');
    const row = this.db.prepare('SELECT facts_json FROM resume_snapshots WHERE version=?').get(state.version) as Row;
    return {version: state.version, facts: JSON.parse(row.facts_json)};
  }
  invalidate(jobId?: string) {
    const clause = jobId ? ' WHERE job_id=?' : '';
    const args = jobId ? [jobId] : [];
    this.db.prepare(`UPDATE analysis_results SET cache_key=CASE WHEN stale=0 THEN cache_key || ':stale:' || id ELSE cache_key END,stale=1${clause}`).run(...args);
    this.db.prepare(`UPDATE greeting_drafts SET stale=1,audit_status='INVALIDATED'${clause}`).run(...args);
    this.db.prepare(`UPDATE review_queue SET state='STALE',version=version+1,reviewed_at=NULL${clause}`).run(...args);
  }
  getSearch(): SearchProfileData | null {
    const row = this.db.prepare("SELECT filters_json FROM search_profiles WHERE id='primary'").get() as Row | undefined;
    return row ? JSON.parse(row.filters_json) : null;
  }
  saveSearch(profile: SearchProfileData) {
    this.db.prepare('INSERT INTO search_profiles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,filters_json=excluded.filters_json,updated_at=excluded.updated_at').run(profile.id, profile.name, JSON.stringify(profile), now());
    return profile;
  }
  upsertJob(job: JobRecord) {
    const existing = this.getJob(job.id);
    if (existing && !job.jdText) { job.jdText = existing.jdText; job.jdHash = existing.jdHash; }
    if (existing && (existing.jdHash !== job.jdHash || existing.title !== job.title || existing.company !== job.company || existing.city !== job.city || existing.salary !== job.salary || (!existing.alreadyContacted && job.alreadyContacted))) this.invalidate(job.id);
    job.alreadyContacted ||= existing?.alreadyContacted ?? false;
    this.db.prepare(`INSERT INTO jobs(id,platform_job_id,recruiter_id,source,title,company,salary,city,experience,education,url,jd_text,jd_hash,fetched_at,snapshot,already_contacted)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET recruiter_id=COALESCE(excluded.recruiter_id,jobs.recruiter_id),title=excluded.title,company=excluded.company,salary=excluded.salary,city=excluded.city,experience=excluded.experience,education=excluded.education,url=excluded.url,jd_text=excluded.jd_text,jd_hash=excluded.jd_hash,fetched_at=excluded.fetched_at,snapshot=excluded.snapshot,already_contacted=excluded.already_contacted`).run(job.id, job.platformJobId, job.recruiterId, job.source, job.title, job.company, job.salary, job.city, job.experience, job.education, job.url, job.jdText, job.jdHash, job.fetchedAt, job.snapshot, job.alreadyContacted ? 1 : 0);
    return !existing;
  }
  private job(row: Row): JobRecord {
    return {id: row.id, platformJobId: row.platform_job_id, recruiterId: row.recruiter_id, source: row.source, title: row.title, company: row.company, salary: row.salary, city: row.city, experience: row.experience, education: row.education, url: row.url, jdText: row.jd_text, jdHash: row.jd_hash, fetchedAt: row.fetched_at, snapshot: row.snapshot, alreadyContacted: Boolean(row.already_contacted)};
  }
  getJob(id: string) { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined; return row ? this.job(row) : null; }
  listJobs(query: {source?: JobSource; query?: string; status?: string; minScore?: number; limit: number; offset: number}) {
    const from = `FROM jobs j LEFT JOIN analysis_results a ON a.id=(SELECT id FROM analysis_results WHERE job_id=j.id AND stale=0 ORDER BY created_at DESC,rowid DESC LIMIT 1)`;
    const where = `WHERE (? IS NULL OR j.source=?) AND (? IS NULL OR instr(lower(j.title || j.company || j.city),lower(?))>0)
      AND (? IS NULL OR COALESCE(json_extract(a.report_json,'$.decision'),'UNASSESSED')=?) AND (? IS NULL OR json_extract(a.report_json,'$.score')>=?)`;
    const args = [query.source ?? null, query.source ?? null, query.query || null, query.query || null, query.status ?? null, query.status ?? null, query.minScore ?? null, query.minScore ?? null];
    const rows = this.db.prepare(`SELECT j.*,a.report_json ${from} ${where} ORDER BY j.fetched_at DESC,j.id LIMIT ? OFFSET ?`).all(...args, query.limit, query.offset) as Row[];
    const total = Number((this.db.prepare(`SELECT count(*) AS n ${from} ${where}`).get(...args) as Row).n);
    return {items: rows.map(row => ({...this.job(row), assessment: row.report_json ? JSON.parse(row.report_json) : null})), total};
  }
  createRun(source: JobSource) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO runs(id,profile_id,mode,source,state,started_at) VALUES(?,'primary','preview',?,'DISCOVERING',?)").run(id, source, now());
    return this.getRun(id)!;
  }
  private run(row: Row): RunRecord { return {id: row.id, profileId: row.profile_id, mode: row.execution_mode, source: row.source, kind: row.kind, state: row.state, discoveredCount: row.discovered_count, processedCount: row.processed_count, draftedCount: row.drafted_count, skippedCount: row.skipped_count, sentCount:row.sent_count,needsVerifyCount:row.needs_verify_count,startedAt: row.started_at, finishedAt: row.finished_at, errorCode: row.error_code}; }
  getRun(id: string) { const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined; return row ? this.run(row) : null; }
  listRuns() { return (this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 50').all() as Row[]).map(row => this.run(row)); }
  incrementRun(id: string) { this.db.prepare('UPDATE runs SET discovered_count=discovered_count+1 WHERE id=?').run(id); }
  finishRun(id: string, state: RunRecord['state'], errorCode: string | null = null) { this.db.prepare('UPDATE runs SET state=?,error_code=?,finished_at=? WHERE id=?').run(state, errorCode, now(), id); }
  event(runId: string, type: string, message: string, traceId = randomUUID()) {
    this.db.prepare('INSERT INTO run_events(run_id,trace_id,event_type,message,created_at) VALUES(?,?,?,?,?)').run(runId, traceId, type, redact(message).slice(0, 1000), now());
  }
  events(runId: string): RunEvent[] { return (this.db.prepare('SELECT * FROM run_events WHERE run_id=? ORDER BY id DESC LIMIT 100').all(runId) as Row[]).map(row => ({id: row.id, runId: row.run_id, traceId: row.trace_id, type: row.event_type, message: row.message, createdAt: row.created_at})); }
  dashboard(): Dashboard {
    const count = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return {totalJobs: count('SELECT count(*) n FROM jobs'), bossJobs: count("SELECT count(*) n FROM jobs WHERE source='boss'"), demoJobs: count("SELECT count(*) n FROM jobs WHERE source='demo'"), approvedFacts: count('SELECT count(*) n FROM resume_facts WHERE deleted=0 AND approved=1'), pendingFacts: count('SELECT count(*) n FROM resume_facts WHERE deleted=0 AND approved=0'), lastRun: this.listRuns()[0] ?? null};
  }
  close() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); }
}
