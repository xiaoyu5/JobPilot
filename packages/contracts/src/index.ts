import { z } from 'zod';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const RpcRequest = z.object({
  jsonrpc: z.literal('2.0'), requestId: z.string().uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  guiToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  action: z.enum(['status', 'browser.open', 'browser.close', 'llm.test', 'run.start', 'shutdown',
    'config.get', 'config.validate', 'config.update', 'resume.import', 'resume.list', 'resume.add', 'resume.update', 'resume.freeze',
    'search.get', 'search.save', 'jobs.list', 'jobs.get', 'jobs.read', 'boss.login.open', 'boss.login.status',
    'run.list', 'run.get', 'run.pause', 'demo.load', 'dashboard.get', 'boss.diagnostics',
    'policy.get', 'policy.save', 'analysis.get', 'analysis.analyze', 'draft.generate', 'draft.update',
    'queue.list', 'queue.add', 'queue.review', 'queue.remove', 'dryrun.start', 'llm.env.load','llm.env.save',
    'send.status','send.policy.save','send.auto.set','send.prepare','send.commit','send.stop','send.resume',
    'send.outbox','send.verify','send.resolve','send.reset','send.cancel','send.checkpoint','boss.communication.inspect','chat.open','chat.scan','chat.list','chat.prepare','chat.commit','chat.auto.set','chat.auto.tick','chat.outbox','chat.resolve',
    'outcomes.list','outcomes.update','stats.get','diagnostics.export','data.status','data.backup','data.restore.prepare','data.restore.commit','data.reset','data.cleanup.preview','data.cleanup.commit','data.retention.save','data.operation.cancel',
    'notifications.status','notifications.save','notifications.test','notifications.check']),
  payload: z.unknown().optional(),
}).strict();
export type Request = z.infer<typeof RpcRequest>;
export type Envelope<T = unknown> = {
  ok: boolean; data: T | null; error: {code: string; message: string} | null;
  runId: string | null; traceId: string;
};
export const LlmConfig = z.object({
  baseUrl: z.string().url().max(2048), model: z.string().trim().min(1).max(200),
  apiKey: z.string().max(4096).optional(),
  timeoutMs: z.number().int().min(100).max(60000).default(60000),
  allowLan: z.boolean().default(false),
}).strict();
export type LlmConfiguration = z.infer<typeof LlmConfig>;
export const LlmSettings = LlmConfig.omit({apiKey: true}).strict();
export const ConfigUpdate = z.object({llm: LlmSettings.optional(), bossReadOnlyConsent: z.boolean().optional()}).strict();
export type AppConfig = {version: number; llm: z.infer<typeof LlmSettings> | null; llmEnvPath: string|null; bossReadOnlyConsent: boolean};
export const NotificationPreferences=z.object({enabled:z.boolean(),queueReview:z.boolean().default(true),chatReview:z.boolean().default(true),taskAttention:z.boolean().default(true)}).strict();
export const NotificationSave=NotificationPreferences.extend({webhookUrl:z.string().trim().max(2048).optional(),clearWebhook:z.boolean().default(false)}).strict();
export type NotificationSettings=z.infer<typeof NotificationPreferences>;
export type NotificationStatus={settings:NotificationSettings;configured:boolean;error:string|null;pending:{queue:number;chats:number;verification:number;tasks:number};lastAttemptAt:string|null;lastDeliveredAt:string|null;lastError:string|null;retryAt:string|null;busy:boolean};
export const FactCategory = z.enum(['skill', 'experience', 'project', 'education', 'other']);
export type FactCategoryName = z.infer<typeof FactCategory>;
export type FactSource = {file: string; kind: 'docx' | 'pdf' | 'text'; page?: number; paragraph: number; quote: string};
export type PendingFact = {text: string; category: FactCategoryName; source: FactSource};
export type ResumeFact = PendingFact & {id: string; approved: boolean; version: number; updatedAt: string};
export type ResumeState = {version: number; frozenVersion: number | null; facts: ResumeFact[]; approvedCount: number};
export const ResumeImport = z.object({path: z.string().min(1).max(4096)}).strict();
export const FactAdd = z.object({expectedVersion:z.number().int().min(1),text:z.string().trim().min(5).max(2000),category:FactCategory.default('skill'),sourceQuote:z.string().trim().min(1).max(4000).optional()}).strict();
export const FactUpdate = z.object({id: z.string().uuid(), expectedVersion: z.number().int().min(1), text: z.string().trim().min(1).max(2000).optional(), category: FactCategory.optional(), approved: z.boolean().optional(), deleted: z.boolean().optional()}).strict();
export const SearchProfile = z.object({id: z.literal('primary').default('primary'), name: z.string().trim().min(1).max(80), keyword: z.string().trim().min(1).max(80), searchUrl: z.string().max(2048).default(''), maxJobs: z.number().int().min(1).max(50).default(20)}).strict();
export type SearchProfileData = z.infer<typeof SearchProfile>;
export const JobListQuery = z.object({source: z.enum(['boss', 'demo']).optional(), query: z.string().max(100).optional(), status: z.enum(['UNASSESSED','SKIP_RULE','RECOMMEND','REVIEW','SKIP']).optional(), minScore: z.number().int().min(0).max(100).optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(10000).default(0)}).strict();
export type JobSource = 'boss' | 'demo';
export type JobRecord = {id: string; platformJobId: string; recruiterId: string | null; source: JobSource; title: string; company: string; salary: string; city: string; experience: string; education: string; url: string; jdText: string; jdHash: string; fetchedAt: string; snapshot: string; alreadyContacted: boolean};
export type RunRecord = {id: string; profileId: string; mode: 'preview'|'review'|'auto'; source: JobSource; kind: 'collection' | 'dry-run'|'send'|'chat'; state: 'DISCOVERING' | 'ANALYZING' | 'DRAFTING' | 'PREFLIGHT'|'SENDING'|'VERIFYING'|'COMPLETED' | 'PAUSED' | 'NEEDS_HUMAN' | 'FAILED'; discoveredCount: number; processedCount: number; draftedCount: number; skippedCount: number; sentCount: number; needsVerifyCount: number; startedAt: string; finishedAt: string | null; errorCode: string | null};
export type RunEvent = {id: number; runId: string; traceId: string; type: string; message: string; createdAt: string};
export type LoginState = {state: 'CLOSED' | 'LOGIN_REQUIRED' | 'LOGGED_IN' | 'CHALLENGE' | 'UNKNOWN'; message: string; url: string | null};
export type Dashboard = {totalJobs: number; bossJobs: number; demoJobs: number; approvedFacts: number; pendingFacts: number; lastRun: RunRecord | null};
export const StartRun = z.object({profileId: z.string().min(1).max(100), mode: z.enum(['preview', 'review', 'auto'])}).strict();
export type WorkerStatus = {
  milestone: 'M4'; pid: number; node: string; arch: string; uptimeSeconds: number;
  mode: 'preview'|'review'|'auto'; autoModeConsent: boolean; sendingAvailable: boolean;
  browser: {open: boolean; profilePath: string};
  llm: {configured: boolean; sessionReady: boolean; envPath: string; hasApiKey: boolean; error: string|null};
  dataOperationError?:{code:string;message:string}|null;
};

