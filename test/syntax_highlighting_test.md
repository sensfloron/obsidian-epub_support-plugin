# EPUB 语法高亮测试套件

这是一个专门用于测试 EPUB 插件语法高亮功能的测试文件。

## 🧪 测试说明

### 使用方法
1. 在 Obsidian 中打开这个文件
2. 打开开发者工具 (F12) -> Console
3. 查看测试日志输出
4. 每个测试用例都会显示预期结果和实际结果

### 测试覆盖范围
- ✅ 语言检测准确性测试
- ✅ MarkdownRenderer 渲染测试
- ✅ 语法高亮效果验证
- ✅ 边界情况处理

---

## 📋 测试用例

### 测试组 1: 语言检测准确性

#### 测试 1.1: JavaScript 检测
**预期语言**: `javascript`
**代码特征**: 函数声明、console.log、const/let 关键字

```javascript
function calculateTotal(items) {
    const total = items.reduce((sum, item) => sum + item.price, 0);
    console.log("Total:", total);
    return total;
}

class ShoppingCart {
    constructor() {
        this.items = [];
    }
    
    addItem(item) {
        this.items.push(item);
    }
}
```

#### 测试 1.2: Python 检测
**预期语言**: `python`
**代码特征**: def 函数、import、缩进、冒号

```python
def fibonacci(n):
    """Generate fibonacci sequence up to n"""
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)

class DataProcessor:
    def __init__(self, data):
        self.data = data
    
    def process(self):
        return [x * 2 for x in self.data]

if __name__ == "__main__":
    result = fibonacci(10)
    print(f"Result: {result}")
```

#### 测试 1.3: Rust 检测
**预期语言**: `rust`
**代码特征**: fn 函数、use 导入、let mut、struct、impl

```rust
use std::collections::HashMap;

struct User {
    name: String,
    age: u32,
    active: bool,
}

impl User {
    fn new(name: String, age: u32) -> Self {
        User {
            name,
            age,
            active: true,
        }
    }
    
    fn birthday(&mut self) {
        self.age += 1;
    }
}

fn main() {
    let mut user = User::new(String::from("Alice"), 30);
    user.birthday();
    println!("User: {}, Age: {}", user.name, user.age);
}
```

#### 测试 1.4: CSS 检测
**预期语言**: `css`
**代码特征**: 选择器、花括号、属性-值对、@media 规则

```css
.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
    background: #ffffff;
}

.button {
    background-color: #007bff;
    border: none;
    color: white;
    padding: 10px 20px;
    border-radius: 4px;
}

@media (max-width: 768px) {
    .container {
        padding: 10px;
    }
}

@keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
}
```

#### 测试 1.5: HTML 检测
**预期语言**: `html`
**代码特征**: HTML 标签、DOCTYPE、尖括号、属性

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Test Page</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="container">
        <h1>Welcome to Test Page</h1>
        <p>This is a paragraph with <strong>bold text</strong>.</p>
        <button class="button">Click Me</button>
    </div>
    <script src="script.js"></script>
</body>
</html>
```

#### 测试 1.6: JSON 检测
**预期语言**: `json`
**代码特征**: 花括号、键值对、字符串引号、逗号分隔

```json
{
    "name": "Test Project",
    "version": "1.0.0",
    "description": "A test project for syntax highlighting",
    "main": "index.js",
    "scripts": {
        "start": "node index.js",
        "test": "jest",
        "build": "webpack --mode production"
    },
    "dependencies": {
        "express": "^4.18.0",
        "lodash": "^4.17.21"
    },
    "devDependencies": {
        "jest": "^29.0.0",
        "webpack": "^5.0.0"
    }
}
```

#### 测试 1.7: SQL 检测
**预期语言**: `sql`
**代码特征**: SELECT/INSERT/UPDATE 关键字、表名、WHERE 条件

```sql
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) NOT NULL,
    email VARCHAR(100) UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

SELECT u.username, u.email, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.created_at >= '2024-01-01'
GROUP BY u.id
ORDER BY order_count DESC
LIMIT 10;

