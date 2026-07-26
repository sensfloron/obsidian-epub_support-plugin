## 目标
把语言检测从「顺序优先 + 单语言判定」重构为「加权特征打分 + 取最高分」。根治顺序依赖导致的误判/漏判，让所有代码块按命中特征累计得分，取分最高的语言。

## 设计依据（已实测确认）

1. **syntect `load_defaults_newlines()` 实际支持的语言**（`find_syntax_by_token` 返回 true 的）：rust, css, html, json, bash, sql, java, python, cpp, javascript, go, php, xml, yaml, ruby —— **15 个**。
2. **现有检测器输出的语言名里 7 个根本不被 syntect 支持**（fallback 到 Plain Text，检测无意义）：`csharp`、`typescript`、`swift`、`kotlin`、`dart`、`powershell`、`dockerfile`。评分表只覆盖上述 15 个，删掉这 7 个。
3. **现有特征来源**：12 个 `is_X` 函数 + `detect_other_languages` 的 10 条 keyword vec，全部可复用为评分特征。
4. **回归契约**：8 个 `test_detect_*` 样本必须仍判对；3 个 rust 用户 case 仍判 rust；cpp/js/go 不误判成 rust；random text 返回空。

## 用户确认的设计选择
- 评分模型：**加权特征打分**（每语言 `(特征, 权重)` 列表，命中累加）
- 识别门槛：**最高分 >0 即选**（全 0 返回 text）
- 控制误判：靠**特征权重的独占性分级**——独占特征高分，共有特征低分，让真属某语言的代码累积明显高分，蹭边的只得零星低分。

## 实施方案

### 改动：重写 `src/lib/epub_note_module/src/lib.rs` 的检测体系

#### 1. 新增 `LANG_FEATURES` 评分表

一个静态表，每条 `(语言名, Vec<(特征谓词描述, 权重)>)`。权重分 3 级：
- **3 分（语言独占强信号）**：几乎只在该语言出现的特征
- **2 分（较强特征）**：该语言常见但少数其他语言也有
- **1 分（弱/共有信号）**：多语言共有，单独不足以判定

15 个语言的初步特征表（节选关键，完整在实现时填）：

| 语言 | 3分特征 | 2分特征 | 1分特征 |
|---|---|---|---|
| rust | 宏 `name!(`/`![`/`!{`；`&mut`/`&str`/`&self`；`let mut` | `fn `/`pub fn`；`u64`/`i32`/`usize`；`->`；`impl `/`struct `/`enum ` | `use `+`::`；`Vec<`/`Result<`/`Option<` |
| python | `def `+`:`；`print(`+`:`；`for `+` in `+`:` | `import `；`from `+` import`；`elif `；`self.` | `:` |
| sql | `SELECT `+`FROM`；`INSERT INTO`；`CREATE TABLE` | `WHERE `；`UPDATE `+`SET`；`DELETE FROM`；`ALTER TABLE` | `;` |
| bash | `#!/`(shebang)；`if [`+`fi` | `then`；`done`；`echo ` | `=`,`$` |
| java | `public class `；`System.out.println`；`public static void main`+`String[]` | `import java.`；`package ` | `;`,`{}` |
| cpp | `#include`；`using namespace`；`std::` | `int main(`；`::`；`cout`/`endl` | `{}`,`;` |
| javascript | `console.log`；`function `+`{`；`require(`；`=> {` | `const `/`let `/`var `+`=`；`import ` | `{}` |
| css | `:`+`;`+`{}` (属性+声明块)；`@media`/`@import` | `{ }`≥2；`:` | `;` |
| html | `<!DOCTYPE`；`<html`；`<head>`；`<div`+`</` | `<p>`/`<span>`/`<a ` | `<`,`>` |
| json | 以`{`开头以`}`结尾+`:` | `"`+`:`+`,` | `{}` |
| go | `package main`+`func `；`fmt.Print` | `func `；`import(`；`:=` | `{}` |
| php | `<?php`；`->`+`$` | `echo `；`$` | `;` |
| ruby | `puts `；`require `+`def ` | `def `；`class `+`end`；`do `+`end` | `:` |
| yaml | `apiVersion:`；`kind:`；`metadata:`；`spec:` | `:`+换行缩进 | `:` |
| xml | `<?xml`；`</xml>`；`<xml` | `<`+`/>` | `<`,`>` |

**特征谓词实现**：用闭包或函数指针 `&dyn Fn(&str) -> bool`。复合条件（如 `SELECT`+`FROM`）用 `code.contains("SELECT ") && code.contains("FROM")`。

