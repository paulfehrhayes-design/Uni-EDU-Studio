# block_configurations 配置说明（EDU Studio）

Uni++ EDU Studio 的“机器人配置文件”是一个 JSON 文件，用于描述：

- 左侧工具箱的分类（category）
- 每个分类下有哪些 Blockly Blocks
- 每个 Block 对应生成的 Python 代码片段（codeTemplate）

导入方式见 [README_CN.md](file:///home/unitree/brigham/DEV/Uni-EDU-Studio/README_CN.md#L127-L136)。

## 1. 文件/目录组织

仓库内置的参考配置位于：

- [block_configurations](file:///home/unitree/brigham/DEV/Uni-EDU-Studio/block_configurations)

通常按机器人型号分子目录，例如：

- `block_configurations/g1_basic/g1_basic.json`
- `block_configurations/g1_basic/g1_basic_en.json`

EDU Studio 在运行时并不会自动扫描该目录；它只是在“导入配置”时读取你选择的 `.json` 文件。

## 2. 顶层结构（Category 数组）

配置文件顶层是一个数组，每个元素是一个“分类”对象：

```json
[
  {
    "category": "系统",
    "colour": "230",
    "blocks": [ ... ]
  }
]
```

- `category`: 分类显示名称（工具箱上的 Tab/Category 名称）
- `colour`: 分类颜色（字符串或数字均可）
- `blocks`: 该分类包含的 block 定义数组

## 3. Block 结构（Blockly JSON + EDU 扩展字段）

每个 `blocks[]` 元素基本遵循 Blockly 的 JSON Block Definition（即 `Blockly.defineBlocksWithJsonArray` 的输入格式），同时增加了 EDU Studio 扩展字段：

### 3.1 常用 Blockly 字段（直接用于注册 Block）

- `type`: block 的唯一类型名（同一个配置里必须唯一）
- `message0`: block 文本模板，使用 `%1 %2 ...` 占位符对应 `args0`
- `args0`: 参数数组，描述输入/字段
- `previousStatement` / `nextStatement`: 是否可连接在语句链上
- `output`: 若设置，则该 block 为“表达式块”（有输出）
- `colour` / `style`: 外观

### 3.2 EDU Studio 扩展字段（用于生成 Python）

- `codeTemplate`: Python 代码模板（字符串）
  - 会进行 `{{NAME}}` 占位符替换，其中 `NAME` 来自 `args0[i].name`
  - `field_*`（如 `field_number/field_input/field_dropdown`）用 `block.getFieldValue(name)` 取值
  - `input_value` 用 `generator.valueToCode(block, name, ...)` 取值
  - 若 block 定义了 `output`，`codeTemplate` 应生成一个“表达式”（不要带换行结尾也可）
- `extensions`: 可选。当前项目内置扩展主要用于“自定义代码/函数体编辑按钮”（如 `raw_code`、`python_def_*`）

对应实现参考：

- 工具箱生成： [generateToolboxXML](file:///home/unitree/brigham/DEV/Uni-EDU-Studio/src/App.jsx#L324-L368)
- Block 注册与代码生成： [registerBlocks](file:///home/unitree/brigham/DEV/Uni-EDU-Studio/src/App.jsx#L400-L436)

## 4. 约定与注意事项

- 变量命名：建议在 `codeTemplate` 内使用稳定的 client 变量名（例如 `sport_client`、`armAction_client`），并提供“初始化客户端”的 Block，避免用户手写初始化代码。
- 导入/初始化顺序：建议提供一个“Start/系统初始化/加载依赖/Init 客户端”的组合，用户按顺序拼接即可运行。
- 安全性：面向教学时应优先暴露“安全动作”，避免直接开放低层控制、过高速度、或会导致摔倒/碰撞的动作。

