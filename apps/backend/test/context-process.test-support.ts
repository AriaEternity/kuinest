import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { projectRoot } from "../dist/server.js";
import { fixture, history, inspect, until } from "./context-fixtures.js";
for (const mode of ["memory", "compaction"]) test("C02/C07：真实子进程在" + mode + "提交后中断，恢复保留档案且不重复执行", async t => {
  const f = fixture(t); if (mode === "compaction") history(f, 16, 10);
  const receipt = f.submit(); await f.storage.close();
  const child = fork(join(projectRoot, "apps/backend/dist-test/context-crash-child.js"), [f.root, mode], { execPath: process.execPath, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let ready = false, error = ""; child.on("message", () => { ready = true; }); child.stderr?.on("data", data => { error += data.toString(); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await until(() => { assert.equal(error, ""); return ready; }, 5000);
  const closed = once(child, "exit"); child.kill(); await closed;
  await f.reopen(60000);
  assert.equal(f.store.recover(f.clock.now(), f.ids), 1);
  inspect(f.root, db => {
    const row = db.prepare("SELECT status,error_code,context_user_entry_id AS user FROM runs WHERE id=?").get(receipt.runId) as { status: string; error_code: string; user: string };
    assert.equal(row.status, "failed"); assert.equal(row.error_code, "RUN_INTERRUPTED");
    assert.equal((db.prepare("SELECT head_entry_id AS head FROM branches WHERE id=(SELECT active_branch_id FROM conversations WHERE id='conversation-a')").get() as { head: string }).head, row.user);
    assert.equal((db.prepare("SELECT count(*) AS n FROM provider_calls WHERE run_id=?").get(receipt.runId) as { n: number }).n, 1);
    if (mode === "memory") {
      assert.equal((db.prepare("SELECT count(*) AS n FROM memory_versions").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT status FROM tool_calls").get() as { status: string }).status, "unknown");
    } else {
      assert.equal((db.prepare("SELECT count(*) AS n FROM context_entries WHERE id='crash-compaction'").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT json_extract(manifest_json,'$.state') AS state FROM context_snapshots WHERE run_id=?").get(receipt.runId) as { state: string }).state, "ready");
    }
  });
  if (mode === "memory") assert.equal(f.storage.memoryAccess().read("owner-a", "character-a", "MEMORY.md")!.id, "crash-memory-version");
  assert.equal(f.store.recover(f.clock.now(), f.ids), 0);
});
