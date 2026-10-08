import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { 
  Save, FolderOpen, Download, Settings, Play, Square,
  Code, X, RefreshCw, FileJson, Check, Loader2, Globe,
  Menu, Undo, Redo, Info, ChevronRight, Sidebar, MoreVertical,
  Upload, FileText, Edit3, FunctionSquare
} from 'lucide-react';
import * as Blockly from 'blockly/core';
import { pythonGenerator } from 'blockly/python';
import * as En from 'blockly/msg/en';
import * as Zh from 'blockly/msg/zh-hans';
import 'blockly/blocks';
import g1BasicConfigZh from '../block_configurations/g1_basic/g1_basic.json';
import g1BasicConfigEn from '../block_configurations/g1_basic/g1_basic_en.json';
import { G1_EDU_23_ENV, G1_MOTION_TEMPLATES, SIMULATOR_MODES, buildPlannerMotionCommands, clampScenePoint, createEmptyG1Edu23State, simulateG1Edu23Program } from './sim/g1Edu23Env';
import G1Simulation3D from './components/G1Simulation3D';
import { compileMotionPrompt } from './sim/textToMotion';

const blocklyRuntime = Object.assign({}, Blockly, { Python: pythonGenerator });
window.Blockly = blocklyRuntime;

// ==========================================================================
//  开发模式说明 (Development Mode)
// ==========================================================================
// 1. 在 Canvas 在线预览或简单 HTML 环境中：保持当前代码不变，它会从 CDN 加载 Blockly。
// 2. 在本地 Vite/Webpack 工程中 (NPM)：
//    a. 运行 npm install blockly
//    b. 取消下面几行 import 的注释
//    c. 删除底部的 loadBlocklyScript 相关逻辑
//    d. 将代码中所有的 window.Blockly 替换为 Blockly
// ==========================================================================

/* NPM 模式请取消注释以下内容：
import * as Blockly from 'blockly/core';
import { pythonGenerator } from 'blockly/python';
import * as En from 'blockly/msg/en';
import * as Zh from 'blockly/msg/zh-hans';
import 'blockly/blocks';
*/

// ------------------------------------------------------------------
// 1. 系统核心配置 (System Config - Hardcoded)
// ------------------------------------------------------------------
const SYSTEM_CONFIG_ZH = [
  {
    "category": "系统指令",
    "colour": "210",
    "blocks": [
      {
        "type": "sys_import",
        "message0": "📦 导入库 %1",
        "args0": [{ "type": "field_input", "name": "LIB", "text": "time" }],
        "previousStatement": null, "nextStatement": null, "colour": 210,
        "codeTemplate": "import {{LIB}}\n"
      },
      {
        "type": "raw_code",
        "message0": "📝 自定义代码 %1",
        "args0": [
          { "type": "input_dummy" }
        ],
        "previousStatement": null, "nextStatement": null, "colour": 0,
        "extensions": ["custom_code_button"],
        "codeTemplate": "{{CODE}}\n"
      }
    ]
  },
  {
    "category": "Python 函数",
    "colour": "290",
    "blocks": [
      {
        "type": "python_def_noreturn",
        "message0": "🐍 定义 Python 函数 %1 参数(%2) %3",
        "args0": [
          { "type": "field_input", "name": "NAME", "text": "my_func" },
          { "type": "field_input", "name": "ARGS", "text": "x, y" },
          { "type": "input_dummy" }
        ],
        "style": "procedure_blocks",
        "extensions": ["custom_code_button"],
        "codeTemplate": "def {{NAME}}({{ARGS}}):\n{{CODE}}\n" 
      },
      {
        "type": "python_def_return",
        "message0": "🐍 定义 Python 函数(带返回) %1 参数(%2) %3",
        "args0": [
          { "type": "field_input", "name": "NAME", "text": "calc_sum" },
          { "type": "field_input", "name": "ARGS", "text": "a, b" },
          { "type": "input_dummy" }
        ],
        "style": "procedure_blocks",
        "extensions": ["custom_code_button"],
        "codeTemplate": "def {{NAME}}({{ARGS}}):\n{{CODE}}\n"
      },
      {
        "type": "python_call",
        "message0": "🐍 调用 Python 函数 %1 参数(%2)",
        "args0": [
          { "type": "field_input", "name": "NAME", "text": "my_func" },
          { "type": "field_input", "name": "ARGS", "text": "10, 20" }
        ],
        "previousStatement": null, "nextStatement": null, "colour": 290,
        "codeTemplate": "{{NAME}}({{ARGS}})\n"
      },
      {
        "type": "python_call_return",
        "message0": "🐍 调用 Python 函数(返回) %1 参数(%2)",
        "args0": [
          { "type": "field_input", "name": "NAME", "text": "calc_sum" },
          { "type": "field_input", "name": "ARGS", "text": "10, 20" }
        ],
        "output": null, "colour": 290,
        "codeTemplate": "{{NAME}}({{ARGS}})"
      }
    ]
  }
];

const SYSTEM_CONFIG_EN = [
  {
    "category": "System",
    "colour": "210",
    "blocks": [
      { "type": "sys_import", "message0": "📦 Import Library %1", "args0": [{ "type": "field_input", "name": "LIB", "text": "time" }], "previousStatement": null, "nextStatement": null, "colour": 210, "codeTemplate": "import {{LIB}}\n" },
      { "type": "raw_code", "message0": "📝 Custom Snippet %1", "args0": [{ "type": "input_dummy" }], "previousStatement": null, "nextStatement": null, "colour": 0, "extensions": ["custom_code_button"], "codeTemplate": "{{CODE}}\n" }
    ]
  },
  {
    "category": "Python Funcs",
    "colour": "290",
    "blocks": [
      {
        "type": "python_def_noreturn",
        "message0": "🐍 Def Python Func %1 Args(%2) %3",
        "args0": [{ "type": "field_input", "name": "NAME", "text": "my_func" }, { "type": "field_input", "name": "ARGS", "text": "x, y" }, { "type": "input_dummy" }],
        "style": "procedure_blocks", "extensions": ["custom_code_button"], "codeTemplate": "def {{NAME}}({{ARGS}}):\n{{CODE}}\n" 
      },
      {
        "type": "python_def_return",
        "message0": "🐍 Def Python Func(Return) %1 Args(%2) %3",
        "args0": [{ "type": "field_input", "name": "NAME", "text": "calc_sum" }, { "type": "field_input", "name": "ARGS", "text": "a, b" }, { "type": "input_dummy" }],
        "style": "procedure_blocks", "extensions": ["custom_code_button"], "codeTemplate": "def {{NAME}}({{ARGS}}):\n{{CODE}}\n"
      },
      { "type": "python_call", "message0": "🐍 Call Python Func %1 Args(%2)", "args0": [{ "type": "field_input", "name": "NAME", "text": "my_func" }, { "type": "field_input", "name": "ARGS", "text": "10, 20" }], "previousStatement": null, "nextStatement": null, "colour": 290, "codeTemplate": "{{NAME}}({{ARGS}})\n" },
      { "type": "python_call_return", "message0": "🐍 Call Python Func(Return) %1 Args(%2)", "args0": [{ "type": "field_input", "name": "NAME", "text": "calc_sum" }, { "type": "field_input", "name": "ARGS", "text": "10, 20" }], "output": null, "colour": 290, "codeTemplate": "{{NAME}}({{ARGS}})" }
    ]
  }
];

// ------------------------------------------------------------------
// 2. 机器人配置 (Robot Config - User Editable)
// ------------------------------------------------------------------
const DEFAULT_ROBOT_CONFIG_ZH = g1BasicConfigZh;
const DEFAULT_ROBOT_CONFIG_EN = g1BasicConfigEn;

const UI_TEXT = {
  zh: {
    appName: "Uni++ EDU Studio",
    version: "v2.1 Stable",
    menuFile: "文件", menuEdit: "编辑", menuView: "视图", menuHelp: "帮助",
    actNew: "新建项目", actOpen: "打开项目 (.json)", actSave: "保存项目 (.json)", actExportPy: "导出 Python (.py)",
    actUndo: "撤销", actRedo: "重做", actToggleCode: "切换代码预览", actAbout: "关于",
    actConfigImport: "导入配置", actConfigExport: "导出配置",
    configTitle: "机器人积木配置",
    configDesc: "在此自定义机器人专属积木。系统积木和函数积木已内置，无需在此编辑。",
    applyBtn: "应用配置", closeBtn: "关闭", resetBtn: "恢复默认", confirmBtn: "确定", cancelBtn: "取消",
    codeTitle: "PYTHON 预览", loading: "正在加载引擎资源...",
    aboutContent: "Uni++ EDU Studio 是一个专为 Unitree 机器人设计的图形化编程环境。",
    editorTitle: "编辑代码内容", editorSave: "保存并关闭",
    toolbox: { functions: "图形化函数", logic: "逻辑", loops: "循环", math: "数学", text: "文本", variables: "变量" },
    confirmClear: "确定要新建项目吗？当前未保存的进度将会丢失。",
    btnRun: "运行", btnStop: "停止", statusRunning: "运行中..."
  },
  en: {
    appName: "Uni++ EDU Studio",
    version: "v2.1 Stable",
    menuFile: "File", menuEdit: "Edit", menuView: "View", menuHelp: "Help",
    actNew: "New Project", actOpen: "Open Project (.json)", actSave: "Save Project (.json)", actExportPy: "Export Python (.py)",
    actUndo: "Undo", actRedo: "Redo", actToggleCode: "Toggle Code View", actAbout: "About",
    actConfigImport: "Import Config", actConfigExport: "Export Config",
    configTitle: "Robot Block Config",
    configDesc: "Customize robot-specific blocks here. System blocks are built-in.",
    applyBtn: "Apply Config", closeBtn: "Close", resetBtn: "Reset Default", confirmBtn: "OK", cancelBtn: "Cancel",
    codeTitle: "PYTHON PREVIEW", loading: "Loading Engine Resources...",
    aboutContent: "Uni++ EDU Studio is a graphical programming environment for Unitree Robots.",
    editorTitle: "Edit Code Content", editorSave: "Save & Close",
    toolbox: { functions: "Functions", logic: "Logic", loops: "Loops", math: "Math", text: "Text", variables: "Variables" },
    confirmClear: "Are you sure you want to create a new project? Unsaved progress will be lost.",
    btnRun: "Run", btnStop: "Stop", statusRunning: "Running..."
  }
};

const MenuItem = ({ label, shortcut, onClick, icon: Icon, danger }) => (
  <button onClick={onClick} className={`w-full text-left px-4 py-1.5 text-sm flex items-center justify-between hover:bg-blue-50 transition-colors ${danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-700'}`}>
    <div className="flex items-center gap-2">{Icon && <Icon size={14} className="opacity-70" />}<span>{label}</span></div>
    {shortcut && <span className="text-xs text-gray-400 font-mono ml-4">{shortcut}</span>}
  </button>
);

const OBJECT_LIBRARY = [
  { id: 'box', label: 'Box', icon: '▣', defaultRadius: 10, color: '#60a5fa' },
  { id: 'wall', label: 'Wall', icon: '▭', defaultRadius: 12, color: '#f59e0b' },
  { id: 'platform', label: 'Platform', icon: '▤', defaultRadius: 14, color: '#34d399' },
  { id: 'ramp', label: 'Ramp', icon: '⟋', defaultRadius: 11, color: '#a78bfa' },
  { id: 'stairs', label: 'Stairs', icon: '▥', defaultRadius: 10, color: '#fbbf24' },
  { id: 'sphere', label: 'Sphere', icon: '◉', defaultRadius: 9, color: '#cbd5e1' },
  { id: 'cylinder', label: 'Cylinder', icon: '◍', defaultRadius: 9, color: '#fca5a5' },
  { id: 'table', label: 'Table', icon: '◫', defaultRadius: 16, color: '#94a3b8' },
  { id: 'terrain', label: 'Terrain', icon: '◌', defaultRadius: 15, color: '#86efac' },
];

const SAFE_COMMAND_LIMITS = {
  SPEED: { min: 0.5, max: 2 },
  STEPS: { min: 1, max: 10 },
  ANGLE: { min: 5, max: 180 },
  DEGREES: { min: 0, max: 180 },
  SECONDS: { min: 0.1, max: 5 },
  TIME: { min: 0, max: 10 },
};

const clampSafeValue = (fieldName, rawValue) => {
  const limiter = SAFE_COMMAND_LIMITS[fieldName];
  if (!limiter) return Number(rawValue) || 0;

  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) return limiter.min;
  return Math.min(limiter.max, Math.max(limiter.min, numeric));
};

