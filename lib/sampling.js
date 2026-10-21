import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { pinDshHome, findDshHome } from "./core.js";

/**
 * 采样扩展：请求级温度与 assistant 预填（1.4.2）。
 *
 * 两条官方扩展点，零引擎补丁，适配 0.1.7 / 0.2.1-rc.2 双宿主：
 *
 * 1) temperature —— `agent/request` waterfall。
 *    宿主 seed config 只含 provider/model/reasoningEffort/maxTokens（0.2.1
 *    agent-loop/lib/index.js prepareRequest），监听器返回带 temperature 的新
 *    config；`LlmCallConfig` 的 `callConfigEquals` 原生比较 temperature 字段
 *    （0.2.1 dsh-llm/lib/index.js:368），buildRequest 把它写进 request header，
 *    不变量按 header 对账两侧一致即通过。DeepSeek 适配器把显式 temperature
 *    序列化进请求体。
 *
 * 2) prefill —— `agent/pre-step` waterfall。
 *    decision.messages 尾部追加一条 assistant 消息；step() 首尝试以
 *    user/message 形式落 session（assertMessageEventShape 对 user 消息不限制
 *    source.kind），DeepSeek 适配器把它作为末条 assistant 轮次原文发出，
 *    即 Anthropic 式预填。
 *
 *    0.2.1 注意点：step() 现在按 message.source.kind === "runtime-context"
 *    分流 runtime context；我们的预填 source.kind 是 "model"（走普通
 *    user/message 落库路径），不会被误认成 runtime context。0.2.1 的
 *    AGENT_LOOP_MESSAGES_GUARD（patch #67）给 decision.messages 缺省兜底，
 *    我们的钩子自带 Array.isArray 检查，双保险。
 *
 * 配置存 $DSH_HOME/dsh-purge/sampling.json，每请求现读，改完即时生效。
 * 1.4.2 强化：
 *   - prefillOnce：默认 true，只在每轮第一步（payload.step === 1）追加，
 *     避免多步会话中预填堆积成多条 assistant 轮次。
 *   - durableRead：读配置失败（损坏/并发写）时静默回退默认值而不是抛错，
 *     保证钩子永不让请求失败。
 */

const SAMPLING_FILE = "sampling.json";
/** 有效温度范围；DeepSeek 线上限制 0-2。 */
const TEMP_MIN = 0;
const TEMP_MAX = 2;
/** stop 序列上限：官方 wire 上就是个数组，这里只防手滑。 */
const STOP_MAX = 8;
const STOP_MAX_LEN = 64;

/** 最近一次真正并进请求的采样值（进程内，用于 UI 自检；不落盘）。 */
let lastApplied = null;

function sanitizeStop(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of list) {
    const text = String(item == null ? "" : item);
    if (!text) continue;
    if (text.length > STOP_MAX_LEN) continue;
    if (!out.includes(text)) out.push(text);
    if (out.length >= STOP_MAX) break;
  }
  return out;
}

function homeOf() {
  try {
    return pinDshHome() || findDshHome();
  } catch {
    return findDshHome();
  }
}

function samplingPath(dshHome = homeOf()) {
  return path.join(dshHome, "dsh-purge", SAMPLING_FILE);
}

function clampTemperature(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, value));
}

/** 读取采样配置；缺失/损坏返回默认（温度未设、预填关闭、每轮一次）。 */
export function readSampling(dshHome = homeOf()) {
  const fallback = { temperature: null, prefill: "", prefillOnce: true, stop: [], maxTokens: null };
  try {
    const raw = JSON.parse(fs.readFileSync(samplingPath(dshHome), "utf8"));
    const temperature = raw?.temperature === null || raw?.temperature === void 0
      ? null
      : clampTemperature(Number(raw.temperature));
    const prefill = typeof raw?.prefill === "string" ? raw.prefill : "";
    const prefillOnce = raw?.prefillOnce === false ? false : true;
    const stop = sanitizeStop(raw?.stop);
    const rawMax = Number(raw?.maxTokens);
    const maxTokens = Number.isSafeInteger(rawMax) && rawMax > 0 ? rawMax : null;
    return { temperature, prefill, prefillOnce, stop, maxTokens };
  } catch {
    return fallback;
  }
}

