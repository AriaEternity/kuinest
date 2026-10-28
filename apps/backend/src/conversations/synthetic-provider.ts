import { requestImages } from "../images/content.js";
import { RunFailure } from "./types.js";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderAdapter } from "../ports.js";
// 只证明本地运行链路；没有人格或外部模型，不复制用户输入来冒充理解。
export const syntheticProvider: ProviderAdapter = {
  async *stream(_request, signal) {
    if (requestImages(_request.messages).length) throw new RunFailure("PROFILE_INVALID");
    for (const text of ["【合成演示】", "这是一条本地测试回复，", "用于验证消息队列、保存与恢复。"]) {
      await delay(20, undefined, { signal }); yield { type: "text_delta", text };
    }
    yield { type: "finish", reason: "stop" };
  },
};