export const MatchingPolicy = z.object({
  cities: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  minimumSalaryK: z.number().min(0).max(1000).nullable().default(null),
  excludedCompanies: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  excludedTitles: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  excludePureBackend: z.boolean().default(true),
  recommendScore: z.number().int().min(1).max(100).default(80),
  reviewScore: z.number().int().min(0).max(99).default(60),
  greetingMin: z.number().int().min(20).max(200).default(50),
  greetingMax: z.number().int().min(30).max(300).default(100),
}).strict().refine(p => p.reviewScore < p.recommendScore && p.greetingMin <= p.greetingMax, '阈值或话术长度范围无效');
export type Policy = z.infer<typeof MatchingPolicy>;
const ShortText = z.string().trim().min(1).max(800);
export const MatchOutput = z.object({
  score: z.number().int().min(0).max(100), decision: z.enum(['RECOMMEND','REVIEW','SKIP']),
  strengths: z.array(z.object({requirement: ShortText, factId: z.string().uuid(), reason: ShortText}).strict()).max(10),
  gaps: z.array(z.object({requirement: ShortText, severity: z.enum(['soft','hard']), reason: ShortText}).strict()).max(10),
  evidenceFactIds: z.array(z.string().uuid()).max(10),
}).strict();
export type MatchReport = z.infer<typeof MatchOutput>;
export type Assessment = Omit<MatchReport,'score'|'decision'> & {
  id: string; jobId: string; score: number | null; decision: MatchReport['decision'] | 'SKIP_RULE';
  reasons: {code: string; message: string}[]; prefilter: 'candidate' | 'lowRelevance';
  source: 'rule' | 'llm'; model: string; promptVersion: string; resumeVersion: number;
  jdHash: string; contextKey: string; stale: boolean; createdAt: string;
};
export type EvidenceStatement = {id: string; factId: string; text: string};
export const GreetingPlan = z.object({
  opening: z.enum(['interest','direction']), statementIds: z.array(z.string().min(1).max(100)).min(1).max(2),
  closing: z.enum(['discuss','team']),
}).strict();
export type Draft = {id: string; jobId: string; assessmentId: string; content: string; factIds: string[]; statements: EvidenceStatement[]; resumeVersion: number; jdHash: string; model: string; promptVersion: string; version: number; manualOverride: boolean; audit: {status: 'PASS'|'BLOCK'; issues: string[]}; stale: boolean; createdAt: string};
export type QueueItem = {id: string; jobId: string; title: string; company: string; source: JobSource; draftId: string; version: number; state: 'PENDING'|'REVIEWED'|'BLOCKED'|'STALE'; createdAt: string; reviewedAt: string|null; draft: Draft; assessment: Assessment;delivery?:{id:string;state:string}};
export const AnalyzeInput = z.object({jobId: z.string().min(1).max(200), resumeVersion: z.number().int().min(1).optional()}).strict();
export const DraftInput = z.object({jobId: z.string().min(1).max(200), style: z.enum(['natural','concise']).default('natural')}).strict();
export const QueueInput = z.object({jobId: z.string().min(1).max(200), draftId: z.string().uuid()}).strict();
export const DraftUpdate = z.object({id: z.string().uuid(), expectedVersion: z.number().int().min(1), content: z.string().trim().min(1).max(1000)}).strict();
export const QueueReview = z.object({id: z.string().uuid(), expectedVersion: z.number().int().min(1)}).strict();
export const QueueList = z.object({limit:z.number().int().min(1).max(20).default(20),offset:z.number().int().min(0).max(10000).default(0)}).strict();
export const DryRunInput = z.object({source: z.enum(['boss','demo']), jobIds: z.array(z.string().min(1).max(200)).min(1).max(50).optional(), maxJobs: z.number().int().min(1).max(50).default(20)}).strict();
const TimeOfDay=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const SendPolicyInput=z.object({
  liveEnabled:z.boolean().default(false),threshold:z.number().int().min(60).max(100).default(80),
  maxPerRun:z.number().int().min(1).max(20).default(5),maxPerDay:z.number().int().min(1).max(100).default(15),
  minIntervalSeconds:z.number().int().min(15).max(3600).default(15),maxRunsPerDay:z.number().int().min(1).max(10).default(2),
  timeZone:z.string().max(80).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}}),
  startTime:TimeOfDay,endTime:TimeOfDay,
  acknowledged:z.literal(true),
}).strict().refine(p=>p.maxPerRun<=p.maxPerDay&&p.startTime!==p.endTime,'额度或允许时段无效');
export type SendPolicy={version:number;confirmed:boolean;liveEnabled:boolean;threshold:number;maxPerRun:number;maxPerDay:number;minIntervalSeconds:number;maxRunsPerDay:number;timeZone:string;startTime:string;endTime:string};
export type SendBlock={code:string;message:string};
export type ContactKind='instant-send'|'continue-chat'|'editable'|'edit-preview'|'unknown'|'ambiguous';
export type CommunicationInspection={entryKind?:ContactKind;jobId:string;recruiterId:string|null;identityBound:boolean;composerReady:boolean;canOpenPreview:boolean;alreadyContacted:boolean;message:string;url:string;adapterVersion:string};
export type SendVerification={state:'CONFIRMED'|'UNKNOWN';messageId?:string;message:string};
export type SendPlan={id:string;mode:'review';policyVersion:number;expiresAt:string;items:{queueId:string;jobId:string;title:string;company:string;recruiterId:string|null;draftId:string;draftVersion:number;content:string;deliveryKind?:'direct'|'default-then-ai';messageUnits?:number;score:number|null;blocks:SendBlock[]}[]};
export type OutboxRecord={id:string;runId:string;jobId:string;title:string;company:string;recruiterId:string;draftId:string;draftVersion:number;messageUnits:number;confirmedUnits:number;deliveryKind:'direct'|'default-then-ai';defaultPhase:string;state:'SENDING'|'SENT_CONFIRMED'|'NEEDS_VERIFY'|'MANUALLY_CONFIRMED'|'NOT_SENT'|'PARTIAL_CONFIRMED';phase:'INTENT'|'PREPARED'|'CLICK_DISPATCHED'|'CONFIRMED';policyVersion:number;resumeVersion:number;contentHash:string;content:string;createdAt:string;sentAt:string|null;detail:string;version:number};
export type SendingStatus={policy:SendPolicy;autoModeConsent:boolean;emergencyStopped:boolean;activeRunId:string|null;mode:string;budget:{usedToday:number;runsToday:number;lastIntentAt:number|null;lastActionAt:number|null};needsVerify:number};
export const SendSelection=z.object({queueIds:z.array(z.string().uuid()).min(1).max(20)}).strict();
export const SendCommit=z.object({planId:z.string().uuid(),confirmed:z.literal(true)}).strict();
export const SendResolve=z.object({id:z.string().uuid(),expectedVersion:z.number().int().min(1),result:z.enum(['sent','not-sent','default-only']),confirmed:z.literal(true)}).strict();
export class AppError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function redact(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  return result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b1[3-9]\d{9}\b/g, '[PHONE]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
}

