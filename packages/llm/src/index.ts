import { z } from 'zod';
import { AppError, LlmConfig, MAX_FRAME_BYTES, redact } from '@jobpilot/contracts';

export function validateEndpoint(input: unknown) {
  const config = LlmConfig.parse(input);
  const url = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AppError('VALIDATION_ERROR', 'Base URL 只能使用 HTTP(S)，且不能包含凭据、查询或片段。');
  }
  const host = url.hostname;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  const privateIp = /^10\.(\d{1,3}\.){2}\d{1,3}$/.test(host) || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!local && !(config.allowLan && privateIp)) {
    throw new AppError('ENDPOINT_NOT_ALLOWED', '默认只允许本机地址；局域网 IP 需要明确勾选授权。M0 不支持公网端点。');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return {...config, baseUrl: url.toString().replace(/\/$/, '')};
}

export async function testConnection(input: unknown, outerSignal?: AbortSignal) {
  const config = validateEndpoint(input);
  const started = Date.now();
  const secrets = [config.apiKey ?? ''];
  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  async function request(path: string, body?: unknown) {
    const signal = AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(outerSignal ? [outerSignal] : [])]);
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      signal, redirect: 'error',
    });
    const reader = response.body?.getReader();
    let text = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (reader) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_FRAME_BYTES) throw new AppError('RESPONSE_TOO_LARGE', '模型响应超过 1 MiB 上限。');
        text += decoder.decode(value, {stream: true});
      }
      text += decoder.decode();
    } finally { await reader?.cancel().catch(() => {}); }
    if (!response.ok) throw new AppError(`HTTP_${response.status}`, redact(text.slice(0, 500), secrets));
    try { return JSON.parse(text); } catch { throw new AppError('INVALID_RESPONSE', '服务未返回有效 JSON 响应。'); }
  }
  const describe = (error: unknown) => ({
    ok: false as const,
    error: error instanceof AppError ? error.code : 'LLM_UNAVAILABLE',
    detail: error instanceof AppError ? redact(error.message, secrets) : '连接失败或超时，请检查服务、地址和鉴权。',
  });
  let models: {ok: boolean; ids?: string[]; error?: string; detail?: string};
  try {
    const value = z.object({data: z.array(z.object({id: z.string()}))}).parse(await request('/models'));
    models = {ok: true, ids: value.data.slice(0, 100).map(x => redact(x.id, secrets))};
  } catch (error) { models = describe(error); }
  const content = (response: unknown) => z.object({choices: z.array(z.object({message: z.object({content: z.string()})})).min(1)}).parse(response).choices[0].message.content;
  let chat: {ok: boolean; response?: string; error?: string; detail?: string};
  try {
    const reply = content(await request('/chat/completions', {
      model: config.model, messages: [{role: 'user', content: 'Connection test. Reply with OK.'}],
      max_completion_tokens: 128, stream: false,
    }));
    if (!reply.trim()) throw new AppError('EMPTY_RESPONSE', '模型没有返回文本。');
    chat = {ok: true, response: redact(reply, secrets).slice(0, 500)};
  } catch (error) { chat = describe(error); }
  let json: {ok: boolean; responseFormatSupported: boolean | null; error?: string; detail?: string} = {ok: false, responseFormatSupported: null};
  if (chat.ok) {
    let supported: boolean | null = null;
    const body = {
      model: config.model, messages: [{role: 'user', content: 'Return ONLY this JSON object: {"ok":true}'}],
      max_completion_tokens: 128, stream: false,
    };
    try {
      let response;
      try {
        response = await request('/chat/completions', {...body, response_format: {type: 'json_object'}});
        supported = true;
      } catch (error) {
        if (!(error instanceof AppError) || !['HTTP_400', 'HTTP_422'].includes(error.code)) throw error;
        supported = false;
        response = await request('/chat/completions', body);
      }
      z.object({ok: z.literal(true)}).strict().parse(JSON.parse(content(response)));
      json = {ok: true, responseFormatSupported: supported};
    } catch (error) { json = {...describe(error), responseFormatSupported: supported}; }
  }
  return {healthy: chat.ok && json.ok, models, chat, json, elapsedMs: Date.now() - started};
}

