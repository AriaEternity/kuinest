import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { dirname, parse, relative, join, sep } from "node:path";
import { localPath } from "../storage/paths.js";
import { requireCondition } from "../storage/errors.js";

// Windows mode位不能代表ACL；只接受当前账户和SYSTEM的权限，不打印主体或路径。
export function privatePath(path: string, directory = false): string {
  const full = localPath(path);
  let current=parse(full).root;
  for(const part of relative(current,full).split(sep).filter(Boolean)){current=join(current,part);const st=lstatSync(current);requireCondition(!st.isSymbolicLink()&&(current===full?(directory?st.isDirectory():st.isFile()&&st.nlink===1):st.isDirectory()),"PRIVATE_PATH_UNSAFE");}
  const real=realpathSync(full); requireCondition(process.platform==="win32"?real.toLowerCase()===full.toLowerCase():real===full,"PRIVATE_PATH_UNSAFE");
  requireCondition(![0x6969,0xff534d42,0x517b,0x564c].includes(statfsSync(directory?full:dirname(full)).type>>>0),"NETWORK_FILESYSTEM");
  if (process.platform === "win32") {
    const quoted = full.replaceAll("'", "''");
    const script = "$ErrorActionPreference='Stop'; $a=[IO."+(directory?"Directory":"File")+"]::GetAccessControl('"+quoted+"'); $s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $ok=$true; foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($s,'S-1-5-18')){$ok=$false}}; if(-not $ok){exit 2}";
    try { execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script,"utf16le").toString("base64")], { windowsHide:true, stdio:"pipe", timeout:15000 }); }
    catch { requireCondition(false,"PRIVATE_PERMISSIONS_INVALID"); }
  } else {
    const info=lstatSync(full);
    requireCondition((info.mode&0o077)===0 && info.uid===process.getuid?.(),"PRIVATE_PERMISSIONS_INVALID");
  }
  return full;
}
export function privateBytes(path: string, max: number): Buffer {
  privatePath(dirname(path),true);
  const full=privatePath(path),fd=openSync(full,constants.O_RDONLY | (constants.O_NOFOLLOW??0));
  try {
    const stat=fstatSync(fd);requireCondition(stat.isFile()&&stat.nlink===1&&stat.size>0&&stat.size<=max,"PRIVATE_FILE_INVALID");
    const bytes=readFileSync(fd);requireCondition(bytes.length===stat.size,"PRIVATE_FILE_CHANGED");return bytes;
  } finally { closeSync(fd); }
}
export function secretText(path: string, max=4096): string {
  const bytes=privateBytes(path,max);let value:string;
  try { value=new TextDecoder("utf-8",{fatal:true}).decode(bytes).replace(/\r?\n$/,""); }
  finally { bytes.fill(0); }
  requireCondition(!!value&&/^[\x21-\x7e]+$/.test(value),"PRIVATE_SECRET_INVALID");return value;
}

export function privateDatabase(root: string): void {
  privatePath(root,true);const file=join(root,"kuinest.sqlite");privatePath(file);
  for(const suffix of ["-wal","-shm","-journal"])if(existsSync(file+suffix))privatePath(file+suffix);
}
