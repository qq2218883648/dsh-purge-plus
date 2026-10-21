import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { pinDshHome, findDshHome, findAiBase } from "./core.js";

/**
 * 宿主版本观察（全局）。
 *
 * 补丁是按宿主文本写的字面量，宿主一升级就可能对不上。这里做一件事：
 * 记住上次见到的宿主版本，启动时比对；变了就记一条，供 /purge status 与
 * 设置页提示「宿主已从 A 升到 B，去跑一次 test/host-audit.mjs」。
 *
 * 只读宿主 package.json 的 version，不碰任何宿主文件。
 */

const FILE = "host-version.json";

function homeOf() {
  try {
    return pinDshHome() || findDshHome();
  } catch {
    return findDshHome();
  }
}

function statePath(dshHome = homeOf()) {
  return path.join(dshHome, "dsh-purge", FILE);
}

/** 从宿主包根读版本：优先 dsh-base，其次 dsh，再退到任意 @deepseek-ai 包。 */
export function hostVersionOf(aiBase) {
  const candidates = ["dsh-base", "dsh", "dsh-agent-loop", "dsh-system-prompt"];
  for (const name of candidates) {
    try {
      const fp = path.join(aiBase, name, "package.json");
      const pkg = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (pkg && typeof pkg.version === "string" && pkg.version) return { version: pkg.version, from: name };
    } catch {
      /* 试下一个 */
    }
  }
  return { version: "", from: "" };
}

export function readHostWatch(dshHome = homeOf()) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(dshHome), "utf8"));
    return {
      version: String(raw?.version || ""),
      seenAt: String(raw?.seenAt || ""),
      previous: String(raw?.previous || ""),
      changedAt: String(raw?.changedAt || ""),
    };
  } catch {
    return { version: "", seenAt: "", previous: "", changedAt: "" };
  }
}

async function writeHostWatch(state, dshHome = homeOf()) {
  const fp = statePath(dshHome);
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await fsp.writeFile(fp, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

/**
 * 比对当前宿主版本与上次记录。
 * @returns {{ known: boolean, changed: boolean, from: string, to: string, pkg: string }}
 */
export async function checkHostVersion(aiBase, dshHome = homeOf()) {
  const { version, from } = hostVersionOf(aiBase || "");
  if (!version) return { known: false, changed: false, from: "", to: "", pkg: "" };
  const prev = readHostWatch(dshHome);
  const now = new Date().toISOString();
  if (!prev.version) {
    await writeHostWatch({ version, seenAt: now, previous: "", changedAt: "" }, dshHome);
    return { known: false, changed: false, from: "", to: version, pkg: from };
  }
  if (prev.version === version) {
    await writeHostWatch({ ...prev, seenAt: now }, dshHome);
    return { known: true, changed: false, from: prev.version, to: version, pkg: from };
  }
  await writeHostWatch({ version, seenAt: now, previous: prev.version, changedAt: now }, dshHome);
  return { known: true, changed: true, from: prev.version, to: version, pkg: from };
}

/** 启动时调用：宿主换版本就返回一行提示，否则返回 ""。 */
export async function watchHostAtBoot(dshHome = homeOf()) {
  let aiBase = "";
  try {
    aiBase = findAiBase() || "";
  } catch {
    aiBase = "";
  }
  if (!aiBase) return "";
  const r = await checkHostVersion(aiBase, dshHome);
  if (r.changed) {
    return `宿主已从 ${r.from} 升级到 ${r.to}（${r.pkg}）：补丁 pattern 可能对不上，建议跑一次 node test/host-audit.mjs <aiBase>`;
  }
  return "";
}

/** 状态文本，供 /purge status 复用。 */
export function renderHostWatchLine(dshHome = homeOf()) {
  const state = readHostWatch(dshHome);
  if (!state.version) return "宿主版本: (未记录)";
  if (state.previous && state.previous !== state.version) {
    return `宿主版本: ${state.version}（上次 ${state.previous}，${state.changedAt.slice(0, 10)} 变更 — 建议重跑补丁审计）`;
  }
  return `宿主版本: ${state.version}`;
}