const sanitizeRobotCode = (code = '') => {
  if (!code || !code.trim()) return code;

  const sanitizeNumber = (rawValue, fieldName) => clampSafeValue(fieldName, rawValue).toString();

  let sanitized = code;
  let changed = false;
  sanitized = sanitized.replace(/robot\.walkForward\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'SPEED');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkForward(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.walkForwardSteps\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'STEPS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkForward(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.walkBackward\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'SPEED');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkBackward(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.walkBackwardSteps\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'STEPS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkBackward(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.walkSidewaysLeft\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'SPEED');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkSidewaysLeft(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.walkSidewaysLeftSteps\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'STEPS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkSidewaysLeft(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.walkSidewaysRight\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'SPEED');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkSidewaysRight(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.walkSidewaysRightSteps\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'STEPS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkSidewaysRight(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.turnLeft\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'ANGLE');
    if (safeValue !== value.trim()) changed = true;
    return `robot.turnLeft(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.turnRight\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'ANGLE');
    if (safeValue !== value.trim()) changed = true;
    return `robot.turnRight(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.raiseLeftArm\(([^)]+)\)/g, (_, value) => {
    const parts = value.split(',').map((part) => part.trim());
    const position = parts[0] || 'mid';
    const degrees = sanitizeNumber(parts[1] || 90, 'DEGREES');
    if (degrees !== (parts[1] || '90').trim()) changed = true;
    return `robot.raiseLeftArm(${position}, ${degrees});`;
  });
  sanitized = sanitized.replace(/robot\.raiseRightArm\(([^)]+)\)/g, (_, value) => {
    const parts = value.split(',').map((part) => part.trim());
    const position = parts[0] || 'mid';
    const degrees = sanitizeNumber(parts[1] || 90, 'DEGREES');
    if (degrees !== (parts[1] || '90').trim()) changed = true;
    return `robot.raiseRightArm(${position}, ${degrees});`;
  });
  sanitized = sanitized.replace(/robot\.raiseLeftLeg\(([^)]+)\)/g, (_, value) => {
    const parts = value.split(',').map((part) => part.trim());
    const position = parts[0] || 'mid';
    const degrees = sanitizeNumber(parts[1] || 90, 'DEGREES');
    if (degrees !== (parts[1] || '90').trim()) changed = true;
    return `robot.raiseLeftLeg(${position}, ${degrees});`;
  });
  sanitized = sanitized.replace(/robot\.raiseRightLeg\(([^)]+)\)/g, (_, value) => {
    const parts = value.split(',').map((part) => part.trim());
    const position = parts[0] || 'mid';
    const degrees = sanitizeNumber(parts[1] || 90, 'DEGREES');
    if (degrees !== (parts[1] || '90').trim()) changed = true;
    return `robot.raiseRightLeg(${position}, ${degrees});`;
  });
  sanitized = sanitized.replace(/robot\.wait\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'SECONDS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.wait(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.waitSeconds\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'SECONDS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.wait(${safeValue});`;
  });
  sanitized = sanitized.replace(/robot\.repeatLoop\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'STEPS');
    if (safeValue !== value.trim()) changed = true;
    return `for (let i = 0; i < ${safeValue}; i++) {\n  robot.raiseBothArms();\n}\n`;
  });
  sanitized = sanitized.replace(/robot\.stop\(\)/g, () => 'robot.stop();');
  sanitized = sanitized.replace(/robot\.sit\(\)/g, () => 'robot.sit();');
  sanitized = sanitized.replace(/robot\.lowerBothArms\(\)/g, () => 'robot.lowerBothArms();');
  sanitized = sanitized.replace(/robot\.waveRight\(\)/g, () => 'robot.waveRight();');
  return { code: sanitized, changed };
};

const ROBOT_IDE_COMMAND_BLOCKS = [
  {
    type: 'robot_stand',
    message0: 'Robot Stand',
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.stand();\n',
  },
  {
    type: 'robot_walk_forward',
    message0: 'Walk Forward',
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.walkForward();\n',
  },
  {
    type: 'robot_walk_back',
    message0: 'Walk Back',
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.walkBackward();\n',
  },
  {
    type: 'robot_walk_sideways_left',
    message0: 'Walk Sideways Left',
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.walkSidewaysLeft();\n',
  },
  {
    type: 'robot_walk_sideways_right',
    message0: 'Walk Sideways Right',
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.walkSidewaysRight();\n',
  },
  {
    type: 'robot_walk_forward_steps',
    message0: 'Walk Forward %1 steps',
    args0: [{ type: 'field_number', name: 'STEPS', value: 3, min: 1, max: 10 }],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.walkForwardSteps({{STEPS}});\n',
  },
  {
    type: 'robot_walk_back_steps',
    message0: 'Walk Back %1 steps',
    args0: [{ type: 'field_number', name: 'STEPS', value: 3, min: 1, max: 10 }],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.walkBackwardSteps({{STEPS}});\n',
  },
  {
    type: 'robot_walk_sideways_left_steps',
    message0: 'Walk Left %1 steps',
    args0: [{ type: 'field_number', name: 'STEPS', value: 2, min: 1, max: 10 }],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.walkSidewaysLeftSteps({{STEPS}});\n',
  },
  {
    type: 'robot_walk_sideways_right_steps',
    message0: 'Walk Right %1 steps',
    args0: [{ type: 'field_number', name: 'STEPS', value: 2, min: 1, max: 10 }],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.walkSidewaysRightSteps({{STEPS}});\n',
  },
  {
    type: 'robot_walk_forward_speed',
    message0: 'Walk Forward at 2 Times Speed',
    args0: [{ type: 'field_number', name: 'SPEED', value: 2, min: 0.5, max: 5, precision: 0.5 }],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.walkForward({{SPEED}});\n',
  },
  {
    type: 'robot_walk_forward_half_speed',
    message0: 'Walk Forward at 1/2 Speed',
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.walkForward(0.5);\n',
  },
  {
    type: 'robot_turn_left',
    message0: 'Turn Left %1°',
    args0: [{ type: 'field_number', name: 'ANGLE', value: 90, min: 1, max: 360 }],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.turnLeft({{ANGLE}});\n',
  },
  {
    type: 'robot_turn_right',
    message0: 'Turn Right %1°',
    args0: [{ type: 'field_number', name: 'ANGLE', value: 90, min: 1, max: 360 }],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.turnRight({{ANGLE}});\n',
  },
  {
    type: 'robot_raise_left_arm',
    message0: 'Raise Left Arm %1 %2°',
    args0: [
      { type: 'field_dropdown', name: 'POSITION', options: [['High', 'high'], ['Mid', 'mid'], ['Low', 'low']] },
      { type: 'field_number', name: 'DEGREES', value: 90, min: 0, max: 180 },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.raiseLeftArm("{{POSITION}}", {{DEGREES}});\n',
  },
  {
    type: 'robot_raise_right_arm',
    message0: 'Raise Right Arm %1 %2°',
    args0: [
      { type: 'field_dropdown', name: 'POSITION', options: [['High', 'high'], ['Mid', 'mid'], ['Low', 'low']] },
      { type: 'field_number', name: 'DEGREES', value: 90, min: 0, max: 180 },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.raiseRightArm("{{POSITION}}", {{DEGREES}});\n',
  },
  {
    type: 'robot_left_leg_kick',
    message0: 'Left Leg Kick %1 %2°',
    args0: [
      { type: 'field_dropdown', name: 'POSITION', options: [['High', 'high'], ['Mid', 'mid'], ['Low', 'low']] },
      { type: 'field_number', name: 'DEGREES', value: 90, min: 0, max: 180 },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.raiseLeftLeg("{{POSITION}}", {{DEGREES}});\n',
  },
  {
    type: 'robot_right_leg_kick',
    message0: 'Right Leg Kick %1 %2°',
    args0: [
      { type: 'field_dropdown', name: 'POSITION', options: [['High', 'high'], ['Mid', 'mid'], ['Low', 'low']] },
      { type: 'field_number', name: 'DEGREES', value: 90, min: 0, max: 180 },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.raiseRightLeg("{{POSITION}}", {{DEGREES}});\n',
  },
  {
    type: 'robot_raise_left_knee',
    message0: 'Raise Left Knee',
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.raiseLeftKnee();\n',
  },
  {
    type: 'robot_raise_right_knee',
    message0: 'Raise Right Knee',
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.raiseRightKnee();\n',
  },
  {
    type: 'robot_wait',
    message0: 'Wait %1 s',
    args0: [{ type: 'field_number', name: 'SECONDS', value: 0.5, min: 0.1, precision: 0.1 }],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.wait({{SECONDS}});\n',
  },
  {
    type: 'robot_wait_seconds',
    message0: 'Wait %1 seconds',
    args0: [{ type: 'field_number', name: 'SECONDS', value: 1, min: 0.1, max: 5, precision: 0.1 }],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.waitSeconds({{SECONDS}});\n',
  },
  {
    type: 'robot_repeat_loop',
    message0: 'Repeat %1 times',
    args0: [{ type: 'field_number', name: 'TIMES', value: 3, min: 1, max: 20 }],
    previousStatement: null,
    nextStatement: null,
    colour: 120,
    codeTemplate: 'robot.repeatLoop({{TIMES}});\n',
  },
  {
    type: 'robot_stop',
    message0: 'Stop',
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.stop();\n',
  },
  {
    type: 'robot_sit',
    message0: 'Sit',
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.sit();\n',
  },
  {
    type: 'robot_wave_left',
    message0: 'Wave Left',
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.waveLeft();\n',
  },
  {
    type: 'robot_wave_right',
    message0: 'Wave Right',
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.waveRight();\n',
  },
  {
    type: 'robot_raise_both_arms',
    message0: 'Raise Both Arms',
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.raiseBothArms();\n',
  },
  {
    type: 'robot_lower_both_arms',
    message0: 'Lower Both Arms',
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.lowerBothArms();\n',
  },
  {
    type: 'robot_kick',
    message0: 'Kick %1',
    args0: [{ type: 'field_dropdown', name: 'LEVEL', options: [['Low', 'low'], ['Mid', 'mid'], ['High', 'high']] }],
    previousStatement: null,
    nextStatement: null,
    colour: 280,
    codeTemplate: 'robot.kick("{{LEVEL}}");\n',
  },
];

export default function App() {
  const blocklyDiv = useRef(null);
  const workspaceRef = useRef(null);
  const promptInputRef = useRef(null);
  const codeEditorRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const fileInputRef = useRef(null);
  const compiledPlannerCodeRef = useRef(null);
  
  const [lang, setLang] = useState('en');
  const [robotConfig, setRobotConfig] = useState(DEFAULT_ROBOT_CONFIG_EN);
  const compiledCode = commands.join('\n');
  compiledPlannerCodeRef.current = compiledCode;
  updateGeneratedCode(compiledCode);
  const generatedCodeRef = useRef('');
  const [configText, setConfigText] = useState(JSON.stringify(DEFAULT_ROBOT_CONFIG_EN, null, 2));
  
  const [activeMenu, setActiveMenu] = useState(null);
  const [showConfigEditor, setShowConfigEditor] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [isBlocklyLoaded, setIsBlocklyLoaded] = useState(false);
  
  const [promptState, setPromptState] = useState({ isOpen: false, message: '', defaultValue: '', callback: null, inputValue: '' });
  const [codeEditorState, setCodeEditorState] = useState({ isOpen: false, blockId: null, code: '' });

  // 运行状态管理
  const [isRunning, setIsRunning] = useState(false);
  const [mainTab, setMainTab] = useState('blocks');
  const [toolPanelRect, setToolPanelRect] = useState({ top: 12, right: 16, width: 520, height: 760 });
  const [toolPanelCollapsed, setToolPanelCollapsed] = useState(false);
  const toolPanelInteractionRef = useRef(null);
  const [isSimulatorOpen, setIsSimulatorOpen] = useState(false);
  const [motionPrompt, setMotionPrompt] = useState('Walk forward 3 steps, turn left 90 degrees, then wave');
  const [motionPromptResult, setMotionPromptResult] = useState(null);
  const [motionPromptStatus, setMotionPromptStatus] = useState('local');
  const [simulatorMode, setSimulatorMode] = useState('kid-preview');
  const [simulatorSidebarTab, setSimulatorSidebarTab] = useState('add-object');
  const [sceneObjects, setSceneObjects] = useState([]);
  const [activeDragItem, setActiveDragItem] = useState(null);
  const [projectName, setProjectName] = useState('default');
  const [projectLibrary, setProjectLibrary] = useState([]);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [gridSize, setGridSize] = useState(20);
  const [plannerWaypoints, setPlannerWaypoints] = useState([]);
  const [simulatorState, setSimulatorState] = useState(createEmptyG1Edu23State());
  const [session, setSession] = useState(() => {
    try {
      const cached = localStorage.getItem('edu-classroom-session');
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  const currentUser = session?.user ?? { role: 'student', username: 'guest' };
  const [savedCodes, setSavedCodes] = useState([]);
  const [queueItems, setQueueItems] = useState([]);
  const [teacherRoster, setTeacherRoster] = useState([]);
  const [loginForm, setLoginForm] = useState({ username: 'teacher', password: 'teacher', role: 'teacher' });
  const [signupForm, setSignupForm] = useState({ username: '', password: '', role: 'student' });
  const [authMode, setAuthMode] = useState('login');
  const [loginError, setLoginError] = useState('');
  const [classroomStatus, setClassroomStatus] = useState('idle');
  const [robotAddress, setRobotAddress] = useState('192.168.123.164');
  const [robotConnectionStatus, setRobotConnectionStatus] = useState('Not connected');
  const [isRobotConnected, setIsRobotConnected] = useState(false);
  const [safetyNotice, setSafetyNotice] = useState('');

  const t = UI_TEXT[lang];
  const sceneObjectsKey = session?.user?.username ? `edu-scene-objects:${session.user.username}` : 'edu-scene-objects';

  useEffect(() => {
    generatedCodeRef.current = generatedCode;
  }, [generatedCode]);
  const insertRobotCommandWithValue = (commandType, defaultValue = 3, unitLabel = 'steps') => {
    const valueText = window.prompt(`Enter ${unitLabel}:`, String(defaultValue));
    if (valueText === null) return;

    const numericValue = Number(valueText);
    if (!Number.isFinite(numericValue)) {
      alert(`Please enter a valid ${unitLabel}.`);
      return;
    }

    const commandMap = {
      walkForward: `robot.walkForward(${clampSafeValue('STEPS', numericValue)});`,
      walkBackward: `robot.walkBackward(${clampSafeValue('STEPS', numericValue)});`,
      walkSidewaysLeft: `robot.walkSidewaysLeft(${clampSafeValue('STEPS', numericValue)});`,
      walkSidewaysRight: `robot.walkSidewaysRight(${clampSafeValue('STEPS', numericValue)});`,
      wait: `robot.wait(${clampSafeValue('SECONDS', numericValue)});`,
      repeat: `robot.repeatLoop(${clampSafeValue('STEPS', numericValue)});`,
      raiseBothArms: 'robot.raiseBothArms();',
      lowerBothArms: 'robot.lowerBothArms();',
      stop: 'robot.stop();',
      sit: 'robot.sit();',
    };

    const snippet = commandMap[commandType];
    if (!snippet) return;

    insertRobotCommand(snippet);
  };

  const quickRobotCommands = [
    { label: 'robot.stand();', snippet: 'robot.stand();' },
    { label: 'robot.stop();', snippet: 'robot.stop();' },
    { label: 'robot.sit();', snippet: 'robot.sit();' },
    { label: 'robot.walkForward();', snippet: 'robot.walkForward();' },
    { label: 'Walk Forward (steps)', action: () => insertRobotCommandWithValue('walkForward', 3, 'steps') },
    { label: 'robot.walkBackward();', snippet: 'robot.walkBackward();' },
    { label: 'Walk Back (steps)', action: () => insertRobotCommandWithValue('walkBackward', 3, 'steps') },
    { label: 'Walk Left (steps)', action: () => insertRobotCommandWithValue('walkSidewaysLeft', 2, 'steps') },
    { label: 'Walk Right (steps)', action: () => insertRobotCommandWithValue('walkSidewaysRight', 2, 'steps') },
    { label: 'robot.turnLeft(90);', snippet: 'robot.turnLeft(90);' },
    { label: 'robot.turnRight(90);', snippet: 'robot.turnRight(90);' },
    { label: 'robot.raiseBothArms();', snippet: 'robot.raiseBothArms();' },
    { label: 'robot.lowerBothArms();', snippet: 'robot.lowerBothArms();' },
    { label: 'robot.raiseLeftArm("high", 90);', snippet: 'robot.raiseLeftArm("high", 90);' },
    { label: 'robot.raiseRightArm("mid", 90);', snippet: 'robot.raiseRightArm("mid", 90);' },
    { label: 'robot.raiseLeftKnee();', snippet: 'robot.raiseLeftKnee();' },
    { label: 'robot.raiseRightKnee();', snippet: 'robot.raiseRightKnee();' },
    { label: 'Wait (seconds)', action: () => insertRobotCommandWithValue('wait', 1, 'seconds') },
    { label: 'Repeat (times)', action: () => insertRobotCommandWithValue('repeat', 3, 'times') },
    { label: 'robot.waveLeft();', snippet: 'robot.waveLeft();' },
    { label: 'robot.waveRight();', snippet: 'robot.waveRight();' },
  ];

  const overlayTabs = [
    { id: 'blocks', label: 'Blocks' },
    { id: 'ide', label: 'IDE' },
    { id: 'planner', label: 'Path Planner' },
    { id: 'prompt', label: 'Prompt to Motion' },
    { id: 'camera', label: 'Vision to Motion' },
  ];

  const apiFetch = async (url, options = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(options.headers || {}),
    };

    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};

    if (!res.ok) {
      throw new Error(data.detail || data.message || 'Request failed');
    }
    return data;
  };

  const refreshClassroomData = useCallback(async () => {
    if (!session?.token) return;
    try {
      const [codesRes, queueRes, usersRes, statusRes, projectsRes] = await Promise.all([
        apiFetch('/api/classroom/codes'),
        session.user.role === 'teacher' ? apiFetch('/api/classroom/queue') : Promise.resolve({ items: [] }),
        session.user.role === 'teacher' ? apiFetch('/api/classroom/users') : Promise.resolve({ users: [] }),
        apiFetch('/api/classroom/status'),
        session.user.role === 'teacher' ? apiFetch('/api/classroom/projects/all') : apiFetch('/api/classroom/projects')
      ]);
      setSavedCodes(codesRes.codes || []);
      setQueueItems(queueRes.items || []);
      setTeacherRoster(usersRes.users || []);
      setClassroomStatus(statusRes.status || 'idle');
      setProjectLibrary(projectsRes.projects || []);
    } catch (err) {
      console.error('Failed to refresh classroom data:', err);
    }
  }, [session]);

  useEffect(() => {
    if (session) {
      localStorage.setItem('edu-classroom-session', JSON.stringify(session));
      const savedSceneObjects = localStorage.getItem(sceneObjectsKey);
      if (savedSceneObjects) {
        try {
          setSceneObjects(JSON.parse(savedSceneObjects));
        } catch {
          setSceneObjects([]);
        }
      } else {
        setSceneObjects([]);
      }
      refreshClassroomData();
      apiFetch('/api/classroom/project?name=default')
        .then((response) => {
          if (response.project && Array.isArray(response.project.sceneObjects)) {
            setSceneObjects(response.project.sceneObjects);
          }
          if (response.project && Array.isArray(response.project.plannerWaypoints)) {
            setPlannerWaypoints(response.project.plannerWaypoints);
          }
          if (response.project && typeof response.project.generatedCode === 'string') {
            applyGeneratedCode(response.project.generatedCode, { syncBlocks: true });
          }
        })
        .catch(() => {
          // fallback to local storage only if no backend project exists
        });
    } else {
      localStorage.removeItem('edu-classroom-session');
    }
  }, [session, refreshClassroomData, sceneObjectsKey]);

  useEffect(() => {
    if (session?.user?.username) {
      localStorage.setItem(sceneObjectsKey, JSON.stringify(sceneObjects));
    }
  }, [sceneObjects, sceneObjectsKey, session]);

  useEffect(() => {
    if (!session?.user?.username) return;
    const timer = setTimeout(() => {
      apiFetch('/api/classroom/project/save', {
        method: 'POST',
        body: JSON.stringify({
          name: projectName,
          sceneObjects,
          plannerWaypoints,
          generatedCode,
        }),
      }).catch(() => {
        // keep the local app responsive even if the backend sync is delayed
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [session, projectName, sceneObjects, plannerWaypoints, generatedCode]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setLoginError('');
    try {
      const response = await apiFetch('/api/classroom/login', {
        method: 'POST',
        body: JSON.stringify(loginForm)
      }, false);
      setSession({ token: response.token, user: response.user });
    } catch (err) {
      setLoginError(err.message);
    }
  };

  const handleSignup = async (event) => {
    event.preventDefault();
    setLoginError('');
    try {
      const response = await apiFetch('/api/classroom/signup', {
        method: 'POST',
        body: JSON.stringify(signupForm)
      }, false);
      setSession({ token: response.token, user: response.user });
      setAuthMode('login');
    } catch (err) {
      setLoginError(err.message);
    }
  };

  const handleLogout = () => {
    setSession(null);
    setSavedCodes([]);
    setQueueItems([]);
    setClassroomStatus('idle');
  };

  const handleSaveCodeToAccount = async () => {
    if (!session) return;
    const codeName = `${session.user.username}-program-${new Date().toISOString().slice(0, 10)}`;
    try {
      await apiFetch('/api/classroom/save-code', {
        method: 'POST',
        body: JSON.stringify({ name: codeName, code: generatedCode || '# No code generated yet' })
      });
      await refreshClassroomData();
      alert('Saved to your account.');
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
  };

  const handleSubmitToQueue = async () => {
    if (!session) return;
    try {
      await apiFetch('/api/classroom/submit-code', {
        method: 'POST',
        body: JSON.stringify({
          name: `${session.user.username}-submission-${new Date().toLocaleTimeString()}`,
          code: generatedCode || '# No code generated yet'
        })
      });
      await refreshClassroomData();
      alert('Submitted to the teacher queue.');
    } catch (e) {
      alert('Submission failed: ' + e.message);
    }
  };

  const handleRunNext = async () => {
    try {
      const response = await apiFetch('/api/classroom/run-next', { method: 'POST' });
      setClassroomStatus(response.status || 'running');
      await refreshClassroomData();
      alert('Started the next queued student job.');
    } catch (e) {
      alert('Could not start next queue item: ' + e.message);
    }
  };

  const handleStopCurrent = async () => {
    try {
      await apiFetch('/api/classroom/stop-current', { method: 'POST' });
      await refreshClassroomData();
      alert('Robot run paused.');
    } catch (e) {
      alert('Pause failed: ' + e.message);
    }
  };

  const handleDeleteQueueItem = async (id) => {
    try {
      await apiFetch(`/api/classroom/delete-item/${id}`, { method: 'POST' });
      await refreshClassroomData();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  };

  const handleClearQueue = async () => {
    try {
      await apiFetch('/api/classroom/clear-queue', { method: 'POST' });
      await refreshClassroomData();
    } catch (e) {
      alert('Clear queue failed: ' + e.message);
    }
  };

  const handleConnectRobot = () => {
    if (!session || session.user.role !== 'teacher') {
      alert('Teacher login is required to connect the robot.');
      return;
    }

    const cleanAddress = robotAddress.trim();
    if (!cleanAddress) {
      alert('Please enter the G1 IP address first.');
      return;
    }

    setRobotConnectionStatus(`Connecting to ${cleanAddress}...`);
    setTimeout(() => {
      setIsRobotConnected(true);
      setRobotConnectionStatus(`Connected to ${cleanAddress} • ready for classroom queue`);
    }, 400);
  };

  useEffect(() => {
    const handleClickOutside = () => setActiveMenu(null);
    window.addEventListener('click', handleClickOutside);
    // 全局函数供 Blockly Extension 调用
    window.OPEN_BLOCK_CODE_EDITOR = (blockId, currentCode) => {
      setCodeEditorState({ isOpen: true, blockId, code: currentCode || '' });
    };
    return () => {
      window.removeEventListener('click', handleClickOutside);
      delete window.OPEN_BLOCK_CODE_EDITOR;
    };
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        window.Blockly = Object.assign({}, Blockly, { Python: pythonGenerator });
        if (typeof window.Blockly.setLocale === 'function') {
          window.Blockly.setLocale(lang === 'zh' ? Zh : En);
        }
        if (window.Blockly.Msg) {
          window.Blockly.Msg["PROCEDURES_DEFNORETURN_TITLE"] = lang === 'zh' ? "功能名称：" : "Function Name:";
          window.Blockly.Msg["PROCEDURES_DEFRETURN_TITLE"] = lang === 'zh' ? "功能名称：" : "Function Name:";
        }
      } catch (error) {
        console.error('Blockly startup configuration failed; continuing with default locale.', error);
      } finally {
        setIsBlocklyLoaded(true);
      }
    }
  }, [lang]);

  const toggleLanguage = () => {
    const newLang = lang === 'zh' ? 'en' : 'zh';
    setLang(newLang);
    const targetDefault = newLang === 'zh' ? DEFAULT_ROBOT_CONFIG_ZH : DEFAULT_ROBOT_CONFIG_EN;
    setConfigText(JSON.stringify(targetDefault, null, 2));
    setRobotConfig(targetDefault);
  };

  const resetRobotConfig = () => {
    const targetDefault = lang === 'zh' ? DEFAULT_ROBOT_CONFIG_ZH : DEFAULT_ROBOT_CONFIG_EN;
    setConfigText(JSON.stringify(targetDefault, null, 2));
    setRobotConfig(targetDefault);
  };

  const generateToolboxXML = useCallback((robotCategories, language) => {
    const cats = UI_TEXT[language].toolbox;
    const systemCategories = language === 'zh' ? SYSTEM_CONFIG_ZH : SYSTEM_CONFIG_EN;
    const fullCategories = [...systemCategories, ...robotCategories];
    const robotIdeCategory = `
      <category name="Robot IDE" colour="210">
        ${ROBOT_IDE_COMMAND_BLOCKS.map(block => `<block type="${block.type}"></block>`).join('')}
      </category>
    `;

    const customCategoriesXml = fullCategories.map(cat => {
      const blocksXml = cat.blocks.map(block => {
        const inputs = block.args0?.filter(arg => arg.type === 'input_value') || [];
        let innerXml = '';
        inputs.forEach(input => {
          if (input.check === 'Number') innerXml += `<value name="${input.name}"><shadow type="math_number"><field name="NUM">0</field></shadow></value>`;
        });
        return `<block type="${block.type}">${innerXml}</block>`;
      }).join('');
      return `<category name="${cat.category}" colour="${cat.colour}">${blocksXml}</category>`;
    }).join('');

    return `
    <xml xmlns="https://developers.google.com/blockly/xml">
      ${customCategoriesXml}
      ${robotIdeCategory}
      <category name="${cats.functions}" colour="290" custom="PROCEDURE"></category>
      <sep></sep>
      <category name="${cats.logic}" colour="210">
        <block type="controls_if"></block>
        <block type="logic_compare"></block>
        <block type="logic_operation"></block>
        <block type="logic_boolean"></block>
      </category>
      <category name="${cats.loops}" colour="120">
        <block type="controls_repeat_ext"><value name="TIMES"><shadow type="math_number"><field name="NUM">10</field></shadow></value></block>
        <block type="controls_whileUntil"></block>
      </category>
      <category name="${cats.math}" colour="230">
        <block type="math_number"></block>
        <block type="math_arithmetic"></block>
        <block type="math_random_int"></block>
      </category>
      <category name="${cats.text}" colour="160">
        <block type="text"></block>
        <block type="text_print"></block>
      </category>
      <category name="${cats.variables}" colour="330" custom="VARIABLE"></category>
    </xml>
    `;
  }, []);

  const registerBlocks = useCallback((robotCategories) => {
    if (!Blockly || !pythonGenerator) return;
    
    if (!Blockly.Extensions.isRegistered('custom_code_button')) {
      Blockly.Extensions.register('custom_code_button', function() {
        const block = this;
        let input = block.getInput('DUMMY') || block.getInput('BTN_DUMMY');
        if (!input) input = block.appendDummyInput('BTN_DUMMY');
        
        if (!block.data) {
           if (block.type === 'raw_code') block.data = "# Click edit icon";
           else if (block.type.includes('def')) block.data = "pass";
        }

        if (!block.getField('EDIT_BTN')) {
           const editBtn = new Blockly.FieldImage(
            "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxZDRmOTEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgMjBoOSIvPjxwYXRoIGQ9Ik0xNi41IDMuNWEyLjEyIDIuMTIgMCAwIDEgMyAzTDIyIDdsLTMgM0w3IDE3bC00IDF2LTRMMTYuNSAzLjV6Ii8+PC9zdmc+",
            16, 16, "Edit", 
            () => {
              const currentCode = block.data || block.getFieldValue('CODE') || '';
              if (window.OPEN_BLOCK_CODE_EDITOR) window.OPEN_BLOCK_CODE_EDITOR(block.id, currentCode);
            }
          );
          input.appendField(editBtn, 'EDIT_BTN');
        }
      });
    }

    const systemCategories = lang === 'zh' ? SYSTEM_CONFIG_ZH : SYSTEM_CONFIG_EN;
    const allBlocks = [...systemCategories, ...robotCategories].flatMap(cat => cat.blocks);
    const commandBlocks = ROBOT_IDE_COMMAND_BLOCKS.map(({ codeTemplate, ...rest }) => ({ ...rest }));
    const definitions = [...allBlocks, ...commandBlocks].map(({ codeTemplate, extensions, ...rest }) => ({ ...rest, extensions: extensions || undefined }));
    Blockly.common.defineBlocksWithJsonArray(definitions);
    
    [...allBlocks, ...commandBlocks].forEach(blockDef => {
      pythonGenerator.forBlock[blockDef.type] = function(block, generator) {
        let code = blockDef.codeTemplate;
        
        if (blockDef.type.includes('python_def')) {
           const name = block.getFieldValue('NAME');
           const args = block.getFieldValue('ARGS');
           const body = block.data || 'pass';
           const indentedBody = generator.prefixLines(body, generator.INDENT);
           return `def ${name}(${args}):\n${indentedBody}\n`;
        }
        
        if (blockDef.type === 'raw_code') {
           const body = block.data || '# No code';
           return body + '\n';
        }

        if (blockDef.args0) {
          blockDef.args0.forEach(arg => {
            const name = arg.name;
            if (!name) return; 
            let value = "";
            if (arg.type === "input_value") value = generator.valueToCode(block, name, pythonGenerator.ORDER_ATOMIC) || '0';
            else if (arg.type.startsWith("field_")) value = block.getFieldValue(name);

            if (arg.type === 'field_number' && name) {
              const safeValue = clampSafeValue(name, value);
              value = String(safeValue);
            }

            code = code.split(`{{${name}}}`).join(value);
          });
        }

        code = sanitizeRobotCode(code);
        
        if (blockDef.output !== undefined) return [code, pythonGenerator.ORDER_ATOMIC];
        return code;
      };
    });
  }, [lang]);

  useEffect(() => {
    if (!isBlocklyLoaded || mainTab !== 'blocks' || !blocklyDiv.current) return;
    
    Blockly.dialog.setPrompt(function(message, defaultValue, callback) {
      setPromptState({ isOpen: true, message, defaultValue, inputValue: defaultValue, callback });
      setTimeout(() => promptInputRef.current?.focus(), 100);
    });

    const initTimer = setTimeout(() => {
        registerBlocks(robotConfig);
        if (workspaceRef.current) workspaceRef.current.dispose();
        
        workspaceRef.current = Blockly.inject(blocklyDiv.current, {
          toolbox: generateToolboxXML(robotConfig, lang),
          scrollbars: false,
          move: {
            scrollbars: false,
            drag: true,
            wheel: true
          },
          grid: { spacing: 20, length: 3, colour: '#ccc', snap: true },
          zoom: { controls: true, wheel: true, startScale: 1.0, maxScale: 3, minScale: 0.3, scaleSpeed: 1.2 },
          trashcan: true,
        });

        if (resizeObserverRef.current) resizeObserverRef.current.disconnect();
        resizeObserverRef.current = new ResizeObserver(() => {
          Blockly.svgResize(workspaceRef.current);
        });
        resizeObserverRef.current.observe(blocklyDiv.current);

        const forceResize = () => {
          if(workspaceRef.current) Blockly.svgResize(workspaceRef.current);
        };

        const handleBlocklyEvents = (event) => {
          if ([Blockly.Events.BLOCK_CHANGE, Blockly.Events.BLOCK_MOVE, Blockly.Events.BLOCK_DELETE, Blockly.Events.VAR_CREATE, Blockly.Events.VAR_DELETE, Blockly.Events.VAR_RENAME].includes(event.type)) {
            try { applyGeneratedCode(pythonGenerator.workspaceToCode(workspaceRef.current), { syncBlocks: false }); } catch(e) {}
          }
          if (event.type === Blockly.Events.UI || event.element === 'category') {
             setTimeout(forceResize, 50);
             setTimeout(forceResize, 200);
             setTimeout(forceResize, 400);
          }
        };
        workspaceRef.current.addChangeListener(handleBlocklyEvents);

        const onDivClick = () => {
           setTimeout(forceResize, 50);
           setTimeout(forceResize, 350);
        };
        blocklyDiv.current.addEventListener('click', onDivClick);
        blocklyDiv.current.addEventListener('touchstart', onDivClick);

        const updateCode = () => {
          try {
            const code = pythonGenerator.workspaceToCode(workspaceRef.current);
            applyGeneratedCode(code, { syncBlocks: false });
          } catch(e) {}
        };
        workspaceRef.current.addChangeListener(updateCode);
        setTimeout(() => {
          if (workspaceRef.current && generatedCodeRef.current.trim()) {
            syncBlocksFromGeneratedCode(generatedCodeRef.current);
          }
        }, 150);
    }, 100);
    
    return () => {
      if (resizeObserverRef.current) resizeObserverRef.current.disconnect();
    };
  }, [isBlocklyLoaded, mainTab, registerBlocks, generateToolboxXML, robotConfig, lang]);

  const handleApplyConfig = () => { try { setRobotConfig(JSON.parse(configText)); setShowConfigEditor(false); } catch (e) { alert("JSON Error: " + e.message); } };
  const handleImportConfig = (e) => { const r = new FileReader(); r.onload = (ev) => setConfigText(ev.target.result); if(e.target.files[0]) r.readAsText(e.target.files[0]); };
  const handleExportConfig = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([configText], {type: "application/json"})); a.download = "robot_config.json"; a.click(); };
  const saveProject = () => { if(workspaceRef.current) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(window.Blockly.serialization.workspaces.save(workspaceRef.current))], {type: "application/json"})); a.download = "project.json"; a.click(); }};
  
  const loadProject = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result);
        window.Blockly.serialization.workspaces.load(json, workspaceRef.current);
      } catch (err) {
        alert("项目加载失败，文件格式可能错误: " + err.message);
      }
    };
    reader.readAsText(file);
    event.target.value = ''; 
  };

  const downloadPython = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([generatedCode], {type: "text/x-python;charset=utf-8"})); a.download = "task.py"; a.click(); };
  const handleUndo = () => workspaceRef.current?.undo(false);
  const handleRedo = () => workspaceRef.current?.undo(true);
  
  const handleClear = () => {
    if (window.confirm(t.confirmClear)) {
      workspaceRef.current?.clear();
      setSceneObjects([]);
      setPlannerWaypoints([]);
      applyGeneratedCode('', { syncBlocks: false });
      setIsPreviewPlaying(false);
      if (session?.user?.username) {
        localStorage.removeItem(`edu-scene-objects:${session.user.username}`);
      }
    }
  };

  const loadProjectFromLibrary = (project) => {
    if (!project) return;
    setProjectName(project.name || 'default');
    setSceneObjects(Array.isArray(project.sceneObjects) ? project.sceneObjects : []);
    setPlannerWaypoints(Array.isArray(project.plannerWaypoints) ? project.plannerWaypoints : []);
    const nextCode = typeof project.generatedCode === 'string' ? project.generatedCode : '';
    applyGeneratedCode(nextCode, { syncBlocks: true });
    setMainTab('blocks');
  };

  const addPlannerWaypoint = () => {
    setPlannerWaypoints((prev) => {
      const lastPoint = prev[prev.length - 1] || { x: 0, y: 0 };
      const nextPoint = clampScenePoint(lastPoint.x + 4, lastPoint.y + 2, gridSize);
      return [
        ...prev,
        {
          id: `planner-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          x: nextPoint.x,
          y: nextPoint.y,
        },
      ];
    });
  };

  const updatePlannerWaypoint = (id, patch) => {
    setPlannerWaypoints((prev) => prev.map((point) => {
      if (point.id !== id) return point;
      const nextPosition = clampScenePoint(
        patch.x !== undefined ? patch.x : point.x,
        patch.y !== undefined ? patch.y : point.y,
        gridSize,
      );
      return { ...point, ...patch, x: nextPosition.x, y: nextPosition.y };
    }));
  };

  const removePlannerWaypoint = (id) => {
    setPlannerWaypoints((prev) => prev.filter((point) => point.id !== id));
  };

  const compilePlannerPath = () => {
    if (plannerWaypoints.length < 2) {
      alert('Add at least two waypoints before compiling a motion path.');
      return;
    }
    if (generatedCode.trim() && !window.confirm('Compiling this path will replace the current Blocks and IDE code. Continue?')) return;

    const commands = buildPlannerMotionCommands(plannerWaypoints);
    updateGeneratedCode(commands.join('\n'));
    setMainTab('ide');
  };

  const handleRunCode = async () => {
    if (isRunning) {
      try { await fetch('/api/stop', { method: 'POST' }); setIsRunning(false); } catch (e) { alert("Stop Failed: " + e.message); }
    } else {
      try {
        setIsRunning(true);
        const res = await fetch('/api/run', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ code: generatedCode }) });
        if (!res.ok) throw new Error("Server Error");
      } catch (e) { setIsRunning(false); alert("Run Failed: " + e.message); }
    }
  };

  const activeObstacles = useMemo(() => sceneObjects, [sceneObjects]);

  const previewPreviewState = useCallback(() => {
    const state = simulateG1Edu23Program(generatedCode, {
      mode: simulatorMode,
      obstacles: activeObstacles,
    });
    setSimulatorState(state);
  }, [generatedCode, simulatorMode, activeObstacles]);

  const startSimulationPreview = () => {
    if (!generatedCode.trim()) {
      alert('Add some robot commands before starting the simulation preview.');
      return;
    }
    setPlaybackProgress((progress) => progress >= 1 ? 0 : progress);
    setIsPreviewPlaying(true);
    previewPreviewState();
  };

  const pauseSimulationPreview = () => {
    setIsPreviewPlaying(false);
  };

  const resetSimulationPreview = () => {
    setIsPreviewPlaying(false);
    setPlaybackProgress(0);
  };

  const handleRunSimulation = () => {
    if (!generatedCode.trim()) {
      alert('Add code or blocks before running the simulation.');
      return;
    }
    setPlaybackProgress(0);
    setIsPreviewPlaying(true);
  };

  const handlePlaybackSpeedChange = (value) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;
    setPlaybackSpeed(Math.min(3, Math.max(0.1, Math.round(numericValue * 10) / 10)));
  };

  const syncBlocksFromGeneratedCode = useCallback((code) => {
    if (!workspaceRef.current || !window.Blockly) return;
    const workspace = workspaceRef.current;
    workspace.clear();

    const lines = (code || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return;

    let previousBlock = null;

    lines.forEach((line) => {
      const match = line.match(/^robot\.(\w+)\((.*)\);?$/);
      const blockTypeMap = {
        stand: 'robot_stand',
        walk: 'robot_walk_forward',
        walkForward: 'robot_walk_forward',
        walkForwardSteps: 'robot_walk_forward_steps',
        backward: 'robot_walk_back',
        walkBackward: 'robot_walk_back',
        walkBackwardSteps: 'robot_walk_back_steps',
        sidestep: 'robot_walk_sideways_left',
        walkSidewaysLeft: 'robot_walk_sideways_left',
        walkSidewaysLeftSteps: 'robot_walk_sideways_left_steps',
        walkSidewaysRight: 'robot_walk_sideways_right',
        walkSidewaysRightSteps: 'robot_walk_sideways_right_steps',
        turn: 'robot_turn_left',
        turnLeft: 'robot_turn_left',
        turnRight: 'robot_turn_right',
        wait: 'robot_wait',
        waitSeconds: 'robot_wait_seconds',
        repeatLoop: 'robot_repeat_loop',
        stop: 'robot_stop',
        sit: 'robot_sit',
        waveLeft: 'robot_wave_left',
        waveRight: 'robot_wave_right',
        raiseBothArms: 'robot_raise_both_arms',
        lowerBothArms: 'robot_lower_both_arms',
        raiseLeftArm: 'robot_raise_left_arm',
        raiseRightArm: 'robot_raise_right_arm',
        raiseLeftLeg: 'robot_left_leg_kick',
        raiseRightLeg: 'robot_right_leg_kick',
        raiseLeftKnee: 'robot_raise_left_knee',
        raiseRightKnee: 'robot_raise_right_knee',
        kick: 'robot_kick',
      };

      let blockType = 'raw_code';
      let data = line;
      let blockValues = {};

      if (match) {
        const methodName = match[1];
        const argsRaw = match[2] || '';
        blockType = blockTypeMap[methodName] || 'raw_code';

        if (['walk', 'walkForward', 'walkBackward', 'walkSidewaysLeft', 'walkSidewaysRight', 'backward', 'sidestep'].includes(methodName)) {
          const numberMatch = argsRaw.match(/-?\d*\.?\d+/);
          const safeSpeed = clampSafeValue('SPEED', numberMatch ? numberMatch[0] : 1);
          blockValues = { SPEED: safeSpeed };
        }
        if (['walkForwardSteps', 'walkBackwardSteps', 'walkSidewaysLeftSteps', 'walkSidewaysRightSteps', 'repeatLoop'].includes(methodName)) {
          const numberMatch = argsRaw.match(/-?\d*\.?\d+/);
          const safeSteps = clampSafeValue('STEPS', numberMatch ? numberMatch[0] : 3);
          blockValues = { STEPS: safeSteps, TIMES: safeSteps };
        }
        if (['turn', 'turnLeft', 'turnRight'].includes(methodName)) {
          if (methodName === 'turn') {
            const turnArgs = argsRaw.match(/"(.*?)"\s*,\s*(\d+(?:\.\d+)?)/) || argsRaw.match(/'(.*?)'\s*,\s*(\d+(?:\.\d+)?)/);
            if (turnArgs) {
              const direction = (turnArgs[1] || 'left').toLowerCase();
              const safeAngle = clampSafeValue('ANGLE', turnArgs[2]);
              blockValues = { ANGLE: safeAngle, DIR: direction === 'right' ? 'right' : 'left' };
              if (direction === 'right') {
                blockType = 'robot_turn_right';
              } else {
                blockType = 'robot_turn_left';
              }
            }
          } else {
            const numberMatch = argsRaw.match(/-?\d*\.?\d+/);
            blockValues = { ANGLE: clampSafeValue('ANGLE', numberMatch ? numberMatch[0] : 90) };
          }
        }
        if (['raiseLeftArm', 'raiseRightArm', 'raiseLeftLeg', 'raiseRightLeg'].includes(methodName)) {
          const quoted = argsRaw.match(/"(.*?)"/) || argsRaw.match(/'(.*?)'/);
          const degreeMatch = argsRaw.match(/-?\d*\.?\d+/);
          blockValues = {
            POSITION: quoted ? quoted[1].toLowerCase() : 'mid',
            DEGREES: clampSafeValue('DEGREES', degreeMatch ? degreeMatch[0] : 90),
          };
        }
        if (['wait', 'waitSeconds'].includes(methodName)) {
          const numberMatch = argsRaw.match(/-?\d*\.?\d+/);
          blockValues = { SECONDS: clampSafeValue('SECONDS', numberMatch ? numberMatch[0] : 0.5) };
        }
        if (methodName === 'kick') {
          const kickArgs = argsRaw.match(/"(.*?)"/) || argsRaw.match(/'(.*?)'/);
          if (kickArgs) {
            blockValues = { LEVEL: kickArgs[1].toLowerCase() };
          }
        }

        if (blockType !== 'raw_code') {
          data = null;
        }
      }

      const block = workspace.newBlock(blockType);
      if (data) {
        block.data = data;
      }
      Object.entries(blockValues).forEach(([key, value]) => {
        if (typeof value === 'string' || typeof value === 'number') {
          block.setFieldValue(String(value), key);
        }
      });

      if (previousBlock) {
        previousBlock.nextConnection.connect(block.previousConnection);
      }
      block.initSvg();
      block.render();
      previousBlock = block;
    });

    if (workspace.getAllBlocks().length) {
      workspace.zoomToFit(0.8);
    }
  }, []);

  const derivePlannerWaypointsFromCode = useCallback((code = '') => {
    if (!code || !code.trim()) return [];

    const commandMatches = [...code.matchAll(/robot\.(walkForward|walkBackward|walkSidewaysLeft|walkSidewaysRight|turnLeft|turnRight|turn)\(([^)]*)\)/g)];
    if (!commandMatches.length) return [];

    let x = 0;
    let y = 0;
    let heading = 0;
    const points = [{ id: 'planner-0', x, y }];

    commandMatches.forEach((match) => {
      const [, methodName, argsRaw = ''] = match;
      const numeric = Number((argsRaw.match(/-?\d*\.?\d+/) || ['0'])[0]);
      const amount = Number.isFinite(numeric) ? numeric : 0;

      if (methodName === 'walkForward' || methodName === 'walkBackward') {
        const stepDistance = methodName === 'walkBackward' ? -amount : amount;
        x += Math.cos((heading * Math.PI) / 180) * stepDistance;
        y += Math.sin((heading * Math.PI) / 180) * stepDistance;
      }

      if (methodName === 'walkSidewaysLeft' || methodName === 'walkSidewaysRight') {
        const direction = methodName === 'walkSidewaysLeft' ? 1 : -1;
        const sidewaysHeading = heading + (direction > 0 ? 90 : -90);
        x += Math.cos((sidewaysHeading * Math.PI) / 180) * amount;
        y += Math.sin((sidewaysHeading * Math.PI) / 180) * amount;
      }

      if (methodName === 'turnLeft' || methodName === 'turnRight') {
        heading += methodName === 'turnLeft' ? amount : -amount;
      }

      if (methodName === 'turn') {
        const turnArgs = argsRaw.match(/"([^"]+)"\s*,\s*(\d+(?:\.\d+)?)/) || argsRaw.match(/'([^']+)'\s*,\s*(\d+(?:\.\d+)?)/);
        if (turnArgs) {
          const direction = (turnArgs[1] || 'left').toLowerCase();
          const turnAmount = Number(turnArgs[2] || 0);
          heading += direction === 'right' ? -turnAmount : turnAmount;
        }
      }

      points.push({ id: `planner-${points.length}`, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
    });

    if (points.length < 2) {
      return [{ id: 'planner-1', x: 0, y: 0 }];
    }

    return points;
  }, []);

  useEffect(() => {
    const isCompiledPlannerPath = compiledPlannerCodeRef.current === generatedCode;
    compiledPlannerCodeRef.current = null;
    if (!isCompiledPlannerPath) {
      const nextWaypoints = derivePlannerWaypointsFromCode(generatedCode);
      setPlannerWaypoints((previousWaypoints) => {
        const previousSnapshot = JSON.stringify(previousWaypoints);
        const nextSnapshot = JSON.stringify(nextWaypoints);
        return previousSnapshot === nextSnapshot ? previousWaypoints : nextWaypoints;
      });
    }
    setPlaybackProgress(0);
    setIsPreviewPlaying(false);
  }, [generatedCode, derivePlannerWaypointsFromCode]);

  const applyGeneratedCode = useCallback((nextCode, options = {}) => {
    const { syncBlocks = true } = options;
    const result = sanitizeRobotCode(nextCode);
    const safeCode = result.code || nextCode;
    generatedCodeRef.current = safeCode;
    setGeneratedCode(safeCode);
    setSafetyNotice(result.changed ? 'One or more values were adjusted to the safe range.' : '');
    if (syncBlocks && workspaceRef.current && window.Blockly) {
      syncBlocksFromGeneratedCode(safeCode);
    }
  }, [syncBlocksFromGeneratedCode]);

  const updateGeneratedCode = useCallback((nextCode) => {
    applyGeneratedCode(nextCode, { syncBlocks: true });
  }, [applyGeneratedCode]);

  const applyMotionPromptResult = (promptText, source) => {
    const result = compileMotionPrompt(promptText);
    setMotionPromptResult({ ...result, source });
    if (result.code) updateGeneratedCode(result.code);
  };

  const generateMotionFromPrompt = async (useHuggingFace = false) => {
    if (generatedCode.trim() && !window.confirm('Generating this motion will replace the current Blocks and IDE code. Continue?')) return;
    setMotionPromptStatus(useHuggingFace ? 'loading' : 'local');
    if (!useHuggingFace) {
      applyMotionPromptResult(motionPrompt, 'Local safe compiler');
      return;
    }

    try {
      const response = await apiFetch('/api/hf/text-to-motion', {
        method: 'POST',
        body: JSON.stringify({ prompt: motionPrompt }),
      });
      setMotionPrompt(response.text);
      applyMotionPromptResult(response.text, `Hugging Face: ${response.model}`);
      setMotionPromptStatus('hf');
    } catch (error) {
      applyMotionPromptResult(motionPrompt, 'Local fallback');
      setMotionPromptStatus('fallback');
    }
  };

  const insertRobotCommand = (snippet) => {
    const nextCode = generatedCode ? `${generatedCode.trimEnd()}\n${snippet}\n` : `${snippet}\n`;
    updateGeneratedCode(nextCode);
  };

  const handleRecordMotionCapture = () => {
    const sampleScript = [
      'robot.stand();',
      'robot.wait(0.5);',
      'robot.walkForward(3);',
      'robot.wait(0.5);',
      'robot.turnLeft(90);',
      'robot.walkForward(2);',
      'robot.stand();',
      'console.log("Program complete!");',
    ].join('\n');

    if (generatedCode && generatedCode.trim()) {
      const confirmed = window.confirm('Recording motion capture will overwrite the current blocks and IDE code. Continue?');
      if (!confirmed) return;
    }

    updateGeneratedCode(sampleScript);
    setMainTab('blocks');
  };

  useEffect(() => {
    setSimulatorState(simulateG1Edu23Program(generatedCode, { mode: simulatorMode, obstacles: activeObstacles }));
  }, [generatedCode, simulatorMode, activeObstacles]);

  const applyMotionTemplate = (template) => {
    updateGeneratedCode(template.code);
  };

  const addStudentObstacle = (type = 'box') => {
    const preset = OBJECT_LIBRARY.find((item) => item.id === type) || OBJECT_LIBRARY[0];
    const defaultPosition = clampScenePoint(0, 0, gridSize);
    setSceneObjects((prev) => [
      ...prev,
      {
        id: `student-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: preset.id,
        label: preset.label,
        color: preset.color,
        x: defaultPosition.x,
        y: defaultPosition.y,
        radius: preset.defaultRadius,
      },
    ]);
  };

  const updateStudentObstacle = (id, patch) => {
    setSceneObjects((prev) => prev.map((obstacle) => {
      if (obstacle.id !== id) return obstacle;
      const nextPosition = clampScenePoint(
        patch.x !== undefined ? patch.x : obstacle.x,
        patch.y !== undefined ? patch.y : obstacle.y,
        gridSize,
      );
      return { ...obstacle, ...patch, x: nextPosition.x, y: nextPosition.y };
    }));
  };

  const removeStudentObstacle = (id) => {
    setSceneObjects((prev) => prev.filter((obstacle) => obstacle.id !== id));
  };

  const obstacleDragRef = useRef(null);
  const plannerDragRef = useRef(null);
  const sceneOrigin = 110;
  const sceneScale = 220 / gridSize;
  const sceneX = (meters) => sceneOrigin + meters * sceneScale;
  const sceneY = (meters) => sceneOrigin - meters * sceneScale;

  const getSvgCoords = (event) => {
    const svg = event.currentTarget.ownerSVGElement || event.currentTarget;
    const screenPoint = svg.createSVGPoint();
    screenPoint.x = event.clientX;
    screenPoint.y = event.clientY;
    const svgPoint = screenPoint.matrixTransform(svg.getScreenCTM().inverse());
    const localX = (svgPoint.x - sceneOrigin) / sceneScale;
    const localY = (sceneOrigin - svgPoint.y) / sceneScale;
    return {
      x: Math.max(-gridSize / 2, Math.min(gridSize / 2, localX)),
      y: Math.max(-gridSize / 2, Math.min(gridSize / 2, localY)),
    };
  };

  const handleObstaclePointerDown = (event, obstacleId) => {
    if (currentUser.role === 'teacher') return;
    obstacleDragRef.current = { obstacleId, pointerId: event.pointerId };
    setActiveDragItem({ kind: 'obstacle', id: obstacleId });
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePlannerWaypointPointerDown = (event, waypointId) => {
    plannerDragRef.current = { waypointId, pointerId: event.pointerId };
    setActiveDragItem({ kind: 'waypoint', id: waypointId });
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleObstaclePointerMove = (event) => {
    if (!obstacleDragRef.current || currentUser.role === 'teacher') return;
    const { x, y } = clampScenePoint(...Object.values(getSvgCoords(event)), gridSize);
    updateStudentObstacle(obstacleDragRef.current.obstacleId, { x, y });
  };

  const handlePlannerWaypointPointerMove = (event) => {
    if (!plannerDragRef.current) return;
    const { x, y } = clampScenePoint(...Object.values(getSvgCoords(event)), gridSize);
    updatePlannerWaypoint(plannerDragRef.current.waypointId, { x, y });
  };

  const handleScenePointerMove = (event) => {
    if (plannerDragRef.current) {
      handlePlannerWaypointPointerMove(event);
      return;
    }
    if (obstacleDragRef.current) {
      handleObstaclePointerMove(event);
    }
  };

  const handleObstaclePointerUp = () => {
    obstacleDragRef.current = null;
    plannerDragRef.current = null;
    setActiveDragItem(null);
  };

  const handleScenePointerUp = () => {
    handleObstaclePointerUp();
  };

  const handlePromptSubmit = () => { promptState.callback?.(promptState.inputValue); setPromptState({ ...promptState, isOpen: false }); };
  const handlePromptCancel = () => { promptState.callback?.(null); setPromptState({ ...promptState, isOpen: false }); };
  
  const handleSaveCode = () => {
    if (workspaceRef.current && codeEditorState.blockId) {
      const block = workspaceRef.current.getBlockById(codeEditorState.blockId);
      if (block) {
        block.data = codeEditorState.code;
        if (workspaceRef.current) {
          const event = new window.Blockly.Events.BlockChange(block, 'comment', null, '', '');
          workspaceRef.current.fireChangeListener(event);
        }
      }
    }

    if (workspaceRef.current && window.Blockly) {
      try {
        const nextCode = pythonGenerator.workspaceToCode(workspaceRef.current);
        applyGeneratedCode(nextCode, { syncBlocks: true });
      } catch (error) {
        console.warn('Failed to refresh generated code after block edit.', error);
      }
    }

    setCodeEditorState({ ...codeEditorState, isOpen: false });
  };

  const handleOpenProjectClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
    setActiveMenu(null);
  };

  const beginToolPanelInteraction = (event, mode) => {
    if (toolPanelCollapsed) return;
    event.preventDefault();
    event.stopPropagation();
    toolPanelInteractionRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      rect: { ...toolPanelRect },
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const updateToolPanelInteraction = (event) => {
    const interaction = toolPanelInteractionRef.current;
    if (!interaction) return;

    const deltaX = event.clientX - interaction.startX;
    const deltaY = event.clientY - interaction.startY;
    const nextRect = { ...interaction.rect };
    const minimumWidth = 320;
    const minimumHeight = 360;
    const maximumWidth = Math.max(minimumWidth, window.innerWidth - 32);
    const maximumHeight = Math.max(minimumHeight, window.innerHeight - 110);

    if (interaction.mode === 'move') {
      nextRect.right = Math.max(8, interaction.rect.right - deltaX);
      nextRect.top = Math.max(8, interaction.rect.top + deltaY);
    } else {
      if (interaction.mode.includes('left')) {
        nextRect.width = Math.min(maximumWidth, Math.max(minimumWidth, interaction.rect.width - deltaX));
        nextRect.right = Math.max(8, interaction.rect.right + deltaX);
      }
      if (interaction.mode.includes('right')) {
        nextRect.width = Math.min(maximumWidth, Math.max(minimumWidth, interaction.rect.width + deltaX));
      }
      if (interaction.mode.includes('top')) {
        nextRect.height = Math.min(maximumHeight, Math.max(minimumHeight, interaction.rect.height - deltaY));
        nextRect.top = Math.max(8, interaction.rect.top + deltaY);
      }
      if (interaction.mode.includes('bottom')) {
        nextRect.height = Math.min(maximumHeight, Math.max(minimumHeight, interaction.rect.height + deltaY));
      }
    }

    setToolPanelRect(nextRect);
  };

  const endToolPanelInteraction = () => {
    toolPanelInteractionRef.current = null;
  };

  if (!session) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white shadow-2xl rounded-2xl border border-slate-200 overflow-hidden">
          <div className="bg-blue-600 px-6 py-5 text-white">
            <h1 className="text-2xl font-bold">Uni EDU Classroom</h1>
            <p className="text-sm text-blue-100 mt-1">One robot, one queue, easy for every class.</p>
          </div>

          <div className="px-6 pt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setAuthMode('login')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${authMode === 'login' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}
            >
              Log In
            </button>
            <button
              type="button"
              onClick={() => setAuthMode('signup')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${authMode === 'signup' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}
            >
              Create Account
            </button>
          </div>

          {authMode === 'login' ? (
            <form onSubmit={handleLogin} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                <input
                  type="text"
                  value={loginForm.username}
                  onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Role</label>
                <select
                  value={loginForm.role}
                  onChange={(e) => setLoginForm({ ...loginForm, role: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="teacher">Teacher</option>
                  <option value="student">Student</option>
                </select>
              </div>
              {loginError && <p className="text-red-600 text-sm">{loginError}</p>}
              <button type="submit" className="w-full bg-blue-600 text-white rounded-xl py-2.5 font-semibold hover:bg-blue-700 transition-colors">Log In</button>
              <div className="text-xs text-slate-500 space-y-1">
                <p>Teacher demo: teacher / teacher</p>
                <p>Student demo: student1 / student1</p>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSignup} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">New username</label>
                <input
                  type="text"
                  value={signupForm.username}
                  onChange={(e) => setSignupForm({ ...signupForm, username: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="student24"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
                <input
                  type="password"
                  value={signupForm.password}
                  onChange={(e) => setSignupForm({ ...signupForm, password: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="At least 4 characters"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Role</label>
                <select
                  value={signupForm.role}
                  onChange={(e) => setSignupForm({ ...signupForm, role: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="student">Student</option>
                  <option value="teacher">Teacher</option>
                </select>
              </div>
              {loginError && <p className="text-red-600 text-sm">{loginError}</p>}
              <button type="submit" className="w-full bg-emerald-600 text-white rounded-xl py-2.5 font-semibold hover:bg-emerald-700 transition-colors">Create Classroom Account</button>
            </form>
          )}
        </div>
      </div>
    );
  }

  if (!isBlocklyLoaded) return <div className="flex h-screen items-center justify-center bg-gray-50 flex-col gap-4"><Loader2 className="animate-spin text-blue-600" size={48} /><p className="text-gray-500 font-medium">{UI_TEXT.en.loading}</p></div>;

  return (
    <div className="flex flex-col h-screen bg-gray-50 text-gray-800 font-sans relative overflow-hidden">
      
      <style>{`
        .blocklyToolboxDiv {
          background-color: #f9fafb !important;
          border-right: 1px solid #e5e7eb;
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
        .blocklyToolbox {
          background-color: #f8fafc !important;
          color: #334155 !important;
        }
        .blocklyToolboxCategoryLabel,
        .blocklyToolboxCategoryLabelText {
          color: #334155 !important;
          font-weight: 600;
        }
        .blocklyToolboxCategory:hover,
        .blocklyToolboxCategory[aria-selected="true"] {
          background-color: #e2e8f0 !important;
        }
        .blocklyFlyout {
          background-color: #f8fafc !important;
        }
        .blocklyFlyoutLabelText {
          fill: #334155 !important;
        }
        .blocklyToolboxDiv::-webkit-scrollbar {
          display: none;
        }
        .blocklySvg {
          overflow: hidden !important; 
        }
        /* 强制隐藏所有滚动条相关 UI */
        .blocklyScrollbarBackground, 
        .blocklyScrollbarHandle, 
        .blocklyFlyoutScrollbar {
          display: none !important;
          opacity: 0 !important;
          visibility: hidden !important;
          pointer-events: none;
        }
      `}</style>

      {/* Hidden File Input for Open Project */}
      <input 
        type="file" 
        ref={fileInputRef} 
        className="hidden" 
        accept=".json" 
        onChange={loadProject} 
      />

      {showConfigEditor && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in p-4" onClick={(e) => e.stopPropagation()}>
          <div className="bg-white w-full max-w-5xl h-[90vh] rounded-xl shadow-2xl flex flex-col overflow-hidden">
            <div className="flex justify-between items-center p-5 border-b bg-gray-50">
              <div><h2 className="text-xl font-bold flex items-center gap-2 text-gray-800"><FileJson className="text-blue-600" /> {t.configTitle}</h2><p className="text-xs text-gray-500 mt-1">{t.configDesc}</p></div>
              <div className="flex gap-2">
                <label className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border rounded hover:bg-gray-50 cursor-pointer"><Upload size={14} /> {t.actConfigImport}<input type="file" className="hidden" accept=".json" onChange={handleImportConfig} /></label>
                <button onClick={handleExportConfig} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border rounded hover:bg-gray-50"><Download size={14} /> {t.actConfigExport}</button>
                <div className="w-px h-6 bg-gray-300 mx-2"></div>
                <button onClick={resetRobotConfig} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-100 rounded hover:bg-red-100"><RefreshCw size={14} /> {t.resetBtn}</button>
              </div>
            </div>
            <div className="flex-1 bg-slate-900 p-0 overflow-hidden"><textarea className="w-full h-full p-6 font-mono text-sm bg-slate-900 text-green-400 resize-none focus:outline-none" value={configText || ''} onChange={(e) => setConfigText(e.target.value)} spellCheck={false} /></div>
            <div className="p-4 border-t bg-white flex justify-end gap-3"><button onClick={() => setShowConfigEditor(false)} className="px-5 py-2 text-sm text-gray-600 font-medium hover:bg-gray-100 rounded-lg">{t.closeBtn}</button><button onClick={handleApplyConfig} className="flex items-center gap-2 px-6 py-2 text-sm bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 shadow-md"><Check size={16} /> {t.applyBtn}</button></div>
          </div>
        </div>
      )}

      {promptState.isOpen && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={(e) => e.stopPropagation()}>
          <div className="bg-white w-96 rounded-xl shadow-2xl p-6 border border-gray-100">
            <h3 className="text-lg font-bold text-gray-800 mb-4">{promptState.message}</h3>
            <input ref={promptInputRef} type="text" className="w-full border rounded-lg px-4 py-2.5 mb-6 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50" value={promptState.inputValue || ''} onChange={(e) => setPromptState({...promptState, inputValue: e.target.value})} onKeyDown={(e) => e.key === 'Enter' && handlePromptSubmit()} />
            <div className="flex justify-end gap-3"><button onClick={handlePromptCancel} className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg">{t.cancelBtn}</button><button onClick={handlePromptSubmit} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm">{t.confirmBtn}</button></div>
          </div>
        </div>
      )}
      
      {codeEditorState.isOpen && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in" onClick={(e) => e.stopPropagation()}>
          <div className="bg-white w-full max-w-4xl h-[80vh] rounded-xl shadow-2xl flex flex-col overflow-hidden">
            <div className="flex justify-between items-center p-4 border-b bg-gray-50">
              <h2 className="text-lg font-bold flex items-center gap-2"><Edit3 size={18} className="text-blue-600"/> {t.editorTitle}</h2>
              <button onClick={() => setCodeEditorState({...codeEditorState, isOpen: false})} className="p-1 hover:bg-gray-200 rounded-full"><X size={20} className="text-gray-500"/></button>
            </div>
            <div className="flex-1 relative">
              <textarea ref={codeEditorRef} className="w-full h-full p-6 font-mono text-sm bg-[#1e1e1e] text-[#d4d4d4] resize-none focus:outline-none leading-relaxed" value={codeEditorState.code || ''} onChange={(e) => setCodeEditorState({...codeEditorState, code: e.target.value})} spellCheck={false} autoFocus />
            </div>
            <div className="p-4 border-t bg-white flex justify-end gap-3">
               <button onClick={() => setCodeEditorState({...codeEditorState, isOpen: false})} className="px-5 py-2 text-sm text-gray-600 font-medium hover:bg-gray-100 rounded-lg">{t.cancelBtn}</button>
               <button onClick={handleSaveCode} className="flex items-center gap-2 px-6 py-2 text-sm bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 shadow-md"><Check size={16} /> {t.editorSave}</button>
            </div>
          </div>
        </div>
      )}

      {showAbout && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowAbout(false)}>
          <div className="bg-white max-w-md w-full rounded-xl shadow-2xl p-8 text-center" onClick={e => e.stopPropagation()}>
            <div className="w-16 h-16 bg-blue-600 text-white rounded-2xl flex items-center justify-center text-3xl font-bold mx-auto mb-4 shadow-lg shadow-blue-200">U++</div>
            <h2 className="text-2xl font-bold text-gray-800">{t.appName}</h2><p className="text-sm text-blue-600 font-mono mt-1 mb-6">{t.version}</p><p className="text-gray-600 text-sm leading-relaxed mb-6">{t.aboutContent}</p>
            <button onClick={() => setShowAbout(false)} className="px-6 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition-colors">Close</button>
          </div>
        </div>
      )}

      <div className="h-9 bg-[#f8f9fa] border-b flex items-center px-2 select-none z-40 text-sm">
        <div className="flex items-center gap-2 mr-6 px-2"><div className="w-5 h-5 bg-blue-600 text-white rounded flex items-center justify-center font-bold text-xs">U</div><span className="font-semibold text-gray-700 tracking-tight">{t.appName}</span></div>
        <div className="flex items-center h-full">
          {[
            { id: 'file', label: t.menuFile, content: <><MenuItem label={t.actNew} icon={FileText} onClick={() => { handleClear(); setActiveMenu(null); }} /><MenuItem label={t.actOpen} icon={FolderOpen} onClick={handleOpenProjectClick} /><MenuItem label={t.actSave} icon={Save} onClick={() => { saveProject(); setActiveMenu(null); }} /><div className="h-px bg-gray-200 my-1"></div><MenuItem label={t.actExportPy} icon={Download} onClick={() => { downloadPython(); setActiveMenu(null); }} /></> },
            { id: 'edit', label: t.menuEdit, content: <><MenuItem label={t.actUndo} icon={Undo} shortcut="Ctrl+Z" onClick={() => { handleUndo(); setActiveMenu(null); }} /><MenuItem label={t.actRedo} icon={Redo} shortcut="Ctrl+Y" onClick={() => { handleRedo(); setActiveMenu(null); }} /></> },
            { id: 'view', label: t.menuView, content: <><MenuItem label="Open IDE" icon={Code} onClick={() => { setMainTab('ide'); setActiveMenu(null); }} /></> },
            { id: 'help', label: t.menuHelp, content: <><MenuItem label={t.actAbout} icon={Info} onClick={() => { setShowAbout(true); setActiveMenu(null); }} /></> }
          ].map(menu => (
            <div key={menu.id} className="relative h-full"><button className={`h-full px-3 hover:bg-gray-200 transition-colors ${activeMenu === menu.id ? 'bg-gray-200 text-blue-700' : 'text-gray-700'}`} onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === menu.id ? null : menu.id); }}>{menu.label}</button>{activeMenu === menu.id && (<div className="absolute top-full left-0 w-56 bg-white border shadow-xl rounded-b-lg rounded-r-lg py-1 z-50 animate-in fade-in zoom-in-95 duration-100" onClick={e => e.stopPropagation()}>{menu.content}</div>)}</div>
          ))}
        </div>
        <div className="flex-1"></div>
        <button onClick={toggleLanguage} className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-600 px-3 transition-colors"><Globe size={12} /> {lang === 'zh' ? 'English' : '中文'}</button>
      </div>

      {isSimulatorOpen && (
      <div className="fixed inset-0 z-50 bg-slate-950/20" onClick={() => setIsSimulatorOpen(false)}>
      <div className="absolute right-4 top-24 z-10 flex max-h-[calc(100vh-7rem)] w-[min(360px,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto overscroll-contain pr-1" onClick={(event) => event.stopPropagation()}>
        <div className="max-h-[420px] overflow-auto rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-200 p-3 bg-slate-50 flex items-center justify-between">
            <h3 className="font-semibold text-slate-800">{currentUser.role === 'teacher' ? 'Teacher Queue' : 'My Saved Code'}</h3>
            <div className="flex items-center gap-2">
              <span className="text-xs rounded-full bg-blue-100 text-blue-700 px-2 py-1">{classroomStatus}</span>
              <button type="button" onClick={() => setIsSimulatorOpen(false)} className="rounded-md p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800" aria-label="Close simulator">
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="p-3 space-y-3">
            {currentUser.role === 'teacher' && (
              <>
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
                  <p className="text-[10px] uppercase tracking-wide text-blue-700 font-semibold">G1 connection</p>
                  <div className="mt-2 flex gap-2">
                    <input
                      type="text"
                      value={robotAddress}
                      onChange={(e) => setRobotAddress(e.target.value)}
                      className="w-full border border-blue-200 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="192.168.123.164"
                    />
                    <button onClick={handleConnectRobot} className="rounded-lg bg-blue-600 text-white px-2.5 py-1.5 text-xs font-medium">Connect</button>
                  </div>
                  <p className={`mt-2 text-xs ${isRobotConnected ? 'text-green-700' : 'text-slate-600'}`}>{robotConnectionStatus}</p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[10px] uppercase tracking-wide text-slate-600 font-semibold">Class roster</p>
                  <div className="mt-2 space-y-2">
                    {teacherRoster.length === 0 ? (
                      <p className="text-xs text-slate-500">No students yet.</p>
                    ) : teacherRoster.map((user) => (
                      <div key={user.username} className="flex items-center justify-between rounded-lg bg-white border border-slate-200 px-2 py-1.5">
                        <span className="text-sm text-slate-700">{user.username}</span>
                        <span className="text-[10px] uppercase rounded-full bg-slate-100 text-slate-600 px-2 py-1">{user.role}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <button type="button" onClick={handleRunNext} className="rounded-lg bg-blue-600 px-2 py-2 text-[10px] font-semibold text-white hover:bg-blue-700">Run next</button>
                  <button type="button" onClick={handleStopCurrent} className="rounded-lg bg-amber-500 px-2 py-2 text-[10px] font-semibold text-slate-950 hover:bg-amber-400">Pause</button>
                  <button type="button" onClick={handleClearQueue} className="rounded-lg bg-red-500 px-2 py-2 text-[10px] font-semibold text-white hover:bg-red-600">Clear queue</button>
                </div>
              </>
            )}

            {currentUser.role === 'teacher' ? (
              <>
                {queueItems.length === 0 ? <p className="text-sm text-slate-500">No student jobs queued.</p> : queueItems.map((item) => (
                  <div key={item.id} className="rounded-lg border border-slate-200 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-slate-800 text-sm truncate">{item.name}</p>
                      <span className="text-[10px] uppercase bg-slate-100 text-slate-600 rounded-full px-2 py-1">{item.status}</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">by {item.student}</p>
                    <button onClick={() => handleDeleteQueueItem(item.id)} className="mt-2 text-xs text-red-600 hover:text-red-700">Delete</button>
                  </div>
                ))}

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[10px] uppercase tracking-wide text-slate-600 font-semibold">Student projects</p>
                  <div className="mt-2 space-y-2">
                    {projectLibrary.length === 0 ? (
                      <p className="text-xs text-slate-500">No student projects yet.</p>
                    ) : projectLibrary.map((project) => (
                      <div key={`${project.username}-${project.name}`} className="rounded-lg border border-slate-200 bg-white p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-slate-800">{project.name}</span>
                          <span className="text-[10px] uppercase rounded-full bg-slate-100 text-slate-600 px-2 py-1">{project.username}</span>
                        </div>
                        <button type="button" onClick={() => loadProjectFromLibrary(project)} className="mt-2 text-xs text-blue-600 hover:text-blue-700">Open project</button>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              savedCodes.length === 0 ? <p className="text-sm text-slate-500">No saved code yet.</p> : savedCodes.map((code) => (
                <div key={code.name} className="rounded-lg border border-slate-200 p-2">
                  <p className="font-medium text-slate-800 text-sm">{code.name}</p>
                  <p className="text-xs text-slate-500 mt-1">{code.code.slice(0, 60)}{code.code.length > 60 ? '...' : ''}</p>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex max-h-[calc(100vh-8rem)] min-h-0 flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-200 bg-slate-50 p-3 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-slate-800">{G1_EDU_23_ENV.robotType} Internal Simulator</h3>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">23-DoF local environment</p>
            </div>
            <span className="text-xs rounded-full bg-emerald-100 text-emerald-700 px-2 py-1">{simulatorState.status}</span>
          </div>

          <div className="border-b border-slate-200 bg-slate-50 px-3 pt-3">
            <div className="flex gap-2">
              {[
                { id: 'add-object', label: 'Add Object' },
                { id: 'scene-objects', label: 'Scene Objects' },
                { id: 'settings', label: 'Settings' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSimulatorSidebarTab(tab.id)}
                  className={`flex-1 rounded-t-md border-b-2 px-2 py-2 text-[10px] font-semibold uppercase tracking-wide transition ${simulatorSidebarTab === tab.id ? 'border-blue-600 bg-white text-blue-700' : 'border-transparent bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
            {simulatorSidebarTab === 'add-object' && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {OBJECT_LIBRARY.map((objectType) => (
                    <button
                      key={objectType.id}
                      type="button"
                      onClick={() => addStudentObstacle(objectType.id)}
                      className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-center transition hover:border-blue-300 hover:bg-blue-50"
                    >
                      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-white text-xl font-bold text-slate-700 shadow-sm">{objectType.icon}</div>
                      <p className="mt-2 text-[10px] font-semibold text-slate-700">{objectType.label}</p>
                    </button>
                  ))}
                </div>

              </>
            )}

            {simulatorSidebarTab === 'scene-objects' && (
              <div className="space-y-2">
                {sceneObjects.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">No scene objects yet. Add one from the object library.</p>
                ) : (
                  sceneObjects.map((obstacle) => (
                    <div key={obstacle.id} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">{obstacle.label}</span>
                        <button type="button" onClick={() => removeStudentObstacle(obstacle.id)} className="text-[10px] text-red-600">Delete</button>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-[10px] text-slate-600">
                        <label>
                          X
                          <input type="number" value={obstacle.x} step="0.5" onChange={(event) => updateStudentObstacle(obstacle.id, { x: Number(event.target.value) })} className="mt-1 w-full rounded border border-slate-200 bg-white px-1 py-1" />
                        </label>
                        <label>
                          Y
                          <input type="number" value={obstacle.y} step="0.5" onChange={(event) => updateStudentObstacle(obstacle.id, { y: Number(event.target.value) })} className="mt-1 w-full rounded border border-slate-200 bg-white px-1 py-1" />
                        </label>
                        <label>
                          R
                          <input type="number" value={obstacle.radius} min="4" max="24" step="1" onChange={(event) => updateStudentObstacle(obstacle.id, { radius: Number(event.target.value) })} className="mt-1 w-full rounded border border-slate-200 bg-white px-1 py-1" />
                        </label>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {simulatorSidebarTab === 'settings' && (
              <div className="space-y-3">
                <div className="rounded-lg border border-slate-200 bg-white p-2">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-2">Preview mode</p>
                  <div className="flex gap-2">
                    {Object.entries(SIMULATOR_MODES).map(([key, mode]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSimulatorMode(key)}
                        className={`flex-1 rounded-lg px-2 py-1.5 text-[10px] font-semibold transition ${simulatorMode === key ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-600">
                  <div className="flex items-center justify-between"><span>Robot</span><span className="font-medium text-slate-700">{G1_EDU_23_ENV.robotType}</span></div>
                  <div className="mt-2 flex items-center justify-between"><span>Grid cells</span><span className="font-medium text-slate-700">1 m x 1 m</span></div>
                  <div className="mt-2 flex items-center justify-between"><span>Goal</span><span className="font-medium text-slate-700">{simulatorState.goal ? `${simulatorState.goal.x.toFixed(1)}, ${simulatorState.goal.y.toFixed(1)}` : 'None'}</span></div>
                  <div className="mt-2 flex items-center justify-between"><span>Collisions</span><span className="font-medium text-slate-700">{simulatorState.collisions || 0}</span></div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-2 text-[10px] text-slate-600">
                  <label className="flex items-center justify-between font-semibold">
                    <span>Grid size</span>
                    <span>{gridSize} m x {gridSize} m</span>
                  </label>
                  <input type="range" min="10" max="80" step="1" value={gridSize} onChange={(event) => setGridSize(Number(event.target.value))} className="mt-2 w-full accent-blue-600" />
                  <label className="mt-3 flex items-center justify-between font-semibold">
                    <span>Simulation speed</span>
                    <span>{playbackSpeed.toFixed(1)}x</span>
                  </label>
                  <input type="range" min="0.1" max="3" step="0.1" value={playbackSpeed} onChange={(event) => setPlaybackSpeed(Number(event.target.value))} className="mt-2 w-full accent-cyan-600" />
                  <p className="mt-2 text-[10px] text-slate-500">Speed changes timing only. Distances remain in meters.</p>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-slate-200 bg-slate-100 p-2">
              <svg viewBox="0 0 220 220" className="block aspect-square w-full" onPointerMove={handleScenePointerMove} onPointerUp={handleScenePointerUp} onPointerLeave={handleScenePointerUp}>
                <defs>
                  <pattern id="grid-pattern" width={sceneScale} height={sceneScale} patternUnits="userSpaceOnUse">
                    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#dfe7f3" strokeWidth="1"/>
                  </pattern>
                </defs>
                <rect x="0" y="0" width="220" height="220" fill="url(#grid-pattern)" rx="12"/>
                {activeObstacles.map((obstacle) => {
                  const isStudentObstacle = String(obstacle.id).startsWith('student-');
                  const isEditable = currentUser.role !== 'teacher' && isStudentObstacle;
                  const isDragging = activeDragItem?.kind === 'obstacle' && activeDragItem.id === obstacle.id;
                  const color = obstacle.color || (isStudentObstacle ? '#a78bfa' : '#fbbf24');
                  return (
                    <g key={obstacle.id} onPointerDown={isEditable ? (event) => handleObstaclePointerDown(event, obstacle.id) : undefined} style={{ cursor: isEditable ? (isDragging ? 'grabbing' : 'grab') : 'default' }}>
                      {isDragging && <circle cx={sceneX(obstacle.x)} cy={sceneY(obstacle.y)} r={(obstacle.radius / 12) * sceneScale + 4} fill="none" stroke="#0891b2" strokeWidth="2" strokeDasharray="4 2" />}
                      <circle
                        cx={sceneX(obstacle.x)}
                        cy={sceneY(obstacle.y)}
                        r={(obstacle.radius / 12) * sceneScale}
                        fill={color}
                        fillOpacity={isStudentObstacle ? 0.45 : 0.35}
                        stroke={isStudentObstacle ? '#7c3aed' : '#f59e0b'}
                        strokeWidth={isEditable ? 2.5 : 2}
                        strokeDasharray={isEditable ? '0' : '6 3'}
                      />
                      {isEditable && <text x={sceneX(obstacle.x)} y={sceneY(obstacle.y) + 4} textAnchor="middle" fontSize="8" fill="#fff">drag</text>}
                    </g>
                  );
                })}
                {plannerWaypoints.length > 0 && (
                  <g>
                    <polyline
                      points={plannerWaypoints.map((point) => `${sceneX(point.x)},${sceneY(point.y)}`).join(' ')}
                      fill="none"
                      stroke="#22c55e"
                      strokeWidth="3"
                      strokeDasharray="6 4"
                      opacity="0.9"
                    />
                    {plannerWaypoints.map((point, index) => (
                      <g key={point.id} onPointerDown={(event) => handlePlannerWaypointPointerDown(event, point.id)} style={{ cursor: activeDragItem?.kind === 'waypoint' && activeDragItem.id === point.id ? 'grabbing' : 'grab' }}>
                        {activeDragItem?.kind === 'waypoint' && activeDragItem.id === point.id && <circle cx={sceneX(point.x)} cy={sceneY(point.y)} r="10" fill="none" stroke="#0891b2" strokeWidth="2" strokeDasharray="4 2" />}
                        <circle cx={sceneX(point.x)} cy={sceneY(point.y)} r="6" fill="#22c55e" stroke="#14532d" strokeWidth="2" />
                        <text x={sceneX(point.x)} y={sceneY(point.y) + 3} textAnchor="middle" fontSize="7" fill="#fff" fontWeight="700">{index + 1}</text>
                      </g>
                    ))}
                  </g>
                )}
                {simulatorState.goal && (
                  <g>
                    <circle cx={sceneX(simulatorState.goal.x)} cy={sceneY(simulatorState.goal.y)} r={simulatorState.goal.radius * sceneScale} fill={simulatorState.goalReached ? '#34d399' : '#a7f3d0'} fillOpacity="0.35" stroke="#22c55e" strokeWidth="2"/>
                    <text x={sceneX(simulatorState.goal.x)} y={sceneY(simulatorState.goal.y) - 12} textAnchor="middle" fontSize="9" fill="#166534" fontWeight="700">GOAL</text>
                  </g>
                )}
                <polyline
                  points={simulatorState.path.map((point) => `${sceneX(point.x)},${sceneY(point.y)}`).join(' ')}
                  fill="none"
                  stroke="#60a5fa"
                  strokeWidth="3"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity="0.9"
                />
                <g transform={`translate(${sceneX(simulatorState.x)}, ${sceneY(simulatorState.y)}) rotate(${simulatorState.heading})`}>
                  <rect x="-12" y="-10" width="24" height="20" rx="6" fill="#2563eb" stroke="#0f172a" strokeWidth="2"/>
                  <polygon points="18,0 28,6 18,12" fill="#f59e0b"/>
                  <circle cx="0" cy="0" r="3" fill="#f8fafc"/>
                </g>
              </svg>
            </div>

            <div className="space-y-2">
              {G1_MOTION_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => applyMotionTemplate(template)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  {template.label}
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>Position: {simulatorState.x.toFixed(1)}, {simulatorState.y.toFixed(1)}</span>
              <span>Heading: {simulatorState.heading.toFixed(0)}°</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">Torso pitch: {simulatorState.torsoPitch.toFixed(1)}°</div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">Torso roll: {simulatorState.torsoRoll.toFixed(1)}°</div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">Joints: {G1_EDU_23_ENV.jointCount}</div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">Collisions: {simulatorState.collisions || 0}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] text-slate-700">
              <span className="font-semibold">Mission:</span> {simulatorState.goalReached ? 'Goal reached ✓' : simulatorState.blocked ? 'Stuck on obstacle ⚠️' : 'In progress'}
            </div>
            <div className="space-y-2">
              {simulatorState.actions.map((action, index) => (
                <div key={`${action.label}-${index}`} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
                  <p className="text-xs font-semibold text-slate-700">{action.label}</p>
                  <p className="text-[11px] text-slate-500">{action.summary}</p>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Replay timeline</p>
              {(simulatorState.timeline?.length ? simulatorState.timeline : [{ label: 'Waiting', summary: 'No motion yet' }]).slice(0, 5).map((step, index) => (
                <div key={`${step.label}-${index}`} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                  <p className="text-[11px] font-semibold text-slate-700">{step.label}</p>
                  <p className="text-[10px] text-slate-500">{step.summary}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      </div>
      )}

      <div className="relative flex-1 overflow-hidden scene-shell">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(148,163,184,0.28),_rgba(15,23,42,0.04)_45%,_rgba(15,23,42,0.1))]" />
        <div className="scene-platform absolute left-[-8%] right-[-8%] top-[16%] bottom-[-8%] rounded-[28%]" />
        <G1Simulation3D
          code={generatedCode}
          simulatorState={simulatorState}
          obstacles={activeObstacles}
          waypoints={plannerWaypoints}
          isObstacleEditable={currentUser.role !== 'teacher'}
          onObstacleChange={updateStudentObstacle}
          onWaypointChange={updatePlannerWaypoint}
          isPlaying={isPreviewPlaying}
          playbackSpeed={playbackSpeed}
          playbackProgress={playbackProgress}
          gridSize={gridSize}
          onPlaybackProgress={setPlaybackProgress}
          onPlaybackToggle={(playing) => playing ? startSimulationPreview() : pauseSimulationPreview()}
          onPlaybackReset={resetSimulationPreview}
          onPlaybackSpeedChange={handlePlaybackSpeedChange}
        />

        <div
          className="absolute z-20 flex flex-col overflow-visible rounded-xl border border-slate-700 bg-slate-950/90 shadow-[0_0_30px_rgba(15,23,42,0.5)] backdrop-blur-sm"
          style={{
            top: toolPanelRect.top,
            right: toolPanelCollapsed ? 16 : toolPanelRect.right,
            width: toolPanelCollapsed ? 48 : toolPanelRect.width,
            height: toolPanelCollapsed ? 48 : toolPanelRect.height,
            maxHeight: 'calc(100% - 24px)',
          }}
          onPointerMove={updateToolPanelInteraction}
          onPointerUp={endToolPanelInteraction}
          onPointerCancel={endToolPanelInteraction}
        >
          {!toolPanelCollapsed && (
            <>
              <div className="absolute -left-1 top-3 bottom-3 z-40 w-2 cursor-ew-resize" onPointerDown={(event) => beginToolPanelInteraction(event, 'left')} />
              <div className="absolute -right-1 top-3 bottom-3 z-40 w-2 cursor-ew-resize" onPointerDown={(event) => beginToolPanelInteraction(event, 'right')} />
              <div className="absolute left-3 right-3 -top-1 z-40 h-2 cursor-ns-resize" onPointerDown={(event) => beginToolPanelInteraction(event, 'top')} />
              <div className="absolute left-3 right-3 -bottom-1 z-40 h-2 cursor-ns-resize" onPointerDown={(event) => beginToolPanelInteraction(event, 'bottom')} />
              <div className="absolute -left-1 -top-1 z-40 h-3 w-3 cursor-nwse-resize" onPointerDown={(event) => beginToolPanelInteraction(event, 'left top')} />
              <div className="absolute -right-1 -top-1 z-40 h-3 w-3 cursor-nesw-resize" onPointerDown={(event) => beginToolPanelInteraction(event, 'right top')} />
              <div className="absolute -left-1 -bottom-1 z-40 h-3 w-3 cursor-nesw-resize" onPointerDown={(event) => beginToolPanelInteraction(event, 'left bottom')} />
              <div className="absolute -right-1 -bottom-1 z-40 h-3 w-3 cursor-nwse-resize" onPointerDown={(event) => beginToolPanelInteraction(event, 'right bottom')} />
            </>
          )}
          <div className="flex cursor-move items-center justify-between border-b border-slate-700 bg-slate-900 px-2 py-2" onPointerDown={(event) => beginToolPanelInteraction(event, 'move')}>
            <button
              type="button"
              onClick={() => setToolPanelCollapsed((value) => !value)}
              onPointerDown={(event) => event.stopPropagation()}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-slate-800 text-slate-200 hover:bg-slate-700"
            >
              {toolPanelCollapsed ? '»' : '«'}
            </button>
            {!toolPanelCollapsed && (
              <span className="truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                {overlayTabs.find((tab) => tab.id === mainTab)?.label}
              </span>
            )}
            {!toolPanelCollapsed && <div className="h-7 w-7" aria-hidden="true" />}
          </div>

          {!toolPanelCollapsed && (
            <div className="border-b border-slate-700 bg-slate-900/90 p-2">
              <div className="flex gap-2">
                <button type="button" onClick={handleRunSimulation} className="flex-1 rounded-md bg-emerald-500 px-2 py-2 text-[10px] font-bold text-slate-950 hover:bg-emerald-400">
                  {isPreviewPlaying ? 'Running simulation' : 'Run simulation'}
                </button>
                {currentUser.role === 'student' && (
                  <>
                    <button type="button" onClick={handleSubmitToQueue} className="flex-1 rounded-md bg-violet-500 px-2 py-2 text-[10px] font-bold text-white hover:bg-violet-400">
                      Submit to teacher
                    </button>
                    <button type="button" onClick={() => setIsSimulatorOpen(true)} className="rounded-md bg-slate-700 px-2 py-2 text-[10px] font-bold text-white hover:bg-slate-600" title="Open saved code">
                      Library
                    </button>
                  </>
                )}
                {currentUser.role === 'teacher' && (
                  <>
                    <button type="button" onClick={() => setIsSimulatorOpen(true)} className="flex-1 rounded-md bg-blue-500 px-2 py-2 text-[10px] font-bold text-white hover:bg-blue-400">
                      Open queue
                    </button>
                    <button type="button" onClick={handleRunCode} className="rounded-md bg-amber-500 px-2 py-2 text-[10px] font-bold text-slate-950 hover:bg-amber-400" title="Run code on connected robot">
                      {isRunning ? 'Stop robot' : 'Robot run'}
                    </button>
                  </>
                )}
              </div>
              <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400">
                <span>{currentUser.role === 'teacher' ? 'Teacher workspace' : 'Student workspace'}</span>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={handleSaveCodeToAccount} className="text-slate-300 hover:text-white">Save</button>
                  <button type="button" onClick={handleLogout} className="text-slate-300 hover:text-white">Logout</button>
                  <button type="button" onClick={() => setShowConfigEditor(true)} className="text-slate-300 hover:text-white">Settings</button>
                </div>
              </div>
            </div>
          )}

          {toolPanelCollapsed ? (
            <div className="flex flex-1 flex-col items-center gap-2 overflow-hidden py-2">
              {overlayTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setMainTab(tab.id)}
                  className={`h-8 w-8 rounded-md text-[9px] font-semibold ${mainTab === tab.id ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                  title={tab.label}
                >
                  {tab.label.slice(0, 1).toUpperCase()}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="flex gap-2 border-b border-slate-700 bg-slate-900/70 p-2">
                {overlayTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setMainTab(tab.id)}
                    className={`flex-1 rounded-md px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide transition ${mainTab === tab.id ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="min-h-0 flex-1 overflow-auto p-3">
                {mainTab === 'blocks' && (
                  <div className="space-y-3 text-slate-200">
                    <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Workspace</p>
                      <div className="mt-3 flex gap-2">
                        <button type="button" onClick={handleRunSimulation} className="flex-1 rounded-md bg-emerald-600 px-2 py-2 text-xs font-semibold text-white hover:bg-emerald-500">Run simulation</button>
                        <button type="button" onClick={handleClear} className="flex-1 rounded-md bg-slate-700 px-2 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-600">Clear</button>
                      </div>
                    </div>
                    <div ref={blocklyDiv} className="h-[min(680px,calc(100vh-16rem))] min-h-[420px] overflow-hidden rounded-xl border border-slate-700 bg-slate-950" />
                    <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Generated code</p>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-6 text-slate-200">
                        {generatedCode || '# Python code will appear here'}
                      </pre>
                    </div>
                  </div>
                )}

                {mainTab === 'planner' && (
                  <div className="space-y-3 text-slate-200">
                    <div className="flex gap-2">
                      <button type="button" onClick={addPlannerWaypoint} className="flex-1 rounded-md bg-blue-600 px-2 py-2 text-[10px] font-semibold text-white hover:bg-blue-500">Add waypoint</button>
                      <button type="button" onClick={compilePlannerPath} className="flex-1 rounded-md bg-emerald-600 px-2 py-2 text-[10px] font-semibold text-white hover:bg-emerald-500">Compile</button>
                    </div>
                    {plannerWaypoints.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-slate-600 bg-slate-900 p-3 text-xs text-slate-400">No waypoints yet.</p>
                    ) : (
                      plannerWaypoints.map((point, index) => (
                        <div key={point.id} className="rounded-lg border border-slate-700 bg-slate-900 p-2">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">Waypoint {index + 1}</span>
                            <button type="button" onClick={() => removePlannerWaypoint(point.id)} className="text-[10px] text-red-400">Delete</button>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-300">
                            <label>
                              X
                              <input type="number" value={point.x} step="0.5" onChange={(event) => updatePlannerWaypoint(point.id, { x: Number(event.target.value) })} className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-1 py-1 text-slate-100" />
                            </label>
                            <label>
                              Y
                              <input type="number" value={point.y} step="0.5" onChange={(event) => updatePlannerWaypoint(point.id, { y: Number(event.target.value) })} className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-1 py-1 text-slate-100" />
                            </label>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {mainTab === 'prompt' && (
                  <div className="space-y-3 text-slate-200">
                    <div className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 p-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-200">Text to motion</p>
                      <p className="mt-2 text-xs leading-5 text-slate-300">Describe a short safe movement sequence. The generated commands sync to Blocks, IDE, and the live G1 simulation.</p>
                    </div>
                    <textarea
                      value={motionPrompt}
                      onChange={(event) => setMotionPrompt(event.target.value)}
                      className="h-28 w-full resize-none rounded-xl border border-slate-700 bg-slate-900 p-3 text-sm leading-6 text-slate-100 outline-none focus:border-cyan-400"
                      placeholder="Example: walk forward 3 steps, turn left, wave"
                    />
                    <div className="flex flex-wrap gap-2">
                      {[
                        'Walk forward 3 steps, turn left 90 degrees, then wave',
                        'Walk backward 2 steps and sit',
                        'Repeat a square path 2 times',
                      ].map((example) => (
                        <button key={example} type="button" onClick={() => setMotionPrompt(example)} className="rounded-md bg-slate-800 px-2 py-1.5 text-left text-[10px] text-slate-300 hover:bg-slate-700">
                          {example}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => generateMotionFromPrompt(false)} className="rounded-md bg-slate-700 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-600">
                        Local generate
                      </button>
                      <button type="button" onClick={() => generateMotionFromPrompt(true)} disabled={motionPromptStatus === 'loading'} className="rounded-md bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60">
                        {motionPromptStatus === 'loading' ? 'Generating...' : 'Generate with HF'}
                      </button>
                    </div>
                    <p className="text-[10px] text-slate-400">
                      {motionPromptStatus === 'hf' ? motionPromptResult?.source : motionPromptStatus === 'fallback' ? 'HF unavailable; local compiler used.' : 'Both paths sync to Blocks, IDE, and 3D.'}
                    </p>
                    {motionPromptResult && (
                      <div className="space-y-2 rounded-xl border border-slate-700 bg-slate-900 p-3">
                        <p className="text-xs font-semibold text-cyan-200">{motionPromptResult.summary}</p>
                        {motionPromptResult.steps.map((step, index) => (
                          <div key={`${step.code}-${index}`} className="flex items-center justify-between gap-2 rounded-md bg-slate-800 px-2 py-1.5 text-[10px]">
                            <span className="text-slate-200">{index + 1}. {step.label}</span>
                            <code className="text-cyan-300">{step.code}</code>
                          </div>
                        ))}
                        {motionPromptResult.unknown.map((message) => <p key={message} className="text-xs text-amber-300">{message}</p>)}
                      </div>
                    )}
                  </div>
                )}

                {mainTab === 'camera' && (
                  <div className="space-y-3 text-slate-200">
                    <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Live pose</p>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-sm text-slate-200">Pose recognized</span>
                        <span className="rounded-full bg-emerald-500/20 px-2 py-1 text-[10px] font-semibold text-emerald-300">Ready</span>
                      </div>
                    </div>
                    <div className="rounded-xl border border-amber-200/50 bg-amber-500/10 p-3 text-amber-100">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300">Overwrite warning</p>
                      <p className="mt-2 text-xs">Recording will replace the current code in the Blocks and IDE tabs.</p>
                      <button type="button" onClick={handleRecordMotionCapture} className="mt-3 w-full rounded-md bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500">Record motion + update tabs</button>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Quick actions</p>
                      <div className="mt-2 space-y-2 text-xs text-slate-200">
                        <button type="button" onClick={() => insertRobotCommand('robot.stand();')} className="block w-full rounded-md bg-slate-800 px-2 py-1.5 text-left hover:bg-slate-700">Stand</button>
                        <button type="button" onClick={() => insertRobotCommandWithValue('walkForward', 3, 'steps')} className="block w-full rounded-md bg-slate-800 px-2 py-1.5 text-left hover:bg-slate-700">Walk Forward (steps)</button>
                        <button type="button" onClick={() => insertRobotCommandWithValue('wait', 1, 'seconds')} className="block w-full rounded-md bg-slate-800 px-2 py-1.5 text-left hover:bg-slate-700">Wait (seconds)</button>
                        <button type="button" onClick={() => insertRobotCommand('robot.raiseBothArms();')} className="block w-full rounded-md bg-slate-800 px-2 py-1.5 text-left hover:bg-slate-700">Raise Both Arms</button>
                      </div>
                    </div>
                  </div>
                )}

                {mainTab === 'ide' && (
                  <div className="space-y-3 text-slate-200">
                    <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Quick commands</p>
                      <div className="mt-2 space-y-2 text-xs">
                        {quickRobotCommands.slice(0, 8).map((command) => (
                          <button
                            key={command.label || command.snippet || 'quick-command'}
                            type="button"
                            onClick={() => { if (command.action) command.action(); else if (command.snippet) insertRobotCommand(command.snippet); }}
                            className="block w-full rounded-md bg-slate-800 px-2 py-1.5 text-left text-slate-200 hover:bg-slate-700"
                          >
                            {command.label || command.snippet}
                          </button>
                        ))}
                      </div>
                    </div>
                    <textarea
                      value={generatedCode || ''}
                      onChange={(event) => {
                        const nextCode = event.target.value;
                        applyGeneratedCode(nextCode, { syncBlocks: true });
                      }}
                      onBlur={() => syncBlocksFromGeneratedCode(generatedCodeRef.current)}
                      spellCheck={false}
                      className="h-64 w-full resize-none rounded-xl border border-slate-700 bg-slate-900 p-3 font-mono text-[11px] leading-6 text-slate-100 outline-none"
                    />
                  </div>
                )}
              </div>

              <div className="border-t border-slate-700 bg-slate-900 p-2 text-center text-[10px] uppercase tracking-[0.14em] text-slate-500">
                Drag the header to move. Drag any edge to resize.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}