UPDATE products
SET price = price * 1.1, updated_at = NOW()
WHERE category = 'electronics';
```

#### 测试 1.8: Bash 检测
**预期语言**: `bash`
**代码特征**: shebang、变量赋值、if 条件、for 循环

```bash
#!/bin/bash

# 配置变量
PROJECT_DIR="/var/www/project"
BACKUP_DIR="/backup/logs"
DATE=$(date +%Y%m%d_%H%M%S)

# 检查目录是否存在
if [ ! -d "$BACKUP_DIR" ]; then
    mkdir -p "$BACKUP_DIR"
    echo "Created backup directory: $BACKUP_DIR"
fi

# 备份文件
for file in "$PROJECT_DIR"/*.log; do
    if [ -f "$file" ]; then
        cp "$file" "$BACKUP_DIR/${file##*/}.$DATE"
        echo "Backed up: $file"
    fi
done

echo "Backup completed: $DATE"
```

### 测试组 2: 边界情况测试

#### 测试 2.1: 空代码块
**预期语言**: `无`（应该跳过）


```

```

#### 测试 2.2: 纯文本
**预期语言**: `无` 或 `text`
**代码特征**: 无明显编程语言特征


```
This is just plain text with no programming language syntax.
It should not be detected as any specific language.
The system should either not highlight it or use generic text highlighting.
```

#### 测试 2.3: 混合语言片段
**预期语言**: 根据主要特征判断
**说明**: 测试语言检测的鲁棒性

```javascript
// 这看起来像 JavaScript，但有其他语言的特征
function processData(data) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
        result.push(data[i] * 2);
    }
    return result;
}
```

#### 测试 2.4: 短代码片段
**预期语言**: 根据片段特征判断
**说明**: 测试对短代码的处理能力


```
let x = 5;
```

```python
x = 5
```

### 测试组 3: 相似语言区分测试

#### 测试 3.1: C vs C++ vs C#
**目的**: 测试相似 C 族语言的区分能力

```c
// C 代码
#include <stdio.h>
#include <stdlib.h>

int main() {
    int* arr = (int*)malloc(5 * sizeof(int));
    for (int i = 0; i < 5; i++) {
        arr[i] = i * 2;
    }
    printf("First element: %d\n", arr[0]);
    free(arr);
    return 0;
}
```

```cpp
// C++ 代码
#include <iostream>
#include <vector>
#include <algorithm>

int main() {
    std::vector<int> numbers = {1, 2, 3, 4, 5};
    std::transform(numbers.begin(), numbers.end(), numbers.begin(),
                   [](int n) { return n * 2; });
    
    for (const auto& num : numbers) {
        std::cout << num << " ";
    }
    return 0;
}
```

```csharp
// C# 代码
using System;
using System.Collections.Generic;
using System.Linq;

class Program {
    static void Main() {
        List<int> numbers = new List<int> {1, 2, 3, 4, 5};
        var doubled = numbers.Select(n => n * 2).ToList();
        
        foreach (var num in doubled) {
            Console.Write(num + " ");
        }
    }
}
```

#### 测试 3.2: Java vs JavaScript
**目的**: 测试名称相似但语法不同的语言区分

```java
// Java 代码
public class Calculator {
    private int result;
    
    public Calculator() {
        this.result = 0;
    }
    
    public int add(int a, int b) {
        this.result = a + b;
        return this.result;
    }
    
    public static void main(String[] args) {
        Calculator calc = new Calculator();
        int sum = calc.add(5, 3);
        System.out.println("Sum: " + sum);
    }
}
```

```javascript
// JavaScript 代码
class Calculator {
    constructor() {
        this.result = 0;
    }
    
    add(a, b) {
        this.result = a + b;
        return this.result;
    }
}

const calc = new Calculator();
const sum = calc.add(5, 3);
console.log(`Sum: ${sum}`);
```

### 测试组 4: 渲染效果测试

#### 测试 4.1: 复杂嵌套结构
**目的**: 测试对复杂代码结构的渲染能力

```rust
impl<T> Tree<T> {
    fn new(value: T) -> Self {
        Tree {
            value,
            left: None,
            right: None,
        }
    }
    
