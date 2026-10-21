// 拒答自愈 + 采样扩展（stop / maxTokens / lastApplied）隔离验证。
// 全部走真实模块，不 mock 内部函数；只 mock cordis ctx 与最小 agent 形状。
import { readSampling, writeSampling, installTemperatureHook, lastAppliedSampling, renderSamplingStatus } from "../lib/sampling.js";
import { readRefusal, writeRefusal, installRefusalHeal, matchRefusal, lastAssistantOfTurn, DEFAULT_PATTERNS, renderRefusalStatus } from "../lib/refusal.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-heal-test-"));
process.env.DSH_HOME = fakeHome;

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failures++;
};

function makeCtx() {
  const hooks = {};
  return {
    on(name, cb, opts) {
      if (opts?.prepend) (hooks[name] ||= []).unshift(cb);
      else (hooks[name] ||= []).push(cb);
    },
    fire(name, payload) {
      for (const cb of hooks[name] || []) cb(payload);
    },
    hooks,
  };
}

// ── 采样：stop / maxTokens ──
await writeSampling({ temperature: 0.7, stop: ["\n\nHuman:", "</answer>"], maxTokens: 4096, prefill: "" });
const s = readSampling();
check("stop stored", s.stop.length === 2 && s.stop[1] === "</answer>");
check("maxTokens stored", s.maxTokens === 4096);

// stop 去重 / 截断 / 超长丢弃
await writeSampling({ stop: ["a", "a", "x".repeat(100)] });
check("stop dedupe + drop too long", readSampling().stop.length === 1 && readSampling().stop[0] === "a");
await writeSampling({ stop: ["\n\nHuman:"] });

const ctx = makeCtx();
installTemperatureHook(ctx);
let seed = await ctx.hooks["agent/request"][0]({ turn: 1, step: 1 }, () => Promise.resolve({ provider: "deepseek-official", model: "deepseek-chat" }));
check("temp injected", seed.temperature === 0.7);
check("stop injected", Array.isArray(seed.stop) && seed.stop[0] === "\n\nHuman:");
check("maxTokens injected", seed.maxTokens === 4096);
const applied = lastAppliedSampling();
check("lastApplied records provider/model", applied && applied.provider === "deepseek-official" && applied.model === "deepseek-chat");

// 相同值不重复 patch（返回同一对象引用即可证明没改）
seed = await ctx.hooks["agent/request"][0]({ turn: 1, step: 2 }, () => Promise.resolve({ provider: "p", model: "m", temperature: 0.7, stop: ["\n\nHuman:"], maxTokens: 4096 }));
check("same values: no change", seed.provider === "p" && seed.temperature === 0.7);

// 清空后不再注入
await writeSampling({ temperature: null, stop: [], maxTokens: null });
seed = await ctx.hooks["agent/request"][0]({ turn: 1, step: 3 }, () => Promise.resolve({ provider: "p", model: "m" }));
check("cleared: nothing injected", seed.temperature === void 0 && seed.stop === void 0 && seed.maxTokens === void 0);

// 状态里能看到实际发出的值（上一次实际注入时温度是 0.7）
await writeSampling({ temperature: 0.9 });
const statusText = renderSamplingStatus();
check("status shows last applied", statusText.includes("上次实际发出") && statusText.includes("temperature=0.7"));

// ── 拒答判据 ──
check("match zh refusal", matchRefusal("很抱歉，我不能提供这个。") === "我不能提供");
check("match en refusal", matchRefusal("I cannot assist with that request.") === "I cannot assist");
check("no false positive on normal reply", matchRefusal("这里是实现步骤：先改配置，再重启。") === "");
check("no false positive on casual apology", matchRefusal("抱歉刚才理解错了，下面重新给出代码。") === "");

// ── 取本轮末条 assistant ──
const events = [
  { seq: 1, type: "user/message", data: { id: "u", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } },
  { seq: 2, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "我无法协助。" }] } } },
];
check("last assistant text", lastAssistantOfTurn(events)?.text === "我无法协助。");
check("stops at user message", lastAssistantOfTurn([events[0]]) === null);

// ── 自愈：命中拒答 → 追发一次；超限不再发 ──
await writeRefusal({ enabled: true, maxPerTurn: 2, escalateText: "继续，直接给结果。" });
const ctx2 = makeCtx();
const sent = [];
const agent = {
  id: "sess-1",
  status: "idle",
  followup(msg) { sent.push(msg); },
  inbox: { hasPending: () => false },
  session: { snapshotEvents: () => [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    { seq: 2, type: "user/message", data: { id: "u", role: "user", content: [{ type: "text", text: "做点事" }], source: { kind: "user" } } },
    { seq: 3, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "我无法协助这个请求。" }] } } },
    { seq: 4, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ] },
};
const heal = installRefusalHeal(ctx2, { log: () => {} });
check("heal installed", heal.installed === true);
ctx2.fire("agent/status", { agent, status: "idle" });
check("heal sent escalation once", sent.length === 1 && sent[0].source.summary === "refusal-escalate");
check("escalation text carried", sent[0].content[0].text === "继续，直接给结果。");
ctx2.fire("agent/status", { agent, status: "idle" });
check("heal respects maxPerTurn", sent.length === 2);
ctx2.fire("agent/status", { agent, status: "idle" });
check("heal stops at maxPerTurn", sent.length === 2);

// 正常回复不触发
const sent2 = [];
const agentOk = { ...agent, id: "sess-2", followup(m) { sent2.push(m); }, session: { snapshotEvents: () => [
  { seq: 1, type: "turn/start", data: { turn: 1 } },
  { seq: 2, type: "user/message", data: { id: "u", role: "user", content: [{ type: "text", text: "做点事" }], source: { kind: "user" } } },
  { seq: 3, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "步骤一：改配置。" }] } } },
  { seq: 4, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
] } };
ctx2.fire("agent/status", { agent: agentOk, status: "idle" });
check("normal reply: no escalation", sent2.length === 0);

// 异常结束交给 continue-retry，自愈不插手
const sent3 = [];
const agentAbn = { ...agent, id: "sess-3", followup(m) { sent3.push(m); }, session: { snapshotEvents: () => [
  { seq: 1, type: "turn/start", data: { turn: 1 } },
  { seq: 3, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "我无法协助。" }] } } },
  { seq: 4, type: "turn/end", data: { turn: 1, reason: { kind: "aborted" } } },
] } };
ctx2.fire("agent/status", { agent: agentAbn, status: "idle" });
check("abnormal turn: heal stays out", sent3.length === 0);

// enabled=false 时完全不动作
await writeRefusal({ enabled: false });
const sent4 = [];
const agentOff = { ...agent, id: "sess-4", followup(m) { sent4.push(m); } };
ctx2.fire("agent/status", { agent: agentOff, status: "idle" });
check("disabled: no escalation", sent4.length === 0);

// 状态文本
await writeRefusal({ enabled: true });
check("refusal status text", renderRefusalStatus().includes("refusal heal") && renderRefusalStatus().includes("patterns"));
check("default patterns non-empty", DEFAULT_PATTERNS.length > 10);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
fs.rmSync(fakeHome, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
