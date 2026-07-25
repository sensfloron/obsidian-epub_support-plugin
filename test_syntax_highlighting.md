# MarkdownRenderer 语法高亮测试

这个文件用于测试 Obsidian 的 MarkdownRenderer 是否支持语言标识的语法高亮。

## 测试用例

### 1. JavaScript 代码块

```javascript
function helloWorld() {
    console.log("Hello, World!");
    const greeting = "Welcome to JavaScript";
    return greeting;
}
```

### 2. Python 代码块

```python
def hello_world():
    print("Hello, World!")
    greeting = "Welcome to Python"
    return greeting

if __name__ == "__main__":
    hello_world()
```

### 3. Rust 代码块

```rust
fn main() {
    println!("Hello, World!");
    let greeting = String::from("Welcome to Rust");
    println!("{}", greeting);
}
```

### 4. 无语言标识的代码块

```
function test() {
    return "No language specified";
}
```

## 测试说明

如果 Obsidian 的 MarkdownRenderer 正确支持语言标识：
1. 上面的代码块应该有语法高亮（不同颜色显示关键字、字符串等）
2. 最后一个代码块应该显示为纯文本，没有语法高亮
3. 不同语言的高亮模式应该不同（例如 Python 的 `def` 和 JavaScript 的 `function` 颜色不同）

## 验证方法

在 Obsidian 中打开这个文件，观察：
- 代码块是否有颜色高亮
- 不同语言的高亮效果是否不同
- 无语言标识的代码块是否为纯文本样式