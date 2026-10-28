import type { MemoryProposal, MemoryProposalPage } from "./memory.js";
import { schemas } from "./schemas/index.js";
import type { PublicConversation, RenameConversationRequest, ConversationMessage, RunEvent, RunSnapshot, HistoryPage, MessageChanges, ApiMeta, ImageAttachment, AcceptedSubmission, SubmitMessageRequest, SubmissionLookup, KuiSenseContextPacket, KuiSenseUploadReceipt } from "./index.js";

// 仅解释仓库内固定合同；不执行外部 schema，也不接受任意 schema 输入。
type Shape = Record<string, unknown>;
function matches(schema: Shape, value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  const again = (shape: unknown, item: unknown) => matches(shape as Shape, item, depth + 1);
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("urn:kuinest:0.3:", "").replace(/#$/, "");
    const target = Object.hasOwn(schemas, name) ? schemas[name as keyof typeof schemas] : undefined;
    return !!target && again(target, value);
  }
  if (Array.isArray(schema.oneOf)) return schema.oneOf.filter(s => again(s, value)).length === 1;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some(s => again(s, value));
  if (Object.hasOwn(schema, "const") && (typeof schema.const === "object" ? JSON.stringify(value) !== JSON.stringify(schema.const) : value !== schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isSafeInteger(value)
      && (schema.minimum === undefined || value >= Number(schema.minimum))
      && (schema.maximum === undefined || value <= Number(schema.maximum));
    case "string": return typeof value === "string"
      && (schema.minLength === undefined || [...value].length >= Number(schema.minLength))
      && (schema.maxLength === undefined || [...value].length <= Number(schema.maxLength))
      && (schema.pattern === undefined || new RegExp(String(schema.pattern)).test(value));
    case "array": return Array.isArray(value)
      && (schema.minItems === undefined || value.length >= Number(schema.minItems))
      && (schema.maxItems === undefined || value.length <= Number(schema.maxItems))
      && (schema.uniqueItems !== true || new Set(value.map(item => JSON.stringify(item))).size === value.length)
      && value.every(item => again(schema.items, item));
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>, properties = schema.properties as Shape;
      if ((schema.required as string[]).some(key => !Object.hasOwn(object, key))) return false;
      return Object.keys(object).every(key => Object.hasOwn(properties, key) ? again(properties[key], object[key]) : schema.additionalProperties === true);
    }
    default: return Object.hasOwn(schema, "const") || Array.isArray(schema.enum);
  }
}
interface PublicTypes {
  publicConversation: PublicConversation; renameConversationRequest: RenameConversationRequest;
  memoryProposal: MemoryProposal; memoryProposalPage: MemoryProposalPage;
  runEvent: RunEvent; runSnapshot: RunSnapshot; conversationMessage: ConversationMessage;
  historyPage: HistoryPage; messageChanges: MessageChanges;
  apiMeta: ApiMeta; imageAttachment: ImageAttachment; acceptedSubmission: AcceptedSubmission; submissionLookup: SubmissionLookup; submitMessageRequest: SubmitMessageRequest;
  kuisenseContextPacket: KuiSenseContextPacket; kuisenseUploadReceipt: KuiSenseUploadReceipt;
}
export function readContract<K extends keyof PublicTypes>(name: K, value: unknown): PublicTypes[K] {
  if (!matches(schemas[name], value)) throw new Error("PUBLIC_CONTRACT_INVALID");
  return value as PublicTypes[K];
}
