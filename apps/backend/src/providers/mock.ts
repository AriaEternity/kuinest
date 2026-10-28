import { requestImages } from "../images/content.js";
import { RunFailure } from "../conversations/types.js";
import type { ProviderAdapter } from "../ports.js";
import { syntheticProvider } from "../conversations/synthetic-provider.js";
// 默认应用仍是确定性合成回复；复杂、损坏与超时场景由合成HTTP测试脚本提供。
export const mockProvider: ProviderAdapter = {
  description: Object.freeze({ provider: "mock", model: "synthetic", maxTokens: 32768 }),
  async *stream(request, signal) {
    if (requestImages(request.messages).length) throw new RunFailure("PROFILE_INVALID");
    yield { type: "reasoning_delta", text: "仅为合成协议归档标记，不是角色思考内容。" };
    if (request.options.purpose === "compaction") {
      const sourceIds = request.options.sourceEntryIds;
      yield { type: "text_delta", text: JSON.stringify({ text: "【合成摘要】历史仅用于工程验证；原始记录与来源ID保留。", sourceIds }) };
      yield { type: "finish", reason: "stop" };
    } else yield* syntheticProvider.stream(request, signal);
    yield { type: "usage", inputTokens: 1, outputTokens: 1, details: { synthetic: true } };
  },
};