#### 2. 重写 `detect_language` 为评分循环

```rust
fn detect_language(code: &str) -> String {
    let trimmed = code.trim();
    if trimmed.is_empty() { return String::new(); }

    let mut best_lang = String::new();
    let mut best_score: i32 = 0;

    for (lang, features) in LANG_FEATURES {
        let score: i32 = features.iter()
            .filter(|(pred, _)| pred(trimmed))
            .map(|(_, w)| w)
            .sum();
        if score > best_score {
            best_score = score;
            best_lang = (*lang).to_string();
        }
    }
    // 最高分 >0 即返回该语言；全 0 返回空（→ text）
    best_lang  // 全 0 时仍是 ""
}
```

#### 3. 删除旧的顺序检测链

删除：`is_rust`/`is_css`/`is_html`/`is_json`/`is_bash`/`is_sql`/`is_csharp`/`is_java`/`is_python`/`is_c_cpp`/`is_typescript`/`is_javascript` 这 12 个函数的**调用**（`detect_language` 里的 if 链），以及 `detect_other_languages` 的顺序匹配。但**保留这些函数本身**作为评分表的特征谓词来源（或把它们内联进评分表）。倾向于：把特征直接写进评分表闭包，删掉这 12 个独立函数，代码更紧凑。

**保留**：`RUST_MACRO_RE`/`RUST_INT_TYPE_RE` 正则常量（评分表里 Rust 特征会引用）。`extract_lang_from_pre_tag` 完全不动（仍是最优先级）。

#### 4. 更新测试

- **保留并确保通过**所有现有 `test_detect_*`（8 个）+ `test_is_rust_user_cases`（2 个用户 case）+ `test_is_rust_rejects_cpp/js/go`（这 3 个改成 `detect_language` 级断言：cpp 样本判 cpp、js 判 js、go 判... 实测）。
- **删除** `test_is_rust_macro_signal_strong`/`int_type`/`borrow` 这 3 个测 `is_rust` 函数的测试（函数被删了）——或改为测 `detect_language` 返回 rust。
- **新增**近似语言区分测试：
  - `std::cout << x;` → 判 cpp（不判 rust）
  - `def foo(): pass` → 判 python
  - `SELECT * FROM t` → 判 sql
  - 含 `::` 但其他全是 cpp 特征 → 判 cpp 不判 rust

## 关键设计权衡

1. **特征谓词存储方式**：闭包 `Box<dyn Fn>` 在静态表里需要 `Lazy`。备选：把特征实现为 `fn(&str)->bool` 函数指针数组（`&[fn]`），可 `const` 化、零分配。**倾向函数指针**，更高效，wasm 友好。
2. **权重表调试**：权重是人工定的，可能需要迭代。靠新增的"近似区分测试"锁定关键边界（cpp vs rust、python vs ruby 等），避免回归。
3. **`csharp` 处理**：syntect 不识别 `csharp` token。实测确认 `find_syntax_by_token("cs")` 或 by_extension——若都不行，从评分表移除 C#（判出来也白搭）。**实现时先测这个**。

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/lib/epub_note_module/src/lib.rs` | (1) 新增 `LANG_FEATURES` 评分表（15 语言）；(2) 重写 `detect_language` 为评分循环；(3) 删除 12 个 `is_X` 函数 + `detect_other_languages`；(4) 更新/新增测试 |

**不改**：`extract_lang_from_pre_tag`、两条高亮调用路径（`highlight_code_blocks_impl`/`mark_sentences_impl` 仍调 `detect_language`，签名不变）、TS 端、wasm 不需要额外 feature。

## 构建与验证

1. **先实测 `csharp`/`cs` 解析**：写个临时 Rust 测确认 `find_syntax_by_token("cs")` 是否 true，决定 C# 去留。
2. `cargo test`：所有检测测试通过（含回归 + 新增近似区分）。
3. `npm run build`：重建 wasm + main.js。
4. Node 调部署后 wasm：批量验证——两个用户 case 判 rust；cpp/js/python/sql/css/html/json/bash 各判对；`std::cout` 判 cpp 不判 rust；random text 判 text。

## 风险与回退

- **主要风险**：权重表调得不好，导致某些语言样本被别的语言高分压过（如 cpp 样本被判 rust）。靠"近似区分测试"锁定关键边界 + 迭代调权。
- **回退**：若新方案在某类代码上明显劣于旧方案，git 可回退单个 commit。改动集中在检测函数区域，隔离性好。
- **可控性**：评分表是纯数据，调权重只改数字，不动逻辑，迭代成本低。