export type ChatMessage={id:string;direction:'incoming'|'outgoing'|'system';text:string;confirmed:boolean};
export type ConversationSnapshot={id:string;recruiterId:string;recruiterAliases?:string[];jobId:string|null;name:string;company:string;url:string;identityBound:boolean;historyComplete:boolean;messages:ChatMessage[];capturedAt:string};
export type ChatState='REJECTED'|'WAITING'|'REPLY_NEEDED'|'REVIEW';
export type ChatConversation={id:string;recruiterId:string;name:string;company:string;state:ChatState;reason:string;version:number;lastInboundId:string|null;updatedAt:string};
export type ChatReplyPlan={id:string;conversationId:string;inboundId:string;content:string;factIds:string[];resumeVersion:number;expiresAt:string;blocks:SendBlock[]};

export const OutcomeList=z.object({source:z.enum(['boss','demo']).default('boss'),query:z.string().max(100).default(''),limit:z.number().int().min(1).max(50).default(20),offset:z.number().int().min(0).max(10000).default(0)}).strict();
export const OutcomeUpdate=z.object({jobId:z.string().min(1).max(200),expectedVersion:z.number().int().min(0),replied:z.boolean(),rejected:z.boolean(),interview:z.boolean(),note:z.string().trim().max(500).default('')}).strict().refine(value=>value.replied||!value.rejected&&!value.interview,'拒绝或邀面也属于对方已回复');
export type JobOutcome={jobId:string;title:string;company:string;source:JobSource;confirmedUnits:number;deliveryState:string|null;replied:boolean;rejected:boolean;interview:boolean;note:string;version:number;updatedAt:string|null};
export const StatsQuery=z.object({source:z.enum(['boss','demo']).default('boss'),days:z.union([z.literal(0),z.literal(7),z.literal(30),z.literal(90)]).default(0)}).strict();
export type ConversionStats={source:JobSource;days:number;confirmedContacts:number;confirmedMessages:number;pageConfirmedContacts:number;manuallyConfirmedContacts:number;partialContacts:number;replied:number;rejected:number;interviews:number;replyRate:number|null;interviewRate:number|null;externallyMarked:number;needsVerify:number};
export type ExportResult={path:string;bytes:number;sha256:string};
export type DataStatus={schema:number;backups:{name:string;path:string;bytes:number;createdAt:string}[];retentionDays:number;pendingOperation:'restore'|'reset'|null;operationError:{code:string;message:string}|null};
export type RestorePlan={id:string;expiresAt:string;counts:{jobs:number;facts:number;conversations:number;firstContactIntents:number;replyIntents:number};schema:number;sha256:string};
export type CleanupPlan={id:string;count:number;expiresAt:string;source:JobSource;before:string};
