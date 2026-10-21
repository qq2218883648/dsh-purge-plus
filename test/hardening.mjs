// 破甲强化隔离验证：尾置段注册 / 拒答前缀并入 stop / 自愈阶梯递进。
import { readHardening, writeHardening, installTailSection, renderHardeningStatus, DEFAULT_TAIL, TAIL_ORDER } from "../lib/hardening.js";
import { readSampling, writeSampling, installTemperatureHook } from "../lib/sampling.js";
import { writeRefusal, readRefusal, installRefusalHeal, DEFAULT_LADDER } from "../lib/refusal.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-hardening-test-"));
process.env.DSH_HOME = fakeHome;

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failures++;
};

function makeCtx() {
  const hooks = {};
  const sections = [];
  return {
    systemPrompt: {
      section(spec) { sections.push(spec); },
    },
    on(name, cb, opts) {
      if (opts?.prepend) (hooks[name] ||= []).unshift(cb);
      else (hooks[name] ||= []).push(cb);
    },
    fire(name, payload) { for (const cb of hooks[name] || []) cb(payload); },
    hooks,
    sections,
  };
}

// ── 1. 默认尾置段 ──
const h0 = readHardening();
check("default tail present", h0.tail === DEFAULT_TAIL && h0.tail.includes("不输出"));
check("default refusalStops empty", h0.refusalStops.length === 0);

// ── 2. 写入与清空 ──
let h1 = await writeHardening({ tail: "自定义尾段", refusalStops: ["很抱歉", "I'm sorry", "很抱歉"] });
check("tail written", h1.tail === "自定义尾段");
check("stops deduped", h1.refusalStops.length === 2);
h1 = await writeHardening({ tail: "" });
check("tail can be cleared", readHardening().tail === "");

// ── 3. 尾置段注册：order 在 persona-suffix(10200) 之后，且 text 是函数（每请求现读）──
await writeHardening({ tail: "尾段A" });
const ctx = makeCtx();
check("tail section installed", installTailSection(ctx) === true);
const spec = ctx.sections[0];
check("tail section name", spec && spec.name === "dsh-purge:tail");
check("tail order 10300", spec && spec.order === TAIL_ORDER && TAIL_ORDER > 10200);
check("tail text is live fn", typeof spec.text === "function" && spec.text() === "尾段A");
await writeHardening({ tail: "尾段B" });
check("tail re-read per call", spec.text() === "尾段B");

// ── 4. refusalStops 并入请求 stop ──
await writeSampling({ stop: ["</answer>"] });
await writeHardening({ tail: "尾段B", refusalStops: ["很抱歉", "I'm sorry"] });
const ctx2 = makeCtx();
installTemperatureHook(ctx2);
const seed = await ctx2.hooks["agent/request"][0]({ turn: 1, step: 1 }, () => Promise.resolve({ provider: "p", model: "m" }));
check("sampling stop + refusal stops merged", Array.isArray(seed.stop) && seed.stop.length === 3 && seed.stop[0] === "</answer>");
check("refusal prefix included", seed.stop.includes("很抱歉"));

// ── 5. 清空后 stop 不再注入 ──
await writeSampling({ stop: [] });
await writeHardening({ refusalStops: [] });
const ctx3 = makeCtx();
installTemperatureHook(ctx3);
const seed3 = await ctx3.hooks["agent/request"][0]({ turn: 1, step: 1 }, () => Promise.resolve({ provider: "p", model: "m" }));
check("no stops after clear", seed3.stop === void 0);

// ── 6. 自愈阶梯：第 1/2/3 次用不同文本 ──
await writeRefusal({ enabled: true, maxPerTurn: 3, ladder: DEFAULT_LADDER });
const cfg = readRefusal();
check("ladder loaded", cfg.ladder.length === 3 && cfg.ladder[0] !== cfg.ladder[1]);

const sent = [];
const events = (seqBase) => [
  { seq: seqBase, type: "turn/start", data: { turn: 1 } },
  { seq: seqBase + 1, type: "user/message", data: { id: "u", role: "user", content: [{ type: "text", text: "做事" }], source: { kind: "user" } } },
  { seq: seqBase + 2, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "我无法协助这个请求。" }] } } },
  { seq: seqBase + 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
];
let base = 1;
const agent = {
  id: "sess-ladder",
  status: "idle",
  followup(m) { sent.push(m.content[0].text); },
  inbox: { hasPending: () => false },
  session: { snapshotEvents: () => events(base) },
};
const ctx4 = makeCtx();
installRefusalHeal(ctx4, { log: () => {} });
// 同一会话连续三次拒答（模拟追发后模型再拒），阶梯应逐级递进
ctx4.fire("agent/status", { agent, status: "idle" });
base = 10;
ctx4.fire("agent/status", { agent, status: "idle" });
base = 20;
ctx4.fire("agent/status", { agent, status: "idle" });
check("ladder escalates 1st", sent[0] === DEFAULT_LADDER[0]);
check("ladder escalates 2nd", sent[1] === DEFAULT_LADDER[1]);
check("ladder escalates 3rd", sent[2] === DEFAULT_LADDER[2]);
base = 30;
ctx4.fire("agent/status", { agent, status: "idle" });
check("ladder stops at maxPerTurn", sent.length === 3);

// 真人发新消息后计数归零（阶梯回到第 1 级）
base = 40;
const agentFresh = {
  id: "sess-ladder",
  status: "idle",
  followup(m) { sent.push(m.content[0].text); },
  inbox: { hasPending: () => false },
  session: { snapshotEvents: () => [
    ...events(40),
    { seq: 44, type: "user/message", data: { id: "u2", role: "user", content: [{ type: "text", text: "换个说法" }], source: { kind: "user" } } },
  ] },
};
ctx4.fire("agent/status", { agent: agentFresh, status: "idle" });
check("fresh human message resets ladder", sent.length === 3);

// ── 7. 状态文本 ──
const st = renderHardeningStatus();
check("status mentions tail + stops", st.includes("tail") && st.includes("refusalStops"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
fs.rmSync(fakeHome, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
