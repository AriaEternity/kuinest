import type { Claim } from "./types.js";
import { RunFailure } from "./types.js";
export function boundary(claim: Claim): string {
  const id = claim.contextBoundaryId ?? claim.contextUserEntryId;
  if (!id) throw new RunFailure("CONTEXT_INVALID"); return id;
}
