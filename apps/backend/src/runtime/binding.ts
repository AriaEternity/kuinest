import { join } from "node:path";
import { hash } from "../context/profile.js";
import { object } from "../providers/messages.js";
import { requireCondition } from "../storage/errors.js";
import { privateBytes } from "./files.js";
export type RuntimeBinding={format:"kuinest-runtime-v1";owner:string;character:string;version:string;profileSha256:string;configSha256:string;documentsSha256:string};
export function digest(value: unknown): string {
  const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  return hash(JSON.stringify(stable(value)));
}
export function validateBinding(v:unknown):RuntimeBinding {
  requireCondition(object(v)&&Object.keys(v).sort().join(",")==="character,configSha256,documentsSha256,format,owner,profileSha256,version"&&v.format==="kuinest-runtime-v1","RUNTIME_BINDING_INVALID");
  for(const k of ["owner","character","version"])requireCondition(typeof v[k]==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(v[k] as string),"RUNTIME_BINDING_INVALID");
  for(const k of ["profileSha256","configSha256","documentsSha256"])requireCondition(typeof v[k]==="string"&&/^[0-9a-f]{64}$/.test(v[k] as string),"RUNTIME_BINDING_INVALID");
  return v as RuntimeBinding;
}
export function readBinding(root:string,expected:string|undefined):RuntimeBinding {
  requireCondition(typeof expected==="string"&&/^[0-9a-f]{64}$/.test(expected),"RUNTIME_BINDING_REQUIRED");
  const bytes=privateBytes(join(root,"runtime-binding.json"),16384);requireCondition(hash(bytes)===expected,"RUNTIME_BINDING_CHANGED");
  try{return validateBinding(JSON.parse(bytes.toString("utf8")));}catch{throw new Error("RUNTIME_BINDING_INVALID");}
}
