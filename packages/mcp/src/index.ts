import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { AppError, AnalyzeInput, DraftInput, DryRunInput, QueueInput, JobListQuery, StartRun, type Envelope } from '@jobpilot/contracts';

type McpAction = 'status' | 'run.start' | 'jobs.list' | 'run.get' | 'run.pause' | 'analysis.analyze' | 'draft.generate' | 'queue.add' | 'dryrun.start';

export function startMcp(call: (action: McpAction, payload?: unknown) => Promise<Envelope>) {
  return serveStdio(() => {
    const server = new McpServer({name: 'jobpilot', version: '0.4.4'});
    const invoke = async (action: McpAction, payload?: unknown) => {
      let result: Envelope;
      try { result = await call(action, payload); }
      catch (error) {
        result = {ok: false, data: null, runId: null, traceId: crypto.randomUUID(), error: {
          code: error instanceof AppError ? error.code : 'WORKER_OFFLINE', message: '请先启动 JobPilot；MCP 不会启动第二个 Worker。',
        }};
      }
      return {content: [{type: 'text' as const, text: JSON.stringify(result)}], isError: !result.ok};
    };
    server.registerTool('jobpilot.status', {
      description: '读取唯一 Worker 的本机状态。不会启动浏览器或发送消息。', inputSchema: z.object({}).strict(),
      annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    }, () => invoke('status'));
    server.registerTool('jobpilot.start_run', {
      description: 'preview 只读采集；Auto 仅在 GUI 已为当前会话授权后，按已保存限制处理真实队列。MCP 不能授予授权。',
      inputSchema: StartRun,
    }, payload => invoke('run.start', payload));
    server.registerTool('jobpilot.search', {description: '按已保存方案采集职位与 JD；只读，不发送消息。', inputSchema: z.object({searchProfileId: z.literal('primary'), maxJobs: z.number().int().min(1).max(50).default(20)}).strict()}, args => invoke('run.start', {profileId: args.searchProfileId, maxJobs: args.maxJobs, mode: 'preview'}));
    server.registerTool('jobpilot.list_jobs', {description: '分页读取本机岗位池；演示数据有独立来源标记。', inputSchema: JobListQuery, annotations: {readOnlyHint: true}}, args => invoke('jobs.list', args));
    server.registerTool('jobpilot.analyze', {description:'使用已冻结的已确认事实匹配岗位；向用户配置的模型端点发送必要 JD 和事实。复用缓存，不发送消息。',inputSchema:AnalyzeInput},args=>invoke('analysis.analyze',args));
    server.registerTool('jobpilot.draft_greeting', {description:'为当前匹配生成有事实依据的中文草稿并审计；不会发送。',inputSchema:DraftInput},args=>invoke('draft.generate',args));
    server.registerTool('jobpilot.queue', {description:'将通过审计的当前草稿加入本地待审核队列；不授权发送。',inputSchema:QueueInput},args=>invoke('queue.add',args));
    server.registerTool('jobpilot.dry_run', {description:'对本机岗位池执行规则、匹配、草稿与本地排队。来源隔离，最多50条，绝不操作浏览器或发送。',inputSchema:DryRunInput},args=>invoke('dryrun.start',args));
    server.registerTool('jobpilot.get_run', {description: '读取本地任务进度与脱敏事件。', inputSchema: z.object({runId: z.string().uuid()}).strict(), annotations: {readOnlyHint: true}}, args => invoke('run.get', {id: args.runId}));
    server.registerTool('jobpilot.pause_run', {description: '请求暂停现有任务；已经提交的动作不可撤回，不确定发送须人工核验。', inputSchema: z.object({runId: z.string().uuid()}).strict()}, args => invoke('run.pause', {id: args.runId}));
    return server;
  });
}
