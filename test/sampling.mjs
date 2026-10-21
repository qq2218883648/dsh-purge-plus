// 隔离验证 sampling.js：按官方 cordis waterfall 语义 mock ctx。
// 适配 1.4.2：durableRead（配置损坏不抛）、prefillOnce（step 分流）、
// 0.2.1 preStep 的 runtime-context 分流不被误认。
import { readSampling, writeSampling, installTemperatureHook, installPrefillHook, renderSamplingStatus, samplingPathOf } from "../lib/sampling.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sampling-test-"));
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
    async waterfall(self, name, ...args) {
      const inner = args.pop();
      const cbs = [...(hooks[name] || [])];
      const next = () => (cbs.shift() || inner)(...args);
      args.push(next);
      return next();
    },
  };
}

async function runRequest(ctx, payload, seed) {
  return ctx.waterfall(ctx, "agent/request", payload, () => Promise.resolve(seed));
}

async function runPreStep(ctx, payload, decision) {
  return ctx.waterfall(ctx, "agent/pre-step", payload, () => Promise.resolve(decision));
}

const userMsg = { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } };

// ── 基础读写 ──
const s0 = readSampling();
check("default: temperature null", s0.temperature === null);
check("default: prefill empty", s0.prefill === "");
check("default: prefillOnce true", s0.prefillOnce === true);

await writeSampling({ temperature: 0.9, prefill: "(PJ成功 )" });
const s1 = readSampling();
check("write: temperature 0.9", s1.temperature === 0.9);
check("write: prefill stored", s1.prefill === "(PJ成功 )");

await writeSampling({ temperature: 5 });
check("clamp: 5 -> 2", readSampling().temperature === 2);
await writeSampling({ temperature: -1 });
check("clamp: -1 -> 0", readSampling().temperature === 0);
await writeSampling({ temperature: 0.9 });

// ── durableRead：配置文件损坏不抛，回退默认 ──
fs.writeFileSync(samplingPathOf(), "{broken json", "utf8");
const sBroken = readSampling();
check("durableRead: broken file -> defaults", sBroken.temperature === null && sBroken.prefill === "");
const ctxB = makeCtx();
installTemperatureHook(ctxB);
const cfgBroken = await runRequest(ctxB, { turn: 1, step: 1 }, { provider: "p", model: "m" });
check("durableRead: broken config, request untouched", cfgBroken.temperature === void 0);
await writeSampling({ temperature: 0.9, prefill: "(PJ成功 )" });

// ── 温度钩子 ──
const ctxT = makeCtx();
installTemperatureHook(ctxT);
const seed = { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "low" };
const cfg = await runRequest(ctxT, { turn: 1, step: 1 }, seed);
check("temp hook: config carries temperature", cfg.temperature === 0.9);
check("temp hook: seed fields preserved", cfg.provider === seed.provider && cfg.model === seed.model && cfg.reasoningEffort === seed.reasoningEffort);

await writeSampling({ temperature: null });
const ctxT2 = makeCtx();
installTemperatureHook(ctxT2);
check("temp off: seed untouched", (await runRequest(ctxT2, { turn: 1, step: 1 }, { provider: "p", model: "m" })).temperature === void 0);

// ── 预填钩子：prefillOnce 默认只在 step 1 ──
await writeSampling({ temperature: null, prefill: "(PJ成功 )" });
const ctxP = makeCtx();
installPrefillHook(ctxP);
const d1 = await runPreStep(ctxP, { messages: [userMsg], turn: 1, step: 1 }, { kind: "enter", messages: [userMsg] });
check("prefill once: step 1 appended", d1.messages.length === 2 && d1.messages[1].role === "assistant");
check("prefill: text carried", d1.messages[1].content[0].text === "(PJ成功 )");
const d2 = await runPreStep(ctxP, { messages: [userMsg], turn: 1, step: 2 }, { kind: "enter", messages: [userMsg] });
check("prefill once: step 2 NOT appended", d2.messages.length === 1);

// prefillOnce=false：每步都注入
await writeSampling({ prefillOnce: false });
const ctxP2 = makeCtx();
installPrefillHook(ctxP2);
const d3 = await runPreStep(ctxP2, { messages: [userMsg], turn: 1, step: 1 }, { kind: "enter", messages: [userMsg] });
const d4 = await runPreStep(ctxP2, { messages: [userMsg], turn: 1, step: 3 }, { kind: "enter", messages: [userMsg] });
check("prefill every: step 1 appended", d3.messages.length === 2);
check("prefill every: step 3 appended", d4.messages.length === 2);

// 幂等：末条已注入不再叠加
await writeSampling({ prefillOnce: true });
const d5 = await runPreStep(ctxP, { messages: d1.messages, turn: 1, step: 1 }, { kind: "enter", messages: d1.messages });
check("prefill idempotent: no double append", d5.messages.length === 2);

// 空消息列表不追加
const d6 = await runPreStep(ctxP, { messages: [], turn: 2, step: 1 }, { kind: "enter", messages: [] });
check("prefill: empty messages untouched", d6.messages.length === 0);

// decision.messages 缺省（patch 67 场景）不炸
const d7 = await runPreStep(ctxP, { messages: [userMsg], turn: 3, step: 1 }, { kind: "enter" });
check("prefill: undefined messages untouched", d7.messages === void 0);

// 预填关闭后透传
await writeSampling({ prefill: "" });
const ctxP3 = makeCtx();
installPrefillHook(ctxP3);
check("prefill off: untouched", (await runPreStep(ctxP3, { messages: [userMsg], turn: 1, step: 1 }, { kind: "enter", messages: [userMsg] })).messages.length === 1);

// ── 状态与路径 ──
await writeSampling({ temperature: 0.9, prefill: "(PJ成功 )" });
const st = renderSamplingStatus();
check("status renders all fields", st.includes("temperature") && st.includes("prefillOnce") && st.includes("sampling.json"));
check("samplingPathOf ends with dsh-purge/sampling.json", samplingPathOf().endsWith(path.join("dsh-purge", "sampling.json")));

// ── 开关与重复安装 ──
const ctxOff = makeCtx();
installTemperatureHook(ctxOff, { sampling: false });
installPrefillHook(ctxOff, { sampling: false });
check("sampling off: request untouched", (await runRequest(ctxOff, { turn: 1, step: 1 }, { provider: "p", model: "m", temperature: 0.5 })).temperature === 0.5);

installTemperatureHook(ctxT);
// 重复安装同 ctx 不叠加钩子：若叠加，第二次 next() 链会因 decision 缺字段而异常。
// 前提：先把配置温度清掉，否则单层钩子本来就会带回 0.9，断言无意义。
await writeSampling({ temperature: null });
check("double install: no stacking", (await runRequest(ctxT, { turn: 1, step: 1 }, { provider: "p", model: "m" })).temperature === void 0);

// ── 0.2.1 分流兼容：runtime-context 消息不被预填守卫误伤 ──
await writeSampling({ prefill: "(PJ成功 )", prefillOnce: false });
const ctxR = makeCtx();
installPrefillHook(ctxR);
const runtimeCtxMsg = { id: "rc1", role: "user", content: [{ type: "text", text: "Current runtime context." }], source: { kind: "runtime-context" } };
const d8 = await runPreStep(ctxR, { messages: [userMsg, runtimeCtxMsg], turn: 1, step: 1 }, { kind: "enter", messages: [userMsg, runtimeCtxMsg] });
check("0.2.1 runtime-context: appended after, order kept", d8.messages.length === 3 && d8.messages[2].role === "assistant" && d8.messages[1] === runtimeCtxMsg);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
fs.rmSync(fakeHome, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
