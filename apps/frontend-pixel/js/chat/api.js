import { ChatClient, HttpError } from '@kuinest/chat-client';
import { readContract } from '@kuinest/contracts';

export class ApiFault extends HttpError {
  constructor(status, code = '') { super(status); this.code = code; }
}
export function explain(error) {
  const known = {
    AUTH_INVALID: '账号或口令不正确。', AUTH_REQUIRED: '登录已过期，请重新登录。',
    CSRF_INVALID: '登录凭据已变化，请重新登录。', ORIGIN_FORBIDDEN: '服务拒绝了当前站点来源，请检查代理配置。',
    BACKEND_UNAVAILABLE: '无法连接聊天服务，请检查后端是否启动。', SERVICE_NOT_READY: '服务尚未准备好，请稍后重试。',
    MEMORY_REVIEW_CONFLICT: '这条候选已发生变化。请重新读取，再决定是否保存或确认。',
    MEMORY_REVIEW_LIMIT: '记忆候选或已确认记忆已达到后端限额。',
    CONVERSATION_BUSY: '会话仍在回复。请先停止回复或等待结束，再删除。',
    NOT_FOUND: '这段会话已不存在，请刷新会话列表。',
    IDEMPOTENCY_CONFLICT: '原消息标识与内容冲突，请先对账。', RATE_LIMITED: '操作较频繁，请稍后再试。', QUEUE_FULL: '回复队列已满，请稍后再试。',
    STREAM_RECOVERY_EXHAUSTED: '连接恢复暂未成功，运行状态待确认。', PUBLIC_CONTRACT_INVALID: '服务返回的数据与当前接口合同不一致。',
    HTTP_401: '登录已过期，请重新登录。', HTTP_403: '请求被拒绝，请重新登录或检查来源配置。', HTTP_503: '服务尚未准备好。', HTTP_502: '无法连接聊天服务。',
  };
  return known[error?.code] || known[error?.message] || (error?.status === 429 ? '操作较频繁，请稍后再试。' : '操作未能确认，请检查连接后重试。');
}
export class Api {
  constructor(transport = fetch) {
    this.request = async (url, options = {}) => {
      const isStream = String(url).includes('/events');
      const signal = isStream ? options.signal : options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      const response = await transport(url, { ...options, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (!response.ok) {
        let code = '';
        try { const body = await response.json(); code = body?.error?.code || ''; } catch {}
        throw new ApiFault(response.status, code);
      }
      return response;
    };
    this.chat = new ChatClient('/api/v1', this.request);
  }
  async call(path, { method = 'GET', body, csrf, schema, signal } = {}) {
    const response = await this.request('/api/v1' + path, { method, ...(signal ? { signal } : {}),
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 204) return;
    if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error('PUBLIC_CONTRACT_INVALID');
    const text = await response.text();
    if (text.length > 16 * 1024 * 1024) throw new Error('JSON_RESPONSE_TOO_LARGE');
    const value = JSON.parse(text);
    return schema ? readContract(schema, value) : value;
  }
  session(signal) { return this.call('/auth/session', { schema: 'authSession', signal }); }
  login(username, password) { return this.call('/auth/login', { method: 'POST', body: { username, password }, schema: 'authSession' }); }
  logout(csrf) { return this.call('/auth/logout', { method: 'POST', body: {}, csrf }); }
  conversations(cursor, signal) { return this.call('/conversations' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { schema: 'conversationPage', signal }); }
  create(title, csrf) { return this.call('/conversations', { method: 'POST', body: title ? { title } : {}, csrf, schema: 'publicConversation' }); }
  async cancel(id, csrf) {
    const result = await this.call('/runs/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: {}, csrf });
    return result.accepted === true ? readContract('cancelAccepted', result).run : readContract('runSnapshot', result);
  }
  proposals(conversation, cursor) { return this.call('/conversations/' + encodeURIComponent(conversation) + '/memory-proposals' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { schema: 'memoryProposalPage' }); }
  propose(conversation, input, csrf) { return this.call('/conversations/' + encodeURIComponent(conversation) + '/memory-proposals', { method: 'POST', body: input, csrf, schema: 'memoryProposal' }); }
  proposal(id) { return this.call('/memory-proposals/' + encodeURIComponent(id), { schema: 'memoryProposal' }); }
  edit(item, content, csrf) { return this.call('/memory-proposals/' + encodeURIComponent(item.id), { method: 'PATCH', body: { revision: item.revision, contentSha256: item.contentSha256, content }, csrf, schema: 'memoryProposal' }); }
  decide(item, action, csrf) { return this.call('/memory-proposals/' + encodeURIComponent(item.id) + '/' + action, { method: 'POST', body: { revision: item.revision, contentSha256: item.contentSha256 }, csrf, schema: 'memoryProposal' }); }
}