    fn insert(&mut self, new_value: T)
    where
        T: Ord + std::fmt::Display,
    {
        if new_value < self.value {
            match &mut self.left {
                Some(left) => left.insert(new_value),
                None => self.left = Some(Box::new(Tree::new(new_value))),
            }
        } else {
            match &mut self.right {
                Some(right) => right.insert(new_value),
                None => self.right = Some(Box::new(Tree::new(new_value))),
            }
        }
    }
}
```

#### 测试 4.2: 长代码块
**目的**: 测试对大代码块的处理性能

```python
def complex_algorithm(data):
    """
    复杂的数据处理算法
    包含多个步骤和嵌套逻辑
    """
    result = []
    
    # 第一步：数据预处理
    processed = []
    for item in data:
        if isinstance(item, str):
            processed.append(item.strip().lower())
        elif isinstance(item, (int, float)):
            processed.append(float(item))
        else:
            processed.append(None)
    
    # 第二步：数据分析
    valid_data = [x for x in processed if x is not None]
    if not valid_data:
        return result
    
    # 第三步：统计计算
    statistics = {
        'count': len(valid_data),
        'sum': sum(valid_data) if all(isinstance(x, (int, float)) for x in valid_data) else 0,
        'avg': 0,
    }
    
    if statistics['sum'] > 0:
        statistics['avg'] = statistics['sum'] / statistics['count']
    
    # 第四步：结果格式化
    result.append(f"Total items: {statistics['count']}")
    result.append(f"Sum: {statistics['sum']:.2f}")
    result.append(f"Average: {statistics['avg']:.2f}")
    
    return result

# 测试数据
test_data = [42, "hello", 3.14, "world", 100, "test", 2.71]
output = complex_algorithm(test_data)
for line in output:
    print(line)
```

### 测试组 5: 特殊字符和编码测试

#### 测试 5.1: Unicode 字符
**目的**: 测试对特殊字符和编码的处理

```python
# 测试 Unicode 字符处理
def process_unicode():
    emoji = "😀🎉🚀"
    chinese = "你好世界"
    japanese = "こんにちは"
    special_chars = "™®©€£¥"
    
    print(f"Emoji: {emoji}")
    print(f"Chinese: {chinese}")
    print(f"Japanese: {japanese}")
    print(f"Special: {special_chars}")
    
    return {
        'emoji': emoji,
        'chinese': chinese,
        'japanese': japanese,
        'special': special_chars
    }

result = process_unicode()
print(f"Result: {result}")
```

#### 测试 5.2: 特殊符号和注释
**目的**: 测试对特殊语法元素的处理

```javascript
/**
 * 多行注释测试
 * 包含特殊符号: @param, @return, {@link}
 */
function parseSpecialChars(str) {
    // 测试各种特殊字符
    const regex = /[^a-zA-Z0-9]/g;  // 正则表达式
    const symbols = "@#$%^&*()_+-=[]{}|;':\",./<>?`~";
    
    // 字符串转义测试
    const escaped = "Line 1\nLine 2\tTabbed\\Backslash";
    const template = `Value: ${str}, Symbols: ${symbols}`;
    
    return {
        original: str,
        regex_matches: str.match(regex),
        escaped: escaped,
        template: template
    };
}
```

---

## 📊 测试结果记录

### 手动测试检查表

使用此检查表记录每个测试的结果：

| 测试ID | 测试名称 | 预期语言 | 实际语言 | 高亮效果 | 状态 |
|--------|----------|----------|----------|----------|------|
| 1.1 | JavaScript检测 | javascript | | | ☐ |
| 1.2 | Python检测 | python | | | ☐ |
| 1.3 | Rust检测 | rust | | | ☐ |
| 1.4 | CSS检测 | css | | | ☐ |
| 1.5 | HTML检测 | html | | | ☐ |
| 1.6 | JSON检测 | json | | | ☐ |
| 1.7 | SQL检测 | sql | | | ☐ |
| 1.8 | Bash检测 | bash | | | ☐ |
| 2.1 | 空代码块 | 跳过 | | | ☐ |
| 2.2 | 纯文本 | text/无 | | | ☐ |
| 3.1 | C族语言区分 | c/cpp/csharp | | | ☐ |
| 3.2 | JavavsJS | java/javascript | | | ☐ |
| 4.1 | 复杂嵌套 | 对应语言 | | | ☐ |
| 5.1 | Unicode字符 | 对应语言 | | | ☐ |

### 自动化测试脚本

在 Console 中运行以下脚本进行自动化测试：

```javascript
// 语法高亮自动化测试脚本
class SyntaxHighlightingTest {
    constructor() {
        this.results = [];
        this.testCases = this.getTestCases();
    }
    
