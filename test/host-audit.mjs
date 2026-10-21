/**
 * 宿主补丁覆盖审计。
 *
 * 用法：
 *   node test/host-audit.mjs <aiBase>
 *
 * <aiBase> 是目标宿主的包根，布局与安装态一致：
 *   .../node_modules/@deepseek-ai/dsh-<pkg>/lib/index.js
 *
 * 输出每个补丁在该宿主上的状态：
 *   pending —— pattern 仍能在原始宿主文本里命中：补丁可用，点「应用」就会改
 *   skipped —— 原文对不上（宿主文本变了，或官方已把这段改成我们要的样子）：需要人工跟改
 *   missing_file —— 补丁要改的文件在这个宿主上不存在（包被删/改名/挪位，或审计根不全）
 *   applied —— marker 已在（说明这份宿主已经被打过补丁）
 *
 * 注意 pending 是「健康」状态：它代表补丁的 pattern 与当前宿主原文仍然吻合。
 * 真正要处理的是 skipped 与 missing_file。
 *
 * 这是「宿主升级后第一件事」：先跑一遍，skipped 的补丁就是这轮要改的清单。
 * 只读，不写任何宿主文件。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 审计不应读用户态配置：把 DSH_HOME 指到临时目录，避免 core.findDshHome() 摸到真实目录。
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-audit-home-"));
process.env.DSH_HOME = scratch;

const { patchStatus, ALL_PATCHES } = await import("../lib/core.js");

const aiBase = process.argv[2];
if (!aiBase) {
  console.error("usage: node test/host-audit.mjs <aiBase>");
  process.exit(2);
}
if (!fs.existsSync(aiBase)) {
  console.error(`host root not found: ${aiBase}`);
  process.exit(2);
}

const status = await patchStatus(aiBase);

const groups = { applied: [], pending: [], missing_file: [], skipped: [] };
for (const patch of ALL_PATCHES) {
  const state = status[patch.id] || "unknown";
  (groups[state] || (groups[state] = [])).push(patch);
}

const label = { applied: "已打过补丁", pending: "可应用（pattern 命中）", missing_file: "目标文件缺失", skipped: "原文对不上（需跟改）" };

console.log(`宿主根 / host root: ${aiBase}`);
console.log(`补丁总数 / patches: ${ALL_PATCHES.length}\n`);

for (const key of ["skipped", "missing_file", "pending", "applied"]) {
  const list = groups[key] || [];
  if (list.length === 0) continue;
  console.log(`${label[key]} (${key}) — ${list.length}`);
  for (const p of list) {
    const desc = String(p.desc || "").split(" / ")[0];
    console.log(`  [#${String(p.id).padEnd(2)}] ${String(p.name).padEnd(42)} ${desc}`);
  }
  console.log("");
}

const pending = (groups.pending || []).length;
const missing = (groups.missing_file || []).length;
const stale = (groups.skipped || []).length;
console.log(
  stale === 0 && missing === 0
    ? `结论：${pending} 个补丁可应用，其余已生效；没有需要跟改的补丁。`
    : `结论：${pending} 个可应用、${stale} 个原文对不上需要跟改、${missing} 个目标文件缺失（审计根不全时属正常）。`
);

fs.rmSync(scratch, { recursive: true, force: true });
process.exit(0);