/** A compatible endpoint may not implement JSON mode. Always validate locally; one repair only. */
export async function completeJson<T>(input: unknown, system: string, data: unknown, schema: z.ZodType<T>, outerSignal?: AbortSignal, semantic?: (value: T) => void): Promise<T> {
  const config = validateEndpoint(input);
  const signal = AbortSignal.any([AbortSignal.timeout(config.timeoutMs * 3), ...(outerSignal ? [outerSignal] : [])]);
  const headers: Record<string,string> = {'Content-Type':'application/json'};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  let jsonMode = true, attempts = 0, repaired = false, failure = '结构或证据校验失败';
  const messages = [{role:'system',content:system+'\n输出必须匹配此 JSON Schema（字段类型严格，不能把数字写成字符串）：\n'+JSON.stringify(z.toJSONSchema(schema))}, {role:'user',content:JSON.stringify(data)}];
  while (attempts++ < 3) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method:'POST',headers,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(config.timeoutMs)]),
        body:JSON.stringify({model:config.model,messages,stream:false,max_completion_tokens:2048,...(jsonMode?{response_format:{type:'json_object'}}:{})}),
      });
    } catch { signal.throwIfAborted(); throw new AppError('LLM_UNAVAILABLE','模型连接失败或超时，请检查 Cockpit 服务。'); }
    if (!response.ok) {
      await response.body?.cancel();
      if (jsonMode && [400,422].includes(response.status)) { jsonMode = false; continue; }
      throw new AppError('LLM_UNAVAILABLE',`模型服务返回 HTTP ${response.status}，请检查地址、模型和鉴权。`);
    }
    const reader = response.body?.getReader(); let raw = '', bytes = 0; const decoder = new TextDecoder();
    try {
      while (reader) {
        const {done,value} = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_FRAME_BYTES) throw new AppError('LLM_RESPONSE_TOO_LARGE','模型响应超过大小上限。');
        raw += decoder.decode(value,{stream:true});
      }
      raw += decoder.decode();
    } catch (error) { if (error instanceof AppError) throw error; signal.throwIfAborted(); throw new AppError('LLM_UNAVAILABLE','读取模型响应失败或超时。'); }
    finally { await reader?.cancel().catch(()=>{}); }
    try {
      const envelope = z.object({choices:z.array(z.object({message:z.object({content:z.string().min(1).max(50000),refusal:z.string().nullable().optional()}),finish_reason:z.string().nullable().optional()})).min(1)}).parse(JSON.parse(raw));
      const choice = envelope.choices[0];
      if (choice.message.refusal || (choice.finish_reason && choice.finish_reason !== 'stop')) throw new AppError('LLM_INCOMPLETE','模型拒绝或未完整生成响应');
      const value = schema.parse(JSON.parse(choice.message.content));
      semantic?.(value);
      return value;
    } catch (error) {
      failure=error instanceof z.ZodError?'JSON 字段校验失败：'+error.issues.slice(0,3).map(issue=>issue.path.join('.')||'root').join('、'):error instanceof SyntaxError?'内容不是有效 JSON':error instanceof AppError?error.message:'事实引用与已确认文本不一致';
      if (repaired || attempts >= 3) break;
      repaired = true;
      // Do not echo an untrusted completion, private text, or provider errors into repair prompts/logs.
      messages.push({role:'user',content:`上一响应未通过校验：${failure}。请按 JSON Schema 修复字段类型，重新依据原始数据和全部约束返回完整 JSON；引用只能来自给定 ID，不要代码围栏或额外字段。`});
    }
  }
  throw new AppError('LLM_INVALID_OUTPUT',`模型输出在一次修复后仍未通过校验（${failure}），转人工审核。`);
}