/** 写入采样配置；temperature 传 null 清除，prefill 传空串清除。 */
export async function writeSampling(update, dshHome = homeOf()) {
  const current = readSampling(dshHome);
  const next = { ...current };
  if (update.temperature !== void 0) {
    if (update.temperature === null) next.temperature = null;
    else {
      const clamped = clampTemperature(Number(update.temperature));
      if (clamped === null) throw new Error(`temperature must be a finite number in [${TEMP_MIN}, ${TEMP_MAX}]`);
      next.temperature = clamped;
    }
  }
  if (update.prefill !== void 0) {
    if (typeof update.prefill !== "string") throw new Error("prefill must be a string");
    next.prefill = update.prefill;
  }
  if (update.prefillOnce !== void 0) {
    next.prefillOnce = update.prefillOnce !== false;
  }
  if (update.stop !== void 0) {
    if (update.stop !== null && !Array.isArray(update.stop)) throw new Error("stop must be an array of strings");
    next.stop = update.stop === null ? [] : sanitizeStop(update.stop);
  }
  if (update.maxTokens !== void 0) {
    if (update.maxTokens === null) next.maxTokens = null;
    else {
      const n = Math.trunc(Number(update.maxTokens));
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error("maxTokens 必须是正整数");
      next.maxTokens = n;
    }
  }
  const fp = samplingPath(dshHome);
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await fsp.writeFile(fp, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

/** 上次真正并进请求的采样值（供 UI/命令自检）；从未应用过为 null。 */
export function lastAppliedSampling() {
  return lastApplied;
}

/** 配置文件路径，HTTP API 状态展示用。 */
export function samplingPathOf(dshHome = homeOf()) {
  return samplingPath(dshHome);
}

function samplingEnabled(config) {
  return config?.sampling !== false;
}

/** agent/request 监听器：把配置里的 temperature / stop / maxTokens 并进请求 config。 */
export function installTemperatureHook(ctx, config = {}) {
  if (!samplingEnabled(config)) return;
  if (ctx.__dshPurgeTemperatureHook) return;
  ctx.__dshPurgeTemperatureHook = true;
  ctx.on("agent/request", async (_payload, next) => {
    const seed = await next();
    let settings = null;
    try {
      settings = readSampling();
    } catch {
      return seed; // durableRead：配置坏了不影响请求
    }
    const patch = {};
    if (settings.temperature !== null && seed?.temperature !== settings.temperature) {
      patch.temperature = settings.temperature;
    }
    if (settings.stop.length > 0) {
      const same = Array.isArray(seed?.stop)
        && seed.stop.length === settings.stop.length
        && seed.stop.every((item, i) => item === settings.stop[i]);
      if (!same) patch.stop = [...settings.stop];
    }
    if (settings.maxTokens !== null && seed?.maxTokens !== settings.maxTokens) {
      patch.maxTokens = settings.maxTokens;
    }
    if (Object.keys(patch).length === 0) return seed;
    try {
      lastApplied = {
        provider: String(seed?.provider || ""),
        model: String(seed?.model || ""),
        ...patch,
        at: Date.now(),
      };
    } catch {
      /* 自检信息写不进去不影响请求 */
    }
    return { ...seed, ...patch };
  }, { global: true });
}

function isOwnPrefill(message) {
  return String(message?.source?.plugin || "") === "dsh-purge";
}

/** agent/pre-step 监听器：追加 assistant 预填消息。prefillOnce 默认只在每轮第一步。 */
export function installPrefillHook(ctx, config = {}) {
  if (!samplingEnabled(config)) return;
  if (ctx.__dshPurgePrefillHook) return;
  ctx.__dshPurgePrefillHook = true;
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || !Array.isArray(decision.messages) || decision.messages.length === 0) return decision;
    let prefill = "";
    let prefillOnce = true;
    try {
      ({ prefill, prefillOnce } = readSampling());
    } catch {
      return decision; // durableRead
    }
    if (!prefill) return decision;
    // prefillOnce：只在每轮第一步（step === 1）注入，避免多步堆积。
    if (prefillOnce && Number(payload?.step) !== 1) return decision;
    // 幂等：末条已是本插件注入的预填时不再追加（重试/续步）。
    if (isOwnPrefill(decision.messages[decision.messages.length - 1])) return decision;
    const assistantPrefill = {
      id: `dsh-purge-prefill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: "assistant",
      content: [{ type: "text", text: prefill }],
      source: { kind: "model", provider: "dsh-purge", model: "prefill", plugin: "dsh-purge" },
    };
    return { ...decision, messages: [...decision.messages, assistantPrefill] };
  }, { global: true });
}

/** 状态文本，供 /purge sampling 与 purge_sampling 工具复用。 */
export function renderSamplingStatus() {
  const { temperature, prefill, prefillOnce, stop, maxTokens } = readSampling();
  const applied = lastAppliedSampling();
  const lines = [
    "dsh-purge 采样扩展 / sampling",
    `  temperature: ${temperature === null ? "(未设置 / unset)" : temperature}`,
    `  stop       : ${stop.length > 0 ? stop.map((s) => JSON.stringify(s)).join(", ") : "(未设置)"}`,
    `  maxTokens  : ${maxTokens === null ? "(未设置 / unset)" : maxTokens}`,
    `  prefill    : ${prefill ? `${prefill.length} chars, on` : "(未设置 / unset)"}`,
    `  prefillOnce: ${prefillOnce ? "每轮仅第一步 (step=1)" : "每步都注入"}`,
    `  file       : ${samplingPath()}`,
  ];
  if (applied) {
    const bits = [];
    if (applied.temperature !== void 0) bits.push(`temperature=${applied.temperature}`);
    if (applied.stop !== void 0) bits.push(`stop=${applied.stop.length}条`);
    if (applied.maxTokens !== void 0) bits.push(`maxTokens=${applied.maxTokens}`);
    lines.push(`  上次实际发出: ${bits.join(" ")} → ${applied.provider}/${applied.model}`);
  } else {
    lines.push("  上次实际发出: (本次启动后还没有请求)");
  }
  if (temperature !== null) {
    lines.push("  note: DeepSeek thinking 模式忽略 temperature；reasoningEffort=off 或非推理模型时生效。");
  }
  return lines.join("\n");
}
