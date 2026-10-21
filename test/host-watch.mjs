// 宿主版本观察：首次记录 / 同版本静默 / 换版本告警。
import { hostVersionOf, checkHostVersion, readHostWatch, renderHostWatchLine } from "../lib/host-watch.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-hostwatch-test-"));
const aiBase = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ai-base-"));
process.env.DSH_HOME = fakeHome;

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failures++;
};

function writePkg(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version }), "utf8");
}

// 1) 读版本：dsh-base 优先
writePkg(path.join(aiBase, "dsh-base"), "0.2.1-rc.2");
check("hostVersionOf reads dsh-base", hostVersionOf(aiBase).version === "0.2.1-rc.2");
check("hostVersionOf reports pkg", hostVersionOf(aiBase).from === "dsh-base");

// 2) 首次：记录但不告警
let r = await checkHostVersion(aiBase, fakeHome);
check("first sight: known=false", r.known === false && r.changed === false);
check("first sight: stored", readHostWatch(fakeHome).version === "0.2.1-rc.2");

// 3) 同版本：不告警
r = await checkHostVersion(aiBase, fakeHome);
check("same version: no change", r.changed === false && r.known === true);

// 4) 换版本：告警并记住上一版
writePkg(path.join(aiBase, "dsh-base"), "0.3.0");
r = await checkHostVersion(aiBase, fakeHome);
check("upgrade: changed", r.changed === true && r.from === "0.2.1-rc.2" && r.to === "0.3.0");
check("upgrade: previous recorded", readHostWatch(fakeHome).previous === "0.2.1-rc.2");

// 5) 状态行提示重跑审计
const line = renderHostWatchLine(fakeHome);
check("status line warns on change", line.includes("0.3.0") && line.includes("审计"));

// 6) 缺 dsh-base 时回退到 dsh
const aiBase2 = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ai-base2-"));
writePkg(path.join(aiBase2, "dsh"), "0.1.7-rc.2");
check("fallback to dsh", hostVersionOf(aiBase2).version === "0.1.7-rc.2" && hostVersionOf(aiBase2).from === "dsh");

// 7) 全都没有：空串，不写状态
const aiBase3 = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ai-base3-"));
const empty = hostVersionOf(aiBase3);
check("no host packages: empty", empty.version === "" && empty.from === "");
const r3 = await checkHostVersion(aiBase3, fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home3-")));
check("no version: not known, not written", r3.known === false && r3.changed === false);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
for (const d of [fakeHome, aiBase, aiBase2, aiBase3]) fs.rmSync(d, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
