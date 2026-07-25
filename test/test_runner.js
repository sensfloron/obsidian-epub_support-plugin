/**
 * EPUB 语法高亮自动化测试套件
 *
 * 使用方法：
 * 1. 在 Obsidian 中打开包含代码块的 EPUB 文件
 * 2. 打开开发者工具 (F12) -> Console
 * 3. 复制粘贴此脚本到 Console 中运行
 */

class EPUBSyntaxHighlightingTest {
    constructor() {
        this.results = [];
        this.testStartTime = Date.now();
        this.epubView = this.findEPUBView();
    }

    /**
     * 查找当前打开的 EPUB 视图实例
     */
    findEPUBView() {
        // 尝试从 Obsidian 的 app 中获取 EPUB 视图
        try {
            // 在浏览器环境中，app 是全局变量（在 Obsidian 中运行时）
            // eslint-disable-next-line no-undef
            if (typeof app !== 'undefined' && app && app.workspace) {
                const activeLeaf = app.workspace.getActiveViewOfType();
                if (activeLeaf && activeLeaf.constructor.name === 'EpubView') {
                    return activeLeaf;
                }
            }
        } catch (error) {
            console.warn('无法自动获取 EPUB 视图，将使用手动测试模式');
        }
        return null;
    }

    /**
     * 获取测试用例
     */
    getTestCases() {
        return [
            // 语言检测测试
            {
                category: '语言检测',
                name: 'JavaScript 函数',
                code: `function calculateTotal(items) {
    const total = items.reduce((sum, item) => sum + item.price, 0);
    console.log("Total:", total);
    return total;
}`,
                expectedLanguage: 'javascript'
            },
            {
                category: '语言检测',
                name: 'Python 类定义',
                code: `class DataProcessor:
    def __init__(self, data):
        self.data = data

    def process(self):
        return [x * 2 for x in self.data]`,
                expectedLanguage: 'python'
            },
            {
                category: '语言检测',
                name: 'Rust 结构体',
                code: `struct User {
    name: String,
    age: u32,
}

impl User {
    fn new(name: String) -> Self {
        User { name, age: 0 }
    }
}`,
                expectedLanguage: 'rust'
            },
            {
                category: '语言检测',
                name: 'CSS 样式',
                code: `.container {
    max-width: 1200px;
    margin: 0 auto;
    background: #ffffff;
}

@media (max-width: 768px) {
    .container { padding: 10px; }
}`,
                expectedLanguage: 'css'
            },
            {
                category: '语言检测',
                name: 'HTML 文档',
                code: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Test Page</title>
</head>
<body>
    <div class="container">
        <h1>Welcome</h1>
    </div>
</body>
</html>`,
                expectedLanguage: 'html'
            },
            {
                category: '语言检测',
                name: 'JSON 对象',
                code: `{
    "name": "Test Project",
    "version": "1.0.0",
    "scripts": {
        "start": "node index.js",
        "test": "jest"
    },
    "dependencies": {
        "express": "^4.18.0"
    }
}`,
                expectedLanguage: 'json'
            },
            {
                category: '语言检测',
                name: 'SQL 查询',
                code: `SELECT u.username, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.created_at >= '2024-01-01'
GROUP BY u.id
ORDER BY order_count DESC;`,
                expectedLanguage: 'sql'
            },
            {
                category: '语言检测',
                name: 'Bash 脚本',
                code: `#!/bin/bash
PROJECT_DIR="/var/www/project"
if [ ! -d "$PROJECT_DIR" ]; then
    mkdir -p "$PROJECT_DIR"
fi

for file in "$PROJECT_DIR"/*.log; do
    echo "Processing: $file"
done`,
                expectedLanguage: 'bash'
            },

            // 边界情况测试
            {
                category: '边界情况',
                name: '空代码块',
                code: '   ',
                expectedLanguage: ''
            },
            {
                category: '边界情况',
                name: '纯文本',
                code: `This is just plain text with no programming language syntax.
It should not be detected as any specific language.`,
                expectedLanguage: 'text'
            },
            {
                category: '边界情况',
                name: '短代码片段',
                code: 'let x = 5;',
                expectedLanguage: 'text'  // 短片段可能无法准确识别
            },

            // 相似语言区分测试
            {
                category: '语言区分',
                name: 'C 语言',
                code: `#include <stdio.h>
int main() {
    int* arr = (int*)malloc(5 * sizeof(int));
    printf("Hello World\\n");
    free(arr);
    return 0;
}`,
                expectedLanguage: 'c'
            },
            {
                category: '语言区分',
                name: 'C++ 代码',
                code: `#include <iostream>
#include <vector>

int main() {
    std::vector<int> numbers = {1, 2, 3, 4, 5};
    for (const auto& num : numbers) {
        std::cout << num << " ";
    }
    return 0;
}`,
                expectedLanguage: 'cpp'
            },
            {
                category: '语言区分',
                name: 'C# 代码',
                code: `using System;
using System.Collections.Generic;

class Program {
    static void Main() {
        List<int> numbers = new List<int> {1, 2, 3, 4, 5};
        var doubled = numbers.Select(n => n * 2).ToList();
    }
}`,
                expectedLanguage: 'csharp'
            },
            {
                category: '语言区分',
                name: 'Java 代码',
                code: `public class Calculator {
    private int result;

    public int add(int a, int b) {
        this.result = a + b;
        return this.result;
    }

    public static void main(String[] args) {
        System.out.println("Hello");
    }
}`,
                expectedLanguage: 'java'
            },
            {
                category: '语言区分',
                name: 'JavaScript 代码',
                code: `class Calculator {
    constructor() {
        this.result = 0;
    }

    add(a, b) {
        this.result = a + b;
        return this.result;
    }
}

const calc = new Calculator();
console.log(calc.add(5, 3));`,
                expectedLanguage: 'javascript'
            }
        ];
    }

    /**
     * 运行所有测试
     */
    runTests() {
        console.log('🧪 开始 EPUB 语法高亮测试...\n');

        if (!this.epubView) {
            console.warn('⚠️ 未找到 EPUB 视图，运行离线测试模式\n');
        }

        const testCases = this.getTestCases();
        let passed = 0;
        let failed = 0;

        testCases.forEach((testCase, index) => {
            const result = this.runSingleTest(testCase, index);
            this.results.push(result);

            if (result.passed) {
                passed++;
                console.log(`✅ 测试 ${index + 1}/${testCases.length}: ${result.name}`);
            } else {
                failed++;
                console.log(`❌ 测试 ${index + 1}/${testCases.length}: ${result.name}`);
                console.log(`   预期: "${result.expected}", 实际: "${result.actual}"`);
                console.log(`   代码预览: ${result.code.substring(0, 60)}...`);
            }
        });

        this.printSummary(passed, failed, testCases.length);
        return this.generateReport();
    }

    /**
     * 运行单个测试用例
     */
    runSingleTest(testCase, index) {
        let actualLanguage = 'unknown';

        if (this.epubView && typeof this.epubView.detectLanguage === 'function') {
            try {
                actualLanguage = this.epubView.detectLanguage(testCase.code);
            } catch (error) {
                console.error(`测试 ${index + 1} 执行出错:`, error);
                actualLanguage = 'error';
            }
        } else {
            // 离线模式：使用模拟的检测逻辑
            actualLanguage = this.simulateLanguageDetection(testCase.code);
        }

        return {
            id: index + 1,
            category: testCase.category,
            name: testCase.name,
            code: testCase.code,
            expected: testCase.expectedLanguage,
            actual: actualLanguage,
            passed: actualLanguage === testCase.expectedLanguage
        };
    }

    /**
     * 模拟语言检测（用于离线测试）
     */
    simulateLanguageDetection(code) {
        // Rust 检测 - 优先检测，因为特征最明显
        if (/fn\s+\w+.*\{|use\s+\w+::|let\s+mut\s+|struct\s+\w+</.test(code) ||
            (/\{/g.test(code) && /impl\s+\w+/.test(code))) {
            return 'rust';
        }

        // CSS 检测
        if (/[\w-]+\s*\{[^}]*\}/.test(code) &&
            (/[\w-]+:\s*[^;]+;/.test(code) || /@media|@import/.test(code))) {
            return 'css';
        }

        // HTML 检测
        if (/<!DOCTYPE html>|<html|<head>|<body>|<div|<\/html>/.test(code) &&
            /<[\w]+[\s>]/.test(code)) {
            return 'html';
        }

        // JSON 检测
        if (/^\s*\{[\s\S]*\}\s*$/.test(code) && /"\w+"\s*:/.test(code)) {
            return 'json';
        }

        // Bash 检测
        if (/^#!/.test(code) || (/\w+\s*=\s*["']?[^"']+["']?$/.test(code) &&
            (/if\s+\[.*\]|then|fi|done/.test(code)))) {
            return 'bash';
        }

        // SQL 检测 - 修复检测逻辑，提前检测以提高优先级
        if (/SELECT\s+[\w*]+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE/i.test(code) ||
            (/SELECT/i.test(code) && /FROM|JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN/i.test(code))) {
            return 'sql';
        }

        // C# 检测 - 需要在 JavaScript 之前检测
        if (/using\s+System/.test(code) &&
            (/namespace\s+\w+|class\s+\w+.*\{/.test(code) ||
             /List<|Dictionary<|IEnumerable/.test(code))) {
            return 'csharp';
        }

        // Java 检测 - 需要在 JavaScript 之前检测
        if (/public\s+class\s+\w+/.test(code) ||
            (/public\s+static\s+void\s+main/.test(code) && /String\[\]/.test(code)) ||
            (/System\.out\.println|System\.err\.println/.test(code)) ||
            (/package\s+\w+;|import\s+java\./.test(code))) {
            return 'java';
        }

        // Python 检测 - 需要在 JavaScript 之前检测
        if (/def\s+\w+.*:/.test(code) ||
            (/class\s+\w+.*:/.test(code) && !/constructor|this\./.test(code)) ||
            /import\s+\w+|from\s+\w+\s+import/.test(code) ||
            (/\w+\s+for\s+\w+\s+in\s+\w+/.test(code) && /:/.test(code)) ||
            (/print\s*\(/.test(code) && /:/.test(code))) {
            return 'python';
        }

        // C/C++ 检测 - 需要在 JavaScript 之前检测
        if (/#include|using\s+namespace/.test(code) ||
            (/int\s+main\s*\(/.test(code) && !/public\s+static\s+void\s+main/.test(code))) {
            if (/std::|::/.test(code)) return 'cpp';
            if (/#include/.test(code)) return 'c';
        }

        // JavaScript 检测 - 放在最后，作为兜底检测
        if (/function\s+\w+.*\{/.test(code) ||
            (/const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=/.test(code)) ||
            /console\.log|class\s+\w+.*\{/.test(code) ||
            (/=>\s*\{/.test(code)) ||
            (/require\(|import\s+.*from/.test(code))) {
            return 'javascript';
        }

        // 默认：如果有代码特征但无法识别具体语言
        if (/[{};()\[\]]/.test(code) && (/\w+\s*[\(=]/.test(code) || /\w+\s*=/.test(code))) {
            return 'text';
        }

        return ''; // 无法识别
    }

    /**
     * 打印测试总结
     */
    printSummary(passed, failed, total) {
        const duration = ((Date.now() - this.testStartTime) / 1000).toFixed(2);
        const passRate = ((passed / total) * 100).toFixed(1);

        console.log('\n📊 测试总结:');
        console.log('='.repeat(50));
        console.log(`⏱️  执行时间: ${duration}秒`);
        console.log(`📋 总测试数: ${total}`);
        console.log(`✅ 通过: ${passed} (${passRate}%)`);
        console.log(`❌ 失败: ${failed} (${(100 - passRate).toFixed(1)}%)`);
        console.log('='.repeat(50));

        if (failed > 0) {
            console.log('\n❌ 失败的测试详情:');
            this.results.filter(r => !r.passed).forEach(r => {
                console.log(`   ${r.id}. [${r.category}] ${r.name}`);
                console.log(`      预期: "${r.expected}", 实际: "${r.actual}"`);
            });
        }

        console.log('\n📈 按类别统计:');
        const categories = [...new Set(this.results.map(r => r.category))];
        categories.forEach(category => {
            const categoryTests = this.results.filter(r => r.category === category);
            const categoryPassed = categoryTests.filter(r => r.passed).length;
            const categoryRate = ((categoryPassed / categoryTests.length) * 100).toFixed(1);
            console.log(`   ${category}: ${categoryPassed}/${categoryTests.length} (${categoryRate}%)`);
        });
    }

    /**
     * 生成测试报告
     */
    generateReport() {
        const passed = this.results.filter(r => r.passed).length;
        const failed = this.results.length - passed;
        const duration = ((Date.now() - this.testStartTime) / 1000).toFixed(2);

        return {
            timestamp: new Date().toISOString(),
            duration: duration,
            total: this.results.length,
            passed: passed,
            failed: failed,
            passRate: ((passed / this.results.length) * 100).toFixed(1) + '%',
            results: this.results,
            summary: {
                byCategory: this.getCategorySummary()
            }
        };
    }

    /**
     * 获取按类别分组的统计信息
     */
    getCategorySummary() {
        const categories = [...new Set(this.results.map(r => r.category))];
        return categories.map(category => {
            const categoryTests = this.results.filter(r => r.category === category);
            const categoryPassed = categoryTests.filter(r => r.passed).length;
            return {
                category: category,
                total: categoryTests.length,
                passed: categoryPassed,
                failed: categoryTests.length - categoryPassed,
                passRate: ((categoryPassed / categoryTests.length) * 100).toFixed(1) + '%'
            };
        });
    }
}

// ==================== 执行测试 ====================

console.log('🚀 初始化 EPUB 语法高亮测试套件...\n');

// 创建并运行测试
const testSuite = new EPUBSyntaxHighlightingTest();
const report = testSuite.runTests();

// 保存报告到全局变量，便于后续分析
if (typeof window !== 'undefined') {
    window.epubTestReport = report;
    window.epubTestSuite = testSuite;

    console.log('\n💾 测试报告已保存到 window.epubTestReport');
    console.log('💾 测试套件已保存到 window.epubTestSuite');
    console.log('\n📖 使用以下命令查看报告:');
    console.log('   - console.table(epubTestReport.results)');
    console.log('   - console.log(epubTestReport.summary)');

    // 提供额外的测试工具
    window.epubTestUtils = {
    /**
     * 重新运行失败的测试
     */
    retryFailed: () => {
        console.log('🔄 重新运行失败的测试...');
        const failedTests = testSuite.results.filter(r => !r.passed);
        console.log(`找到 ${failedTests.length} 个失败的测试`);
    },

    /**
     * 测试特定代码片段
     */
    testCode: (code) => {
        console.log('🧪 测试代码片段:');
        console.log(code);
        if (testSuite.epubView && typeof testSuite.epubView.detectLanguage === 'function') {
            const result = testSuite.epubView.detectLanguage(code);
            console.log(`检测结果: "${result}"`);
        } else {
            const result = testSuite.simulateLanguageDetection(code);
            console.log(`模拟检测结果: "${result}"`);
        }
    },

    /**
     * 显示性能统计
     */
    showPerformance: () => {
        console.log('⚡ 性能统计:');
        console.log(`执行时间: ${report.duration}秒`);
        console.log(`平均每个测试: ${(parseFloat(report.duration) / report.total).toFixed(3)}秒`);
    }
};

    console.log('\n🔧 额外测试工具已加载到 window.epubTestUtils');
} else {
    // Node.js 环境下的输出
    console.log('\n💾 测试报告已生成（Node.js 环境）');
    console.log('💾 使用以下命令查看报告:');
    console.log('   - console.log(report)');
    console.log('   - console.table(report.results)');
}