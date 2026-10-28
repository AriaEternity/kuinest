import { StringDecoder } from "node:string_decoder";
import { StorageError } from "../storage/errors.js";
export interface TerminalInput {
  isTTY?: boolean; isRaw?: boolean;
  setRawMode(mode: boolean): unknown; resume(): unknown; pause(): unknown;
  on(event: "data", handler: (chunk: Buffer | string) => void): unknown;
  on(event: "end" | "error", handler: (error?: Error) => void): unknown;
  removeListener(event: "end" | "error", handler: (error?: Error) => void): unknown;
  removeListener(event: "data", handler: (chunk: Buffer | string) => void): unknown;
}
export interface TerminalOutput { isTTY?: boolean; write(value: string): unknown; }
export function readTerminal(prompt: string, hidden: boolean, maximum: number, input: TerminalInput = process.stdin, output: TerminalOutput = process.stdout): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new StorageError("INTERACTIVE_TERMINAL_REQUIRED");
  output.write(prompt);
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8"), previous = input.isRaw ?? false;
    const value: string[] = [];
    let settled = false;
    const interrupted = () => finish(new StorageError("INPUT_CANCELLED"));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.removeListener("end", interrupted); input.removeListener("error", interrupted);
      input.removeListener("data", data); input.setRawMode(previous); input.pause(); output.write("\n");
      if (error) reject(error); else resolve(value.join(""));
    };
    const data = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const char of text) {
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u0003" || char === "\u0004" || char === "\u001b") { finish(new StorageError("INPUT_CANCELLED")); return; }
        if (char === "\u007f" || char === "\b") { if (value.length) { value.pop(); if (!hidden) output.write("\b \b"); } continue; }
        if (char.codePointAt(0)! < 32 || value.length >= maximum) { finish(new StorageError("INPUT_INVALID")); return; }
        value.push(char); if (!hidden) output.write(char);
      }
    };
    input.setRawMode(true); input.on("data", data); input.on("end", interrupted); input.on("error", interrupted); input.resume();
  });
}
