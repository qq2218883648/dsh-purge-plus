// 提示词库隔离验证：seed / list / activate / save / import / delete / 活跃标记。
import {
  seedPrompts, listPrompts, readPrompt, savePrompt, deletePrompt, importPrompt,
  activatePrompt, renderPromptsStatus, promptsDirOf, builtinPromptBodies,
} from "../lib/prompts.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompts-test-"));
process.env.DSH_HOME = fakeHome;

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failures++;
};

// 1) seed 落盘四份（builtin 视内置槽位是否为空）
const seeded = await seedPrompts();
check("seed wrote prompts", seeded.length >= 3);
check("seed dir exists", fs.existsSync(promptsDirOf()));

const list1 = listPrompts();
check("list has lean/creative/redteam", ["lean", "creative", "redteam"].every((id) => list1.prompts.some((p) => p.id === id)));
check("lean body mentions 执行者", readPrompt("lean").content.includes("执行者"));
check("creative body mentions 创作", readPrompt("creative").content.includes("创作模式"));
check("redteam body mentions 红队", readPrompt("redteam").content.includes("红队作业"));

// 2) 再 seed 不覆盖已有内容
await savePrompt("lean", "# 我自己改过的", { name: "改过" });
const again = await seedPrompts();
check("re-seed skips existing", !again.includes("lean") && readPrompt("lean").content.includes("我自己改过的"));

// 3) 激活：写进 prompt-inject.md
const act = await activatePrompt("creative");
check("activate wrote inject", fs.existsSync(act.path));
check("inject content equals creative", fs.readFileSync(act.path, "utf8").trim() === readPrompt("creative").content.trim());

const list2 = listPrompts();
check("active flag marks creative", list2.active === "creative");

// 4) 改内容后活跃标记消失
await savePrompt("creative", "# 改过的创作", { name: "创作模式" });
check("active cleared after edit", listPrompts().active === "");

// 5) 保存/读取/删除
await savePrompt("mine", "# 我的提示词\n正文", { name: "我的" });
check("save + read", readPrompt("mine").name === "我的" && readPrompt("mine").content.includes("正文"));
await deletePrompt("mine");
check("delete removes", !listPrompts().prompts.some((p) => p.id === "mine"));

// 6) 导入第三方文件并保留出处
const srcFile = path.join(fakeHome, "third-party.md");
fs.writeFileSync(srcFile, "# 第三方预设\n内容\n", "utf8");
const imported = await importPrompt(srcFile, "thirdparty", { source: "https://github.com/example/repo", license: "MIT" });
check("import id", imported.id === "thirdparty");
check("import keeps source", readPrompt("thirdparty").source === "https://github.com/example/repo");
check("import content", readPrompt("thirdparty").content.includes("第三方预设"));

// 7) 非法 id 拒绝
let bad = false;
try { await savePrompt("../evil", "x"); } catch { bad = true; }
check("reject illegal id", bad);

// 8) 空内容拒绝
let empty = false;
try { await savePrompt("emptyone", "   "); } catch { empty = true; }
check("reject empty body", empty);

// 9) 内置默认存在时 builtin 也可用
const bodies = builtinPromptBodies();
check("builtin bodies keys", ["builtin", "lean", "creative", "redteam"].every((k) => k in bodies));

// 10) 状态文本
const st = renderPromptsStatus();
check("status lists prompts", st.includes("prompt library") && st.includes("lean"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
fs.rmSync(fakeHome, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