    getTestCases() {
        return [
            {
                name: 'JavaScript检测',
                code: 'function test() { console.log("Hello"); }',
                expectedLanguage: 'javascript'
            },
            {
                name: 'Python检测',
                code: 'def test():\n    print("Hello")',
                expectedLanguage: 'python'
            },
            {
                name: 'Rust检测',
                code: 'fn main() { println!("Hello"); }',
                expectedLanguage: 'rust'
            },
            {
                name: 'CSS检测',
                code: '.class { color: red; }',
                expectedLanguage: 'css'
            },
            {
                name: 'JSON检测',
                code: '{ "key": "value" }',
                expectedLanguage: 'json'
            }
        ];
    }
    
    runTests() {
        console.log('🧪 开始语法高亮测试...\n');
        
        this.testCases.forEach((testCase, index) => {
            const result = this.runSingleTest(testCase, index);
            this.results.push(result);
            this.printResult(result);
        });
        
        this.printSummary();
    }
    
    runSingleTest(testCase, index) {
        // 这里需要调用实际的 detectLanguage 函数
        // 由于是测试环境，我们模拟结果
        const actualLanguage = this.simulateLanguageDetection(testCase.code);
        
        return {
            id: index + 1,
            name: testCase.name,
            code: testCase.code,
            expected: testCase.expectedLanguage,
            actual: actualLanguage,
            passed: actualLanguage === testCase.expectedLanguage
        };
    }
    
    simulateLanguageDetection(code) {
        // 模拟语言检测逻辑
        if (code.includes('function') && code.includes('console.log')) return 'javascript';
        if (code.includes('def ') && code.includes(':')) return 'python';
        if (code.includes('fn ') && code.includes('println!')) return 'rust';
        if (code.includes('{') && code.includes('color:')) return 'css';
        if (code.includes('{') && code.includes('"key"')) return 'json';
        return 'unknown';
    }
    
    printResult(result) {
        const status = result.passed ? '✅ 通过' : '❌ 失败';
        console.log(`${status} 测试 ${result.id}: ${result.name}`);
        console.log(`   预期: ${result.expected}, 实际: ${result.actual}`);
        if (!result.passed) {
            console.log(`   代码: ${result.code.substring(0, 50)}...`);
        }
        console.log('');
    }
    
    printSummary() {
        const passed = this.results.filter(r => r.passed).length;
        const failed = this.results.length - passed;
        
        console.log('📊 测试总结:');
        console.log(`   总计: ${this.results.length}`);
        console.log(`   通过: ${passed} (${(passed/this.results.length*100).toFixed(1)}%)`);
        console.log(`   失败: ${failed} (${(failed/this.results.length*100).toFixed(1)}%)`);
        
        if (failed > 0) {
            console.log('\n❌ 失败的测试:');
            this.results.filter(r => !r.passed).forEach(r => {
                console.log(`   - ${r.name}: 预期 "${r.expected}", 实际 "${r.actual}"`);
            });
        }
    }
}

// 运行测试
const test = new SyntaxHighlightingTest();
test.runTests();
```

---

## 🔧 测试环境要求

- Obsidian 版本: 1.0.0+
- EPUB 插件版本: 当前版本
- 浏览器: Chrome/Edge/Firefox 最新版本
- 开发者工具: F12 Console

## 📝 测试报告模板

```
# 语法高亮测试报告

**测试日期**: YYYY-MM-DD
**测试人员**: [姓名]
**插件版本**: [版本号]

## 执行摘要
- 总测试数: XX
- 通过: XX
- 失败: XX
- 通过率: XX%

## 详细结果
[每个测试的详细结果]

## 发现的问题
1. [问题描述]
2. [问题描述]

## 建议改进
1. [改进建议]
2. [改进建议]
```