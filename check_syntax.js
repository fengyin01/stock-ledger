// 轻量语法检查：抽取 HTML 内联 <script> 块，用 new Function 解析（不执行）
const fs = require("fs");
const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) {
    i++;
    const code = m[1];
    if (!code.trim()) continue;
    try { new Function(code); }
    catch (e) {
      bad++;
      const line = html.slice(0, m.index).split("\n").length;
      console.log(`FAIL ${f} script#${i} (起始行 ${line}): ${e.message}`);
    }
  }
  console.log(`${f}: 检查 ${i} 个内联脚本块`);
}
console.log(bad ? `共 ${bad} 处语法错误` : "全部通过");
process.exit(bad ? 1 : 0);
