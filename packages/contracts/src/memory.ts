// 候选正文只交付已认证的所属用户；普通日志与工程报告不得记录。
export interface MemoryProposal {
 id: string; characterId: string; revision: number; content: string; contentSha256: string;
 status: "pending" | "confirmed" | "rejected"; source: "user" | "tool";
 createdAt: string; updatedAt: string; decidedAt: string | null; memoryKey: string | null;
}
export interface MemoryProposalPage { items: MemoryProposal[]; nextCursor: string | null; }
export interface ProposeMemoryRequest { clientRequestId: string; content: string; }
export interface ReviewMemoryRequest { revision: number; contentSha256: string; }
export interface EditMemoryRequest extends ReviewMemoryRequest { content: string; }
