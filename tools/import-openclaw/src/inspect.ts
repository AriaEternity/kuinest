import { analyze, summary } from "./validate.js";
import { loadBundle } from "./capture.js";
export function inspect(input: string) { return summary(analyze(loadBundle(input))); }
