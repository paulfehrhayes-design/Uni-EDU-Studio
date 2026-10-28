import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { 
  Save, FolderOpen, Download, Settings, Play, Square,
  Code, X, RefreshCw, FileJson, Check, Loader2, Globe,
  Menu, Undo, Redo, Info, ChevronRight, Sidebar, MoreVertical,
  Upload, FileText, Edit3, FunctionSquare
} from 'lucide-react';
import * as Blockly from 'blockly/core';
import { pythonGenerator } from 'blockly/python';
pythonGenerator.INDENT = '    ';
import * as En from 'blockly/msg/en';
import * as Zh from 'blockly/msg/zh-hans';
import 'blockly/blocks';
import g1BasicConfigZh from '../block_configurations/g1_basic/g1_basic.json';
import g1BasicConfigEn from '../block_configurations/g1_basic/g1_basic_en.json';
import { G1_EDU_23_ENV, SIMULATOR_MODES, buildPlannerMotionCommands, clampScenePoint, createEmptyG1Edu23State, simulateG1Edu23Program } from './sim/g1Edu23Env';
import { getSceneObjectBaseDimensions, getSceneObjectDimensions } from './sim/sceneObjects';
import G1Simulation3D from './components/G1Simulation3D';
import {
  isWorldPointInKnownFreeSpace,
  mapLocalToWorld,
  occupancyAtMapLocalPoint,
  worldToMapLocal,
} from './navigation/mapCoordinates.js';
import { compileMotionPrompt } from './sim/textToMotion';
import { flattenG1Commands, formatG1Program, G1_ARM_PRESET_DESCRIPTIONS, G1_COMMANDS, G1_EXECUTABLE_COMMANDS, G1_NOMINAL_STEP_METERS, getG1BlocklyCommandBlocks, getG1BlocklyConditionBlocks, parseG1Program } from './sim/g1Commands';
import {
  DUET_COMMANDS,
  compileDuetMotionPrompt,
  formatDuetProgram,
  getDuetBlocklyCommandBlocks,
  getDuetCommandExamples,
  parseDuetProgram,
} from './sim/duetCommands.js';
import { simulateDuetG1Edu23Program } from './sim/duetG1Edu23Env.js';
import { createRobotConnection } from './robot/RobotConnection';
import { DuetRobotConnection } from './robot/DuetRobotConnection.js';

const blocklyRuntime = Object.assign({}, Blockly, { Python: pythonGenerator });
window.Blockly = blocklyRuntime;

const PLANNER_PATH_MODES = Object.freeze({
  manual: 'manual',
  sensor_corrected: 'sensor_corrected',
  autonomous: 'autonomous',
});

const PLANNER_MODE_LABELS = Object.freeze({
  manual: 'Normal path',
  sensor_corrected: 'Sensor-corrected path',
  autonomous: 'Autonomous obstacle-aware path',
});

function attachPlannerProjectMeta(code = '', meta = {}) {
  if (!meta || typeof meta !== 'object' || !Object.keys(meta).length) {
    return code || '';
  }
  const payload = JSON.stringify(meta, null, 0);
  return `# __PLANNER_META__ ${payload}\n${code || ''}`.trimEnd() + '\n';
}

function stripPlannerProjectMeta(code = '') {
  if (!code || typeof code !== 'string') return '';
  return code.replace(/^# __PLANNER_META__ .*\n?/m, '').trim();
}

function parsePlannerProjectMeta(code = '') {
  if (!code || typeof code !== 'string') return null;
  const match = code.match(/^# __PLANNER_META__\s*(\{.*\})\s*\n?/m);
  if (!match || !match[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function buildSdkCommandsFromTrace(pathTrace = []) {
  if (!Array.isArray(pathTrace) || pathTrace.length < 2) {
    throw new Error('Nav2 did not provide enough executed localization samples to create an editable SDK path.');
  }
  const sampled = [pathTrace[0]];
  pathTrace.slice(1).forEach((point) => {
    const previous = sampled.at(-1);
    if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.2
      || Math.abs(point.yaw_rad - previous.yaw_rad) >= 0.2) {
      sampled.push(point);
    }
  });
  if (sampled.length < 2) {
    throw new Error('The recorded Nav2 route contains no measurable movement to convert.');
  }
  if (sampled.length > 200) {
    throw new Error('The recorded Nav2 route is too detailed to safely convert to editable SDK commands.');
  }
  const commands = ['robot.stand()'];
  for (let index = 1; index < sampled.length; index += 1) {
    const from = sampled[index - 1];
    const to = sampled[index];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const direction = Math.atan2(to.y - from.y, to.x - from.x);
    const turnDelta = ((direction - from.yaw_rad + Math.PI) % (2 * Math.PI)) - Math.PI;
    if (Math.abs(turnDelta) >= 0.08) {
      commands.push(`robot.turn("${turnDelta > 0 ? 'left' : 'right'}", ${Math.min(180, Math.abs(turnDelta * 180 / Math.PI)).toFixed(2)})`);
    }
    let remaining = distance / 0.4;
    while (remaining >= 0.1) {
      const duration = Math.min(10, remaining);
      commands.push(`robot.walktime(${duration.toFixed(3)})`);
      remaining -= duration;
    }
  }
  commands.push('robot.stand()');
  if (commands.length > 400) {
    throw new Error('The recorded Nav2 route exceeds the 400-command SDK editor limit.');
  }
  return commands;
}

function relativePlannerWaypointsFromTrace(pathTrace = []) {
  if (!Array.isArray(pathTrace) || pathTrace.length < 2) return [];
  const start = pathTrace[0];
  const cosine = Math.cos(start.yaw_rad);
  const sine = Math.sin(start.yaw_rad);
  return pathTrace
    .filter((point, index) => index === 0 || Math.hypot(point.x - pathTrace[index - 1].x, point.y - pathTrace[index - 1].y) >= 0.2)
    .map((point, index) => {
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      return {
        id: `planner-recorded-${index}`,
        x: Number((dx * cosine + dy * sine).toFixed(2)),
        y: Number((-dx * sine + dy * cosine).toFixed(2)),
      };
    });
}

function buildPlannerProjectName(mode) {
  const suffix = PLANNER_MODE_LABELS[mode] || 'Path';
  return `${suffix.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

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
    configDesc: "机器人命令由共享命令目录管理。旧配置仅供迁移参考，不能增加可执行命令。",
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
    configDesc: "Executable commands come from the shared G1 command catalog. Legacy configs are for migration only and cannot add robot commands.",
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

function SceneObstacleShape({ obstacle, centerX, centerY, size, color, opacity, stroke, strokeWidth, strokeDasharray }) {
  const common = { fill: color, fillOpacity: opacity, stroke, strokeWidth, strokeDasharray };
  switch (obstacle.type) {
    case 'box':
      return (
        <g>
          <polygon {...common} points={`${centerX - size * 0.68},${centerY - size * 0.42} ${centerX},${centerY - size * 0.78} ${centerX + size * 0.68},${centerY - size * 0.42} ${centerX},${centerY - size * 0.06}`} />
          <polygon {...common} points={`${centerX - size * 0.68},${centerY - size * 0.42} ${centerX},${centerY - size * 0.06} ${centerX},${centerY + size * 0.72} ${centerX - size * 0.68},${centerY + size * 0.36}`} />
          <polygon {...common} points={`${centerX},${centerY - size * 0.06} ${centerX + size * 0.68},${centerY - size * 0.42} ${centerX + size * 0.68},${centerY + size * 0.36} ${centerX},${centerY + size * 0.72}`} />
        </g>
      );
    case 'wall':
      return (
        <g>
          <rect {...common} x={centerX - size * 1.2} y={centerY - size * 0.34} width={size * 2.4} height={size * 0.68} rx="2" />
          <path d={`M ${centerX - size * 0.6} ${centerY - size * 0.3} v ${size * 0.6} M ${centerX} ${centerY - size * 0.3} v ${size * 0.6} M ${centerX + size * 0.6} ${centerY - size * 0.3} v ${size * 0.6}`} fill="none" stroke={stroke} strokeWidth={Math.max(1, strokeWidth * 0.7)} />
        </g>
      );
    case 'platform':
      return (
        <g>
          <rect {...common} x={centerX - size * 0.88} y={centerY - size * 0.62} width={size * 1.76} height={size * 1.24} rx={size * 0.28} />
          <rect x={centerX - size * 0.58} y={centerY - size * 0.34} width={size * 1.16} height={size * 0.68} rx={size * 0.18} fill="none" stroke={stroke} strokeWidth={Math.max(1, strokeWidth * 0.65)} />
        </g>
      );
    case 'ramp':
      return (
        <g>
          <polygon {...common} points={`${centerX - size},${centerY + size * 0.7} ${centerX + size},${centerY + size * 0.7} ${centerX + size},${centerY - size * 0.7}`} />
          <path d={`M ${centerX - size * 0.52} ${centerY + size * 0.38} L ${centerX + size * 0.48} ${centerY - size * 0.42}`} fill="none" stroke={stroke} strokeWidth={Math.max(1, strokeWidth * 0.8)} strokeDasharray="3 2" />
        </g>
      );
    case 'stairs':
      return <path {...common} d={`M ${centerX - size} ${centerY + size * 0.65} v ${-size * 0.4} h ${size * 0.65} v ${-size * 0.4} h ${size * 0.7} v ${-size * 0.4} h ${size * 0.65} v ${size * 1.2} Z`} />;
    case 'sphere':
      return (
        <g>
          <circle {...common} cx={centerX} cy={centerY} r={size * 0.72} />
          <circle cx={centerX - size * 0.2} cy={centerY - size * 0.2} r={size * 0.14} fill="white" fillOpacity="0.65" />
        </g>
      );
    case 'cylinder':
      return (
        <g>
          <circle {...common} cx={centerX} cy={centerY} r={size * 0.72} />
          <ellipse cx={centerX} cy={centerY} rx={size * 0.42} ry={size * 0.2} fill="none" stroke={stroke} strokeWidth={Math.max(1, strokeWidth * 0.75)} />
          <path d={`M ${centerX - size * 0.5} ${centerY} h ${size}`} fill="none" stroke={stroke} strokeWidth={Math.max(1, strokeWidth * 0.65)} />
        </g>
      );
    case 'table':
      return (
        <g>
          <rect {...common} x={centerX - size * 0.82} y={centerY - size * 0.62} width={size * 1.64} height={size * 1.24} rx="3" />
          {[-1, 1].flatMap((xSign) => [-1, 1].map((ySign) => (
            <circle key={`${xSign}-${ySign}`} cx={centerX + xSign * size * 0.58} cy={centerY + ySign * size * 0.43} r={size * 0.1} fill={stroke} />
          )))}
        </g>
      );
    case 'terrain':
      return (
        <g>
          <polygon {...common} points={`${centerX - size},${centerY + size * 0.35} ${centerX - size * 0.65},${centerY - size * 0.35} ${centerX - size * 0.1},${centerY - size * 0.1} ${centerX + size * 0.25},${centerY - size * 0.7} ${centerX + size},${centerY + size * 0.35}`} />
          <path d={`M ${centerX - size * 0.45} ${centerY + size * 0.1} Q ${centerX - size * 0.1} ${centerY - size * 0.35} ${centerX + size * 0.5} ${centerY - size * 0.05}`} fill="none" stroke={stroke} strokeWidth={Math.max(1, strokeWidth * 0.7)} />
        </g>
      );
    default:
      return <circle {...common} cx={centerX} cy={centerY} r={size} />;
  }
}

function removeBlocklyVariableInitializers(code, initializers) {
  const lines = code.split('\n');
  let removedInitializer = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (initializers.has(lines[index])) {
      lines.splice(index, 1);
      removedInitializer = true;
    }
  }
  return removedInitializer
    ? lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
    : code;
}

function generateBlocklyPythonCode(workspace) {
  const initializers = new Set();
  workspace.getTopBlocks(true).forEach((topBlock) => {
    let block = topBlock;
    while (block) {
      if (block.type === 'variables_set' && block.getInputTargetBlock('VALUE')?.type === 'logic_boolean') {
        const variable = workspace.getVariableById(block.getFieldValue('VAR'));
        if (variable) initializers.add(`${variable.getName()} = None`);
      }
      block = block.getNextBlock();
    }
  });
  return removeBlocklyVariableInitializers(
    pythonGenerator.workspaceToCode(workspace),
    initializers,
  );
}

function isNavigationWaypointInFreeSpace(waypoint, snapshot) {
  return isWorldPointInKnownFreeSpace(waypoint.x, waypoint.y, snapshot);
}

function formatLidarDistanceSample(sample, label) {
  if (!sample?.ready) return `${label} distance conditions disabled • ${sample?.error || 'provider status not reported'}`;
  if (sample.calibrated !== true || sample.measurement !== 'footprint_clearance') {
    return `${label} unavailable • provider sample is not calibrated to the robot footprint`;
  }
  if (sample.clear) return `${label} clear within ${sample.max_range_m} m`;
  return `${label} clearance ${sample.distance_m.toFixed(2)} m from robot footprint • ${sample.age_ms} ms old`;
}

function formatLidarDistanceStatus(sensor) {
  return [
    formatLidarDistanceSample(sensor, 'Front'),
    formatLidarDistanceSample(sensor?.rear, 'Rear'),
  ].join(' • ');
}

const SAFE_COMMAND_LIMITS = {
  SPEED: { min: 0.5, max: 2 },
  STEPS: { min: 1, max: 10 },
  ANGLE: { min: 5, max: 180 },
  DEGREES: { min: 0, max: 180 },
  SECONDS: { min: 0.1, max: 10 },
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
  sanitized = sanitized.replace(/robot\.walkForward\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'SPEED');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkForward(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.walkForwardSteps\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'STEPS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkForward(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.walkBackward\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'SPEED');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkBackward(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.walkBackwardSteps\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'STEPS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkBackward(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.walkSidewaysLeft\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'SPEED');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkSidewaysLeft(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.walkSidewaysLeftSteps\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'STEPS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkSidewaysLeft(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.walkSidewaysRight\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'SPEED');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkSidewaysRight(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.walkSidewaysRightSteps\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'STEPS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.walkSidewaysRight(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.turnLeft\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'ANGLE');
    if (safeValue !== value.trim()) changed = true;
    return `robot.turnLeft(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.turnRight\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'ANGLE');
    if (safeValue !== value.trim()) changed = true;
    return `robot.turnRight(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.raiseLeftArm\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const parts = value.split(',').map((part) => part.trim());
    const position = parts[0] || 'mid';
    const degrees = sanitizeNumber(parts[1] || 90, 'DEGREES');
    if (degrees !== (parts[1] || '90').trim()) changed = true;
    return `robot.raiseLeftArm(${position}, ${degrees})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.raiseRightArm\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const parts = value.split(',').map((part) => part.trim());
    const position = parts[0] || 'mid';
    const degrees = sanitizeNumber(parts[1] || 90, 'DEGREES');
    if (degrees !== (parts[1] || '90').trim()) changed = true;
    return `robot.raiseRightArm(${position}, ${degrees})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.raiseLeftLeg\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const parts = value.split(',').map((part) => part.trim());
    const position = parts[0] || 'mid';
    const degrees = sanitizeNumber(parts[1] || 90, 'DEGREES');
    if (degrees !== (parts[1] || '90').trim()) changed = true;
    return `robot.raiseLeftLeg(${position}, ${degrees})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.raiseRightLeg\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const parts = value.split(',').map((part) => part.trim());
    const position = parts[0] || 'mid';
    const degrees = sanitizeNumber(parts[1] || 90, 'DEGREES');
    if (degrees !== (parts[1] || '90').trim()) changed = true;
    return `robot.raiseRightLeg(${position}, ${degrees})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.wait\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'SECONDS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.wait(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.waitSeconds\(([^)]+)\)(;?)/g, (_, value, terminator) => {
    const safeValue = sanitizeNumber(value, 'SECONDS');
    if (safeValue !== value.trim()) changed = true;
    return `robot.wait(${safeValue})${terminator}`;
  });
  sanitized = sanitized.replace(/robot\.repeatLoop\(([^)]+)\)/g, (_, value) => {
    const safeValue = sanitizeNumber(value, 'STEPS');
    if (safeValue !== value.trim()) changed = true;
    return `for (let i = 0; i < ${safeValue}; i++) {\n  robot.raiseBothArms();\n}\n`;
  });
  sanitized = sanitized.replace(/robot\.stop\(\)(;?)/g, (_, terminator) => `robot.stop()${terminator}`);
  sanitized = sanitized.replace(/robot\.lowerBothArms\(\)(;?)/g, (_, terminator) => `robot.lowerBothArms()${terminator}`);
  sanitized = sanitized.replace(/robot\.waveRight\(\)(;?)/g, (_, terminator) => `robot.waveRight()${terminator}`);
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
    message0: 'Wait %1 seconds',
    args0: [{ type: 'field_number', name: 'SECONDS', value: 1, min: 0.1, max: 10, precision: 0.001 }],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.wait({{SECONDS}})\n',
  },
  {
    type: 'robot_wait_seconds',
    message0: 'Wait %1 seconds',
    args0: [{ type: 'field_number', name: 'SECONDS', value: 1, min: 0.1, max: 10, precision: 0.001 }],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    codeTemplate: 'robot.wait({{SECONDS}})\n',
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
  const applyGeneratedCodeRef = useRef(null);
  const processedAutonomousOperationRef = useRef(null);
  
  const [lang, setLang] = useState('en');
  const [robotConfig, setRobotConfig] = useState(DEFAULT_ROBOT_CONFIG_EN);
  const [generatedCode, setGeneratedCode] = useState('');
  const generatedCodeRef = useRef('');
  const [controllerVersion, setControllerVersion] = useState('legacy');
  const controllerVersionRef = useRef('legacy');
  controllerVersionRef.current = controllerVersion;
  const codeByVersionRef = useRef({ legacy: '', duet: '' });
  const duetProgramActiveRef = useRef(false);
  const [isDuetProgramActive, setIsDuetProgramActive] = useState(false);
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
  const [selectedSceneObjectId, setSelectedSceneObjectId] = useState(null);
  const [activeDragItem, setActiveDragItem] = useState(null);
  const [projectName, setProjectName] = useState('default');
  const [projectLibrary, setProjectLibrary] = useState([]);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [gridSize, setGridSize] = useState(20);
  const [plannerWaypoints, setPlannerWaypoints] = useState([]);
  const [pathPlannerMode, setPathPlannerMode] = useState(PLANNER_PATH_MODES.manual);
  const [plannerRouteVariants, setPlannerRouteVariants] = useState({ initial: '', corrected: '', final: '' });
  const [originalPlannerCode, setOriginalPlannerCode] = useState('');
  const [selectedPlannerVariant, setSelectedPlannerVariant] = useState('final');
  const [plannerProjectLabel, setPlannerProjectLabel] = useState('');
  const [isWaypointPlacementEnabled, setIsWaypointPlacementEnabled] = useState(false);
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
  const [queueReviewItem, setQueueReviewItem] = useState(null);
  const [queueReviewError, setQueueReviewError] = useState('');
  const [queueReviewStatus, setQueueReviewStatus] = useState('');
  const [queueReviewSavedProject, setQueueReviewSavedProject] = useState(null);
  const [queueReviewNavigationPreview, setQueueReviewNavigationPreview] = useState(null);
  const [queueReviewNavigationOperation, setQueueReviewNavigationOperation] = useState(null);
  const [isQueueReviewRunning, setIsQueueReviewRunning] = useState(false);
  const [isQueueReviewPreviewing, setIsQueueReviewPreviewing] = useState(false);
  const [teacherRoster, setTeacherRoster] = useState([]);
  const [loginForm, setLoginForm] = useState({ username: 'teacher', password: 'teacher', role: 'teacher' });
  const [loginError, setLoginError] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [newStudent, setNewStudent] = useState({ username: '', password: '', role: 'student' });
  const [accountManagementError, setAccountManagementError] = useState('');
  const [isCreatingStudent, setIsCreatingStudent] = useState(false);
  const [deletingUsername, setDeletingUsername] = useState('');
  const [classroomStatus, setClassroomStatus] = useState('idle');
  const [robotConnectionStatus, setRobotConnectionStatus] = useState('Not connected');
  const [lidarTestStatus, setLidarTestStatus] = useState('Not tested');
  const [navigationBridgeStatus, setNavigationBridgeStatus] = useState('Not checked');
  const [navigationDiagnostics, setNavigationDiagnostics] = useState(null);
  const [isNavigationMotionReady, setIsNavigationMotionReady] = useState(false);
  const [isNavigationBridgeChecking, setIsNavigationBridgeChecking] = useState(false);
  const [navigationMapSnapshot, setNavigationMapSnapshot] = useState(null);
  const [navigationPlannerMode, setNavigationPlannerMode] = useState('static');
  const navigationPlannerModeRef = useRef(navigationPlannerMode);
  navigationPlannerModeRef.current = navigationPlannerMode;
  const [liveNavigationObstacles, setLiveNavigationObstacles] = useState(null);
  const [liveNavigationPose, setLiveNavigationPose] = useState(null);
  const [isLiveAvoidanceReady, setIsLiveAvoidanceReady] = useState(false);
  const [navigationMapStatus, setNavigationMapStatus] = useState('Map not loaded');
  const [isNavigationMapLoading, setIsNavigationMapLoading] = useState(false);
  const [isNavigationMapVisible, setIsNavigationMapVisible] = useState(false);
  const [navigationRouteWaypoints, setNavigationRouteWaypoints] = useState([]);
  const navigationRouteWaypointsRef = useRef(navigationRouteWaypoints);
  navigationRouteWaypointsRef.current = navigationRouteWaypoints;
  const [navigationRoutePreview, setNavigationRoutePreview] = useState(null);
  const [isNavigationPreviewing, setIsNavigationPreviewing] = useState(false);
  const [navigationPreviewStatus, setNavigationPreviewStatus] = useState('No route preview');
  const [isNavigationGoalPlacementEnabled, setIsNavigationGoalPlacementEnabled] = useState(false);
  const [navigationOperation, setNavigationOperation] = useState(null);
  const [navigationExecutionStatus, setNavigationExecutionStatus] = useState('No navigation operation');
  const [isNavigationStarting, setIsNavigationStarting] = useState(false);
  const [lidarScanJob, setLidarScanJob] = useState(null);
  const [lidarScanStatus, setLidarScanStatus] = useState('No room scan');
  const [liveLidarScanPoints, setLiveLidarScanPoints] = useState([]);
  const [isLidarScanStarting, setIsLidarScanStarting] = useState(false);
  const [isLidarScanFinalizing, setIsLidarScanFinalizing] = useState(false);
  const [sharedLidarOverlayEnabled, setSharedLidarOverlayEnabled] = useState(false);
  const [sharedLidarMap, setSharedLidarMap] = useState(null);
  const [isSharedLidarMapLoading, setIsSharedLidarMapLoading] = useState(false);
  const [navigationLiveStatus, setNavigationLiveStatus] = useState('Live updates disconnected');
  const sharedMapVersionRef = useRef(null);
  const sharedMapLoadedRef = useRef(false);
  const liveNavigationMapVersionRef = useRef(null);
  const navigationMapSnapshotRef = useRef(null);
  const navigationMapRefreshPendingRef = useRef(false);
  const navigationMapRefreshStartedRef = useRef(0);
  const navigationMapCoordinatesRef = useRef(null);
  const navigationWaypointFrameRef = useRef(null);
  const [isRobotConnected, setIsRobotConnected] = useState(false);
  const [isRobotConnecting, setIsRobotConnecting] = useState(false);
  const [isLidarTesting, setIsLidarTesting] = useState(false);
  const [sensorDiagnostics, setSensorDiagnostics] = useState(null);
  const [isSensorDiscovering, setIsSensorDiscovering] = useState(false);
  const [sensorOperationStatus, setSensorOperationStatus] = useState('');
  const [sensorOperationBusy, setSensorOperationBusy] = useState('');
  const [cameraInputSource, setCameraInputSource] = useState('device');
  const [deviceCameraStatus, setDeviceCameraStatus] = useState('Camera is off');
  const [isDeviceCameraActive, setIsDeviceCameraActive] = useState(false);
  const [deviceCameraError, setDeviceCameraError] = useState('');
  const deviceCameraVideoRef = useRef(null);
  const deviceCameraStreamRef = useRef(null);
  const deviceCameraRequestRef = useRef(0);
  const [safetyNotice, setSafetyNotice] = useState('');
  const [blockSyncError, setBlockSyncError] = useState('');

  const t = UI_TEXT[lang];
  const sceneObjectsKey = session?.user?.username ? `edu-scene-objects:${session.user.username}` : 'edu-scene-objects';

  useEffect(() => {
    generatedCodeRef.current = generatedCode;
    codeByVersionRef.current[controllerVersion] = generatedCode;
  }, [generatedCode, controllerVersion]);
  const overlayTabs = [
    { id: 'blocks', label: 'Blocks' },
    { id: 'ide', label: 'IDE' },
    { id: 'planner', label: 'Path Planner' },
    { id: 'prompt', label: 'Prompt to Motion' },
    { id: 'camera', label: 'Vision to Motion' },
  ];

  const apiFetch = useCallback(async (url, options = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(options.headers || {}),
    };

    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const error = new Error(data.detail || data.message || 'Request failed');
      error.status = res.status;
      throw error;
    }
    return data;
  }, [session?.token]);

  const robotConnection = useMemo(
    () => createRobotConnection('sdk', { request: apiFetch }),
    [apiFetch],
  );
  const duetRobotConnection = useMemo(
    () => new DuetRobotConnection(apiFetch),
    [apiFetch],
  );
  const activeRobotConnection = controllerVersion === 'duet' ? duetRobotConnection : robotConnection;

  const refreshClassroomData = useCallback(async () => {
    if (!session?.token) return;
    try {
      const [codesRes, queueRes, usersRes, statusRes, projectsRes] = await Promise.all([
        apiFetch('/api/classroom/codes'),
        session.user.role === 'teacher' ? apiFetch('/api/classroom/queue') : Promise.resolve({ items: [] }),
        session.user.role === 'teacher' ? apiFetch('/api/classroom/users') : Promise.resolve({ users: [] }),
        apiFetch('/api/classroom/status'),
        apiFetch('/api/classroom/projects')
      ]);
      setSavedCodes(codesRes.codes || []);
      setQueueItems(queueRes.items || []);
      setTeacherRoster(usersRes.users || []);
      setClassroomStatus(statusRes.status || 'idle');
      setProjectLibrary(projectsRes.projects || []);
      return queueRes.items || [];
    } catch (err) {
      console.error('Failed to refresh classroom data:', err);
      return [];
    }
  }, [session, apiFetch]);

  useEffect(() => {
    if (!session?.token) return;
    apiFetch('/api/planner/settings')
      .then(({ active_mode: mode }) => {
        if (Object.prototype.hasOwnProperty.call(PLANNER_PATH_MODES, mode)) {
          setPathPlannerMode(mode);
        }
      })
      .catch((error) => {
        setNavigationExecutionStatus(`Could not load the teacher-selected planner mode • ${error.message}`);
      });
  }, [session?.token, apiFetch]);

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
      if (session.user.role === 'teacher') {
        robotConnection.status()
          .then((status) => {
            setIsRobotConnected(status.sdkAvailable);
            if (status.sdkAvailable) {
              const sensorText = `MID-360 distance conditions ${status.distanceSensor?.ready ? 'ready' : 'disabled'} • ${formatLidarDistanceStatus(status.distanceSensor)}`;
              setRobotConnectionStatus(`SDK connected on ${status.interface} • ${sensorText}`);
            } else {
              setRobotConnectionStatus('Disconnected • backend must run on the G1 computer • LiDAR status is available without SDK motion');
            }
          })
          .catch((error) => {
            setIsRobotConnected(false);
            setRobotConnectionStatus(`Robot status unavailable: ${error.message}`);
          });
      }
      apiFetch('/api/classroom/project?name=default')
        .then((response) => {
          if (response.project && Array.isArray(response.project.sceneObjects)) {
            setSceneObjects(response.project.sceneObjects);
          }
          if (response.project && Array.isArray(response.project.plannerWaypoints)) {
            setPlannerWaypoints(response.project.plannerWaypoints);
          }
          if (response.project && response.project.plannerMode
            && Object.prototype.hasOwnProperty.call(PLANNER_PATH_MODES, response.project.plannerMode)) {
            setPathPlannerMode(response.project.plannerMode);
            setPlannerProjectLabel(response.project.plannerLabel || response.project.name || '');
            setPlannerRouteVariants(response.project.plannerVariants || { initial: '', corrected: '', final: '' });
            setSelectedPlannerVariant(response.project.selectedPlannerVariant || 'final');
            setOriginalPlannerCode(response.project.plannerMode === PLANNER_PATH_MODES.sensor_corrected
              ? response.project.plannerVariants?.initial || ''
              : '');
          }
          if (response.project && typeof response.project.generatedCode === 'string') {
            codeByVersionRef.current.legacy = response.project.generatedCode;
          }
          if (response.project && typeof response.project.duetCode === 'string') {
            codeByVersionRef.current.duet = response.project.duetCode;
          }
          if (response.project) {
            const selectedCode = controllerVersionRef.current === 'duet'
              ? codeByVersionRef.current.duet
              : codeByVersionRef.current.legacy;
            if (controllerVersionRef.current === 'duet') {
              try {
                parseDuetProgram(selectedCode);
              } catch (error) {
                setBlockSyncError(`Saved DUET project code is invalid: ${error.message}`);
                return;
              }
            }
            compiledPlannerCodeRef.current = selectedCode;
            applyGeneratedCodeRef.current?.(selectedCode, { syncBlocks: true });
          }
        })
        .catch(() => {
          // fallback to local storage only if no backend project exists
        });
    } else {
      localStorage.removeItem('edu-classroom-session');
    }
  }, [session, refreshClassroomData, sceneObjectsKey, robotConnection, apiFetch]);

  useEffect(() => {
    if (controllerVersion !== 'duet' || !isDuetProgramActive) return undefined;
    let active = true;
    const refreshDuetExecutionStatus = async () => {
      if (!isDuetProgramActive) return;
      try {
        const status = await duetRobotConnection.status();
        if (!active) return;
        if (status.motionActive === false) {
          duetProgramActiveRef.current = false;
          setIsDuetProgramActive(false);
          setIsRunning(false);
          setIsRobotConnected(status.connected === true && status.ready === true);
          setRobotConnectionStatus(status.connected === true
            ? 'DUET program finished; controller remains connected.'
            : 'DUET program finished and controller is disconnected.');
        } else if (status.motionActive === true) {
          setRobotConnectionStatus('DUET program is active; stop remains available.');
        } else {
          setRobotConnectionStatus(`DUET execution state is unverified; keeping the run locked. ${status.error || ''}`.trim());
        }
      } catch (error) {
        if (active) {
          setRobotConnectionStatus(`DUET execution status unavailable; keeping the run locked. ${error.message}`);
        }
      }
    };
    refreshDuetExecutionStatus();
    const timer = window.setInterval(refreshDuetExecutionStatus, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [controllerVersion, duetRobotConnection, isDuetProgramActive]);

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
          generatedCode: attachPlannerProjectMeta(codeByVersionRef.current.legacy, {
            plannerMode: pathPlannerMode,
            plannerLabel: plannerProjectLabel,
            plannerVariants: plannerRouteVariants,
            selectedPlannerVariant,
          }),
          duetCode: codeByVersionRef.current.duet,
          plannerMode: pathPlannerMode,
          plannerLabel: plannerProjectLabel,
          plannerVariants: plannerRouteVariants,
          selectedPlannerVariant,
        }),
      }).catch(() => {
        // keep the local app responsive even if the backend sync is delayed
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [session, projectName, sceneObjects, plannerWaypoints, generatedCode, controllerVersion, pathPlannerMode, plannerProjectLabel, plannerRouteVariants, selectedPlannerVariant, apiFetch]);

  useEffect(() => {
    if (!session?.token) {
      setLidarScanJob(null);
      setLiveLidarScanPoints([]);
      setSharedLidarMap(null);
      setNavigationLiveStatus('Live updates disconnected');
      setNavigationDiagnostics(null);
      setIsNavigationMotionReady(false);
      setLiveNavigationObstacles(null);
      setLiveNavigationPose(null);
      setIsLiveAvoidanceReady(false);
      sharedMapVersionRef.current = null;
      sharedMapLoadedRef.current = false;
      liveNavigationMapVersionRef.current = null;
      navigationMapSnapshotRef.current = null;
      navigationWaypointFrameRef.current = null;
      setNavigationRoutePreview(null);
      setNavigationPreviewStatus('No route preview');
      return undefined;
    }

    let active = true;
    let socket = null;
    let reconnectTimer = null;
    let reconnectDelayMs = 1000;
    Promise.all([
      apiFetch('/api/lidar/settings'),
      apiFetch('/api/lidar/map'),
    ]).then(([settings, sharedMap]) => {
      if (!active) return;
      setSharedLidarOverlayEnabled(settings.show_shared_overlay === true);
      setSharedLidarMap(sharedMap.map ? sharedMap : null);
      sharedMapVersionRef.current = sharedMap.map?.map?.version || null;
      sharedMapLoadedRef.current = Boolean(sharedMap.map);
    }).catch((error) => {
      if (active) setNavigationLiveStatus(`Live map unavailable • ${error.message}`);
    });

    const handleLiveMessage = (event) => {
      if (!active) return;
      try {
        const update = JSON.parse(event.data);
        const scan = update.scan;
        if (scan) {
          setLidarScanJob(scan);
          setLiveLidarScanPoints(Array.isArray(scan.preview_points) ? scan.preview_points : []);
          setLidarScanStatus(
            scan.error
              ? `Scan ${scan.status} • ${scan.error}`
              : `Scan ${scan.status} • ${scan.point_count || 0} unique 3D points`,
          );
        }
        setSharedLidarOverlayEnabled(update.shared_overlay_enabled === true);
        setIsNavigationMotionReady(update.navigation?.motion_ready === true);
        setIsLiveAvoidanceReady(update.navigation?.live_avoidance_ready === true);
        setLiveNavigationObstacles(update.navigation?.live_obstacles || null);
        setLiveNavigationPose(update.navigation?.localization?.pose
          ? {
            ...update.navigation.localization.pose,
            frame_id: update.navigation.localization.frame_id,
          }
          : null);
        if (update.navigation?.diagnostics) {
          setNavigationDiagnostics(update.navigation.diagnostics);
        }
        setNavigationLiveStatus(
          update.navigation?.ready
            ? `Live • ${update.navigation.map?.map_id} ${update.navigation.map?.version} • ${update.navigation.localization?.age_ms ?? '—'} ms localization • MID-360 ${update.navigation.pointcloud_age_ms ?? '—'} ms old • ${update.navigation.motion_ready ? 'robot link and e-stop healthy' : [update.navigation.robot_health?.error, update.navigation.estop?.error].filter(Boolean).join(' • ') || 'robot/e-stop health unverified'}`
            : `Live • navigation unavailable${update.navigation?.error ? ` • ${update.navigation.error}` : ''}`,
        );
        const sharedVersion = update.shared_map_version || null;
        if (sharedVersion && sharedVersion !== sharedMapVersionRef.current) {
          sharedMapVersionRef.current = sharedVersion;
          if (session.user.role === 'teacher' || update.shared_overlay_enabled) {
            apiFetch('/api/lidar/map')
              .then((result) => {
                if (!active) return;
                setSharedLidarMap(result.map ? result : null);
                sharedMapLoadedRef.current = Boolean(result.map);
              })
              .catch((error) => {
                if (active) setNavigationLiveStatus(`Published map refresh failed • ${error.message}`);
              });
          }
        } else if (update.shared_overlay_enabled && !sharedMapLoadedRef.current) {
          apiFetch('/api/lidar/map')
            .then((result) => {
              if (!active) return;
              setSharedLidarMap(result.map ? result : null);
              sharedMapLoadedRef.current = Boolean(result.map);
              sharedMapVersionRef.current = result.map?.map?.version || null;
            })
            .catch((error) => {
              if (active) setNavigationLiveStatus(`Published map refresh failed • ${error.message}`);
            });
        }
        const liveMapVersion = update.navigation?.map?.version || null;
        if (
          session.user.role === 'teacher'
          && navigationPlannerModeRef.current === 'live'
          && liveNavigationMapVersionRef.current
          && liveMapVersion
          && liveMapVersion !== liveNavigationMapVersionRef.current
          && !navigationMapRefreshPendingRef.current
          && Date.now() - navigationMapRefreshStartedRef.current >= 1000
        ) {
          navigationMapRefreshPendingRef.current = true;
          navigationMapRefreshStartedRef.current = Date.now();
          apiFetch('/api/navigation/map')
            .then((result) => {
              if (!active) return;
              const previousSnapshot = navigationMapSnapshotRef.current;
              const waypointFrame = previousSnapshot?.map || navigationWaypointFrameRef.current;
              const sameFrame = waypointFrame?.map_id === result.map.map_id
                && waypointFrame?.frame_id === result.map.frame_id;
              if (!sameFrame) {
                navigationRouteWaypointsRef.current = [];
                setNavigationRouteWaypoints([]);
                setIsNavigationGoalPlacementEnabled(false);
              }
              navigationMapSnapshotRef.current = result;
              setNavigationMapSnapshot(result);
              liveNavigationMapVersionRef.current = result.map.version;
              setNavigationRoutePreview(null);
              setNavigationPreviewStatus('Map changed • preview the route again');
              setNavigationMapStatus(!sameFrame
                ? `Live map frame changed • destinations cleared • version ${result.map.version}`
                : `Live map updated • ${result.map.width} × ${result.map.height} cells • destinations stay fixed in map coordinates • version ${result.map.version}`);
            })
            .catch((error) => {
              if (active) setNavigationMapStatus(`Live map refresh failed • ${error.message}`);
            })
            .finally(() => {
              navigationMapRefreshPendingRef.current = false;
            });
        }
      } catch (error) {
        setNavigationLiveStatus(`Invalid live update • ${error.message}`);
      }
    };

    const connectLiveSocket = () => {
      if (!active) return;
      const socketScheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(
        `${socketScheme}//${window.location.host}/api/lidar/live`,
        [`edu-auth.${session.token}`],
      );
      socket.onopen = () => {
        reconnectDelayMs = 1000;
        if (active) setNavigationLiveStatus('Live LiDAR and navigation updates connected');
      };
      socket.onmessage = handleLiveMessage;
      socket.onerror = () => {
        if (active) setNavigationLiveStatus('Live updates unavailable • checking the authenticated backend connection');
      };
      socket.onclose = () => {
        if (!active) return;
        setNavigationLiveStatus('Live updates disconnected • reconnecting');
        reconnectTimer = window.setTimeout(connectLiveSocket, reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
      };
    };
    connectLiveSocket();

    return () => {
      active = false;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [session?.token, session?.user?.role, apiFetch]);

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

  const handleRegisterStudent = async (event) => {
    event.preventDefault();
    setLoginError('');
    try {
      const response = await apiFetch('/api/classroom/register', {
        method: 'POST',
        body: JSON.stringify({ username: loginForm.username, password: loginForm.password }),
      }, false);
      setSession({ token: response.token, user: response.user });
    } catch (err) {
      setLoginError(err.message);
    }
  };

  const handleLogout = () => {
    setSession(null);
    setSavedCodes([]);
    setQueueItems([]);
    setTeacherRoster([]);
    setClassroomStatus('idle');
  };

  const handleCreateStudent = async (event) => {
    event.preventDefault();
    setAccountManagementError('');
    setIsCreatingStudent(true);
    try {
      await apiFetch('/api/classroom/users', {
        method: 'POST',
        body: JSON.stringify(newStudent),
      });
      setNewStudent({ username: '', password: '', role: 'student' });
      await refreshClassroomData();
    } catch (error) {
      setAccountManagementError(error.message);
    } finally {
      setIsCreatingStudent(false);
    }
  };

  const handleDeleteUser = async (username) => {
    if (!window.confirm(
      `Delete ${username}? Their saved programs, projects, queue submissions, and account-owned operation records will be permanently removed.`,
    )) return;
    setAccountManagementError('');
    setDeletingUsername(username);
    try {
      await apiFetch(`/api/classroom/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      await refreshClassroomData();
    } catch (error) {
      setAccountManagementError(error.message);
    } finally {
      setDeletingUsername('');
    }
  };

  const handleSaveCodeToAccount = async () => {
    if (!session) return;
    const versionSuffix = controllerVersion === 'duet' ? '-duet' : '';
    const codeName = `${session.user.username}-program${versionSuffix}-${new Date().toISOString().slice(0, 10)}`;
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

  const buildProjectSnapshot = () => ({
    name: projectName,
    sceneObjects,
    plannerWaypoints,
    generatedCode: codeByVersionRef.current.legacy || '',
    duetCode: codeByVersionRef.current.duet || '',
    plannerMode: pathPlannerMode,
    plannerLabel: plannerProjectLabel,
    plannerVariants: plannerRouteVariants,
    selectedPlannerVariant,
  });

  const handleSubmitToQueue = async () => {
    if (!session) return;
    try {
      await apiFetch('/api/classroom/submit-code', {
        method: 'POST',
        body: JSON.stringify({
          name: `${session.user.username}-submission-${new Date().toLocaleTimeString()}`,
          code: generatedCode || '# No code generated yet',
          controller_version: controllerVersion,
          project_snapshot: buildProjectSnapshot(),
        })
      });
      await refreshClassroomData();
      alert('Submitted to the teacher for review. The queued code preview is visible before a teacher can run it.');
    } catch (e) {
      alert('Submission failed: ' + e.message);
    }
  };

  const handleSubmitPlannerRequest = async () => {
    if (!session) return;
    if (controllerVersion !== 'legacy') {
      setNavigationExecutionStatus('Path planner requests require the G1 SDK controller. DUET programs can still be submitted from Blocks or IDE.');
      return;
    }
    if (pathPlannerMode === PLANNER_PATH_MODES.autonomous) {
      if (!navigationMapSnapshot?.map || navigationRouteWaypoints.length < 1) {
        setNavigationExecutionStatus('Load a map and add at least one destination before sending an autonomous request to the teacher.');
        return;
      }
      if (navigationPlannerMode !== 'live') {
        setNavigationExecutionStatus('Autonomous obstacle-aware requests require the Live adaptive Nav2 planner mode.');
        return;
      }
    } else if (plannerWaypoints.length < 2 || !plannerRouteVariants.initial) {
      setNavigationExecutionStatus('Add at least two grid waypoints and compile the initial SDK path before requesting teacher review.');
      return;
    }
    const navigation = pathPlannerMode === PLANNER_PATH_MODES.autonomous
      ? {
        map_id: navigationMapSnapshot?.map?.map_id,
        version: navigationMapSnapshot?.map?.version,
        frame_id: navigationMapSnapshot?.map?.frame_id,
        planner_mode: navigationPlannerMode,
        waypoints: navigationRouteWaypoints.map(({ x, y }) => ({ x, y })),
      }
      : null;
    const plannerRequest = {
      planner_mode: pathPlannerMode,
      planner_label: PLANNER_MODE_LABELS[pathPlannerMode],
      planner_waypoints: plannerWaypoints.map(({ x, y }) => ({ x, y })),
      route_variants: plannerRouteVariants,
      selected_variant: selectedPlannerVariant,
      navigation,
    };
    try {
      await apiFetch('/api/classroom/submit-code', {
        method: 'POST',
        body: JSON.stringify({
          name: `${session.user.username}-${PLANNER_MODE_LABELS[pathPlannerMode]}-${new Date().toLocaleTimeString()}`,
          code: generatedCode || '',
          controller_version: controllerVersion,
          planner_request: plannerRequest,
          project_snapshot: buildProjectSnapshot(),
        }),
      });
      await refreshClassroomData();
      setNavigationExecutionStatus(
        'Planner request sent to the teacher with its mode, waypoints, map identity, route variants, and exact generated code preview.',
      );
    } catch (error) {
      setNavigationExecutionStatus(`Planner request was not submitted • ${error.message}`);
    }
  };

  const handleLoadQueueItemForReview = (item) => {
    setQueueReviewItem(item);
    setQueueReviewError('');
    setQueueReviewStatus('');
    setQueueReviewSavedProject(item.result_project || null);
    setQueueReviewNavigationPreview(null);
    setQueueReviewNavigationOperation(null);
  };

  const handlePreviewQueuedNavigation = async () => {
    const navigation = queueReviewItem?.planner_request?.navigation;
    if (!navigation) return;
    setIsQueueReviewPreviewing(true);
    setQueueReviewError('');
    try {
      const preview = await apiFetch('/api/navigation/plan', {
        method: 'POST',
        body: JSON.stringify(navigation),
      });
      setQueueReviewNavigationPreview(preview);
      setQueueReviewStatus(`Route preview ready • ${preview.path?.length || 0} path points • no motion sent`);
    } catch (error) {
      setQueueReviewNavigationPreview(null);
      setQueueReviewError(`Route preview unavailable • ${error.message}`);
    } finally {
      setIsQueueReviewPreviewing(false);
    }
  };

  const handleApproveQueuedExecution = async () => {
    if (!queueReviewItem || queueReviewItem.status !== 'queued') return;
    if (queueReviewItem.planner_request?.planner_mode === PLANNER_PATH_MODES.autonomous
      && !queueReviewNavigationPreview) {
      setQueueReviewError('Preview the autonomous route before approving movement.');
      return;
    }
    setIsQueueReviewRunning(true);
    setQueueReviewError('');
    setQueueReviewStatus('Teacher approved • starting the queued request…');
    try {
      const result = await apiFetch('/api/classroom/run-next', {
        method: 'POST',
        body: JSON.stringify({ item_id: queueReviewItem.id }),
      });
      setQueueReviewStatus(result.status === 'completed'
        ? result.process?.saved_project_error
          ? `Request completed, but its project could not be saved • ${result.process.saved_project_error}`
          : result.process?.saved_project
            ? `Request completed and saved as ${result.process.saved_project.name}. Physical movement is not independently verified.`
            : 'Request completed. Physical movement is not independently verified.'
        : result.status === 'paused'
          ? 'Request was stopped and paused.'
        : 'Request approved and running. Waiting for the controller terminal status.');
      if (result.item) setQueueReviewItem(result.item);
      const savedProject = result.saved_project || result.item?.result_project;
      if (savedProject) setQueueReviewSavedProject(savedProject);
      if (result.operation?.operation_id) setQueueReviewNavigationOperation(result.operation);
      const items = await refreshClassroomData();
      const refreshedItem = items.find((item) => item.id === queueReviewItem.id);
      setQueueReviewItem(refreshedItem || result.item || queueReviewItem);
      if (refreshedItem?.result_project) setQueueReviewSavedProject(refreshedItem.result_project);
    } catch (error) {
      setQueueReviewError(`Execution was not started • ${error.message}`);
      const items = await refreshClassroomData();
      const refreshedItem = items.find((item) => item.id === queueReviewItem.id);
      if (refreshedItem) setQueueReviewItem(refreshedItem);
    } finally {
      setIsQueueReviewRunning(false);
    }
  };

  const handleStopQueuedExecution = async () => {
    setQueueReviewError('');
    try {
      if (queueReviewNavigationOperation?.operation_id) {
        const operation = await apiFetch(
          `/api/navigation/operation/${queueReviewNavigationOperation.operation_id}/stop`,
          { method: 'POST' },
        );
        setQueueReviewNavigationOperation(operation);
        setQueueReviewStatus('Nav2 stop requested. Waiting for its terminal status.');
      } else if (queueReviewItem?.controller_version === 'duet') {
        const result = await apiFetch('/api/duet/stop', { method: 'POST' });
        setQueueReviewStatus(`DUET stop ${result.status || 'requested'}. Waiting for the queue result.`);
      } else {
        await apiFetch('/api/classroom/stop-current', { method: 'POST' });
        setQueueReviewStatus('G1 SDK stop requested. Waiting for the queue result.');
      }
      await refreshClassroomData();
    } catch (error) {
      setQueueReviewError(`Stop request failed • ${error.message}`);
    }
  };

  const handleRunNext = async () => {
    const nextItem = queueItems.find((item) => item.status === 'queued');
    if (!nextItem) {
      alert('There are no queued requests to approve.');
      return;
    }
    handleLoadQueueItemForReview(nextItem);
  };

  const handleStopCurrent = async () => {
    try {
      await apiFetch('/api/classroom/stop-current', { method: 'POST' });
      await refreshClassroomData();
      alert('Locomotion stop requested and queue paused. An active arm preset may continue until its motion ends.');
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

  const handleRenameProject = async (project) => {
    const newName = window.prompt('Rename project', project.name)?.trim();
    if (!newName || newName === project.name) return;
    try {
      await apiFetch('/api/classroom/project/rename', {
        method: 'POST',
        body: JSON.stringify({ owner: project.username, name: project.name, new_name: newName }),
      });
      if (project.username === currentUser.username && projectName === project.name) {
        setProjectName(newName);
        setPlannerProjectLabel(newName);
      }
      await refreshClassroomData();
    } catch (error) {
      alert(`Could not rename project: ${error.message}`);
    }
  };

  const handleDeleteProject = async (project) => {
    if (!window.confirm(`Delete ${project.name} from ${project.username}'s project library?`)) return;
    try {
      await apiFetch('/api/classroom/project/delete', {
        method: 'POST',
        body: JSON.stringify({ owner: project.username, name: project.name }),
      });
      if (project.username === currentUser.username && projectName === project.name) {
        setProjectName('default');
      }
      await refreshClassroomData();
    } catch (error) {
      alert(`Could not delete project: ${error.message}`);
    }
  };

  const handleClearQueue = async () => {
    if (!window.confirm('Clear all waiting and finished queue items? A currently running job will be kept.')) return;
    try {
      const result = await apiFetch('/api/classroom/clear-queue', { method: 'POST' });
      setQueueItems(result.remaining || []);
      alert(`Cleared ${result.deleted} queue item${result.deleted === 1 ? '' : 's'}.`);
    } catch (e) {
      alert('Clear queue failed: ' + e.message);
    }
  };

  const handleConnectRobot = async () => {
    if (!session || session.user.role !== 'teacher') {
      alert('Teacher login is required to connect the robot.');
      return;
    }
    if (controllerVersion === 'duet' && isRobotConnected && isDuetProgramActive) {
      alert('Stop the active DUET program and wait for confirmed completion before disconnecting.');
      return;
    }

    setIsRobotConnecting(true);
    setRobotConnectionStatus(controllerVersion === 'duet'
      ? 'Connecting to the DUET G1 23-DOF controller gateway...'
      : 'Connecting through the G1 host network interface...');
    try {
      if (controllerVersion === 'duet' && isRobotConnected) {
        const disconnected = await duetRobotConnection.disconnect();
        setIsRobotConnected(false);
        duetProgramActiveRef.current = false;
        setIsDuetProgramActive(false);
        setIsRunning(false);
        setRobotConnectionStatus(disconnected.status === 'released'
          ? 'DUET lease released; arm pose cleared; joystick input may resume. Stop the DUET process before using legacy SDK.'
          : 'DUET control lease release was not confirmed.');
        return;
      }
      const connection = await activeRobotConnection.connect();
      if (connection.status !== 'connected' || (controllerVersion === 'duet' && connection.ready !== true)) {
        throw new Error('Backend did not confirm a connected robot.');
      }
      setIsRobotConnected(true);
      if (controllerVersion === 'duet') {
        duetProgramActiveRef.current = connection.motionActive === true;
        setIsDuetProgramActive(duetProgramActiveRef.current);
        setIsRunning(duetProgramActiveRef.current);
        const armCapability = connection.capabilities?.includes('arm_pose')
          ? 'arm-pose gateway enabled'
          : 'arm-pose blocks are preview-only (controller acceptance gate disabled)';
        setRobotConnectionStatus(`Connected • DUET ${connection.policyId} • ${connection.robotModel} • sole lowcmd owner confirmed • ${armCapability}`);
      } else {
        const sensorText = `MID-360 distance conditions ${connection.distanceSensor?.ready ? 'ready' : 'disabled'} • ${formatLidarDistanceStatus(connection.distanceSensor)}`;
        setRobotConnectionStatus(`Connected • SDK on ${connection.interface}, domain ${connection.domain} • ${sensorText}${connection.logFile ? ` • session log: ${connection.logFile}` : ''}`);
      }
    } catch (error) {
      setIsRobotConnected(false);
      setRobotConnectionStatus(`${controllerVersion === 'duet' ? 'DUET connection' : 'Connection'} failed: ${error.message}`);
      alert(`Robot connection failed: ${error.message}`);
    } finally {
      setIsRobotConnecting(false);
    }
  };

  const handleTestRobotMotion = async () => {
    if (!isRobotConnected) {
      alert(`Connect the ${controllerVersion === 'duet' ? 'DUET controller' : 'G1 SDK'} before testing motion.`);
      return;
    }
    const testDescription = controllerVersion === 'duet'
      ? 'Teacher approval required. Exact command: duet.move(0.1, 0, 0, 0.5). Only continue if the G1 is upright and stable, the area is clear, and someone is ready at the emergency stop. The app cannot verify physical movement.'
      : 'Teacher approval required. Exact command: robot.slowwalktime(0.5). Only continue if the G1 is upright and stable, the area is clear, and someone is ready at the emergency stop. The app cannot verify physical movement.';
    if (!window.confirm(testDescription)) return;

    setIsRunning(true);
    setRobotConnectionStatus(controllerVersion === 'duet'
      ? 'Sending a brief DUET motion test...'
      : 'Sending a brief slow-motion test...');
    let keepDuetRunLock = false;
    try {
      const result = await activeRobotConnection.run(controllerVersion === 'duet'
        ? 'duet.move(0.1, 0, 0, 0.5)'
        : 'robot.slowwalktime(0.5)');
      const adapter = controllerVersion === 'duet' ? 'DUET' : 'SDK';
      if (controllerVersion === 'duet' && result.status === 'accepted') {
        duetProgramActiveRef.current = true;
        setIsDuetProgramActive(true);
        keepDuetRunLock = true;
        setRobotConnectionStatus('DUET accepted the motion test; waiting for controller completion. Physical movement is not verified.');
      } else {
        if (controllerVersion === 'duet') {
          duetProgramActiveRef.current = false;
          setIsDuetProgramActive(false);
        }
        setRobotConnectionStatus(`${adapter} accepted the motion test (${result.commandsExecuted} command). Physical movement is not verified.`);
      }
    } catch (error) {
      setRobotConnectionStatus(`${controllerVersion === 'duet' ? 'DUET motion' : 'Motion'} test failed: ${error.message}`);
      alert(`Motion test failed: ${error.message}`);
    } finally {
      if (!keepDuetRunLock) setIsRunning(false);
    }
  };

  const handleTestLidar = async () => {
    if (!session || session.user.role !== 'teacher') {
      alert('Teacher login is required to test the LiDAR connection.');
      return;
    }
    setIsLidarTesting(true);
    setLidarTestStatus('Reading a fresh MID-360 sample…');
    try {
      const status = await robotConnection.status();
      const sensor = status.distanceSensor;
      if (sensor?.ready) {
        const sampleTime = sensor.timestamp ? ` • ${new Date(sensor.timestamp).toLocaleTimeString()}` : '';
        setLidarTestStatus(`${formatLidarDistanceStatus(sensor)} • ${sensor.frame_id} base frame • ${sensor.sensor_frame_id} sensor frame${sampleTime}`);
      } else {
        const rear = sensor?.rear?.ready
          ? sensor.rear.clear
            ? `Rear distance conditions ready; no returns within ${sensor.rear.max_range_m} m`
            : `Rear footprint clearance • ${sensor.rear.distance_m.toFixed(2)} m`
          : `Rear distance conditions disabled • ${sensor?.rear?.error || 'provider status not reported'}`;
        setLidarTestStatus(`Front distance conditions disabled • ${sensor?.error || 'Backend did not report LiDAR status.'} • ${rear}`);
      }
    } catch (error) {
      setLidarTestStatus(`Test failed • ${error.message}`);
    } finally {
      setIsLidarTesting(false);
    }
  };

  const stopDeviceCamera = useCallback(() => {
    deviceCameraRequestRef.current += 1;
    deviceCameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    deviceCameraStreamRef.current = null;
    if (deviceCameraVideoRef.current) {
      deviceCameraVideoRef.current.srcObject = null;
    }
    setIsDeviceCameraActive(false);
    setDeviceCameraStatus('Camera is off');
  }, []);

  useEffect(() => {
    if (mainTab !== 'camera' || cameraInputSource !== 'device') {
      stopDeviceCamera();
    }
    return () => stopDeviceCamera();
  }, [mainTab, cameraInputSource, stopDeviceCamera]);

  const startDeviceCamera = async () => {
    setDeviceCameraError('');
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      setDeviceCameraError('Safari requires a trusted HTTPS connection before it can open this device camera.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setDeviceCameraError('This browser does not provide camera access. Check Safari permissions and secure-context support.');
      return;
    }
    stopDeviceCamera();
    const requestId = deviceCameraRequestRef.current;
    setDeviceCameraStatus('Requesting camera permission…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'user' } },
      });
      if (
        requestId !== deviceCameraRequestRef.current
        || mainTab !== 'camera'
        || cameraInputSource !== 'device'
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      deviceCameraStreamRef.current = stream;
      if (deviceCameraVideoRef.current) {
        deviceCameraVideoRef.current.srcObject = stream;
        await deviceCameraVideoRef.current.play();
      }
      setIsDeviceCameraActive(true);
      setDeviceCameraStatus('Live preview active; frames are not recorded or uploaded.');
    } catch (error) {
      if (requestId !== deviceCameraRequestRef.current) return;
      stopDeviceCamera();
      setDeviceCameraError(`Could not open this device camera: ${error.message}`);
    }
  };

  const handleDiscoverSensors = async () => {
    if (currentUser.role !== 'teacher') return;
    setIsSensorDiscovering(true);
    setSensorOperationStatus('Checking available sensors…');
    try {
      const diagnostics = await apiFetch('/api/sensors/discover', { method: 'POST' });
      setSensorDiagnostics(diagnostics);
      setSensorOperationStatus('Discovery finished. Each sensor is reported independently.');
    } catch (error) {
      setSensorOperationStatus(`Discovery failed: ${error.message}`);
    } finally {
      setIsSensorDiscovering(false);
    }
  };

  const handleControllerVersionChange = async (useDuetVersion) => {
    const nextVersion = useDuetVersion ? 'duet' : 'legacy';
    if (nextVersion === controllerVersion) return;
    if (isRunning || isRobotConnecting || isDuetProgramActive) {
      alert('Wait for the current robot operation or connection attempt to finish before switching versions.');
      return;
    }
    let duetOwnershipUnverified = false;
    if (
      controllerVersion === 'duet'
      && nextVersion === 'legacy'
      && (isRobotConnected || isDuetProgramActive)
    ) {
      setIsRobotConnecting(true);
      try {
        let status = await duetRobotConnection.status();
        if (status.connected === true || status.motionOwner === 'duet') {
          const disconnected = await duetRobotConnection.disconnect();
          if (disconnected.status !== 'disconnected' || disconnected.lowcmd_owner !== 'none') {
            throw new Error('DUET did not confirm release of rt/lowcmd ownership.');
          }
          status = await duetRobotConnection.status();
        }
        if (status.connected === true || status.ready === true || status.motionOwner !== 'none') {
          throw new Error(status.error || 'DUET motion ownership is not confirmed released.');
        }
      } catch (error) {
        if (error.status === 401) {
          duetOwnershipUnverified = true;
        } else {
          setRobotConnectionStatus(`Cannot switch to legacy mode: ${error.message}`);
          alert(`Cannot switch to legacy mode: ${error.message}`);
          return;
        }
      } finally {
        setIsRobotConnecting(false);
      }
    }

    codeByVersionRef.current[controllerVersion] = generatedCodeRef.current;
    const nextCode = codeByVersionRef.current[nextVersion] || '';
    if (nextVersion === 'duet' && nextCode.trim()) {
      try {
        parseDuetProgram(nextCode);
      } catch (error) {
        alert(`Saved DUET code is invalid and was not loaded: ${error.message}`);
        return;
      }
    }
    const nextConnection = nextVersion === 'duet' ? duetRobotConnection : robotConnection;
    controllerVersionRef.current = nextVersion;
    duetProgramActiveRef.current = false;
    setIsDuetProgramActive(false);
    setControllerVersion(nextVersion);
    generatedCodeRef.current = nextCode;
    setGeneratedCode(nextCode);
    setBlockSyncError('');
    setSafetyNotice('');
    setIsRobotConnected(false);

    if (duetOwnershipUnverified) {
      setRobotConnectionStatus(
        'Legacy preview selected • DUET ownership could not be checked because the session expired. Sign in again before robot connection or motion; the backend ownership interlock remains active.',
      );
      return;
    }

    if (!session || session.user.role !== 'teacher') {
      setRobotConnectionStatus(nextVersion === 'duet'
        ? 'DUET preview selected • teacher login required for physical connection.'
        : 'Legacy version selected.');
      return;
    }

    setIsRobotConnecting(true);
    try {
      const status = await nextConnection.status();
      const connected = nextVersion === 'duet'
        ? status.connected === true && status.ready === true && status.motionOwner === 'duet'
        : status.sdkAvailable === true;
      if (nextVersion === 'duet') {
        const motionActive = status.motionActive === true;
        duetProgramActiveRef.current = motionActive;
        setIsDuetProgramActive(motionActive);
        setIsRunning(motionActive);
      }
      setIsRobotConnected(connected);
      setRobotConnectionStatus(nextVersion === 'duet'
        ? connected
          ? `Connected • DUET ${status.policyId} • ${status.robotModel} • sole lowcmd owner confirmed • ${status.capabilities?.includes('arm_pose') ? 'arm-pose gateway enabled' : 'arm-pose blocks are preview-only'}`
          : `DUET not connected • ${status.error || 'connect the DUET controller before physical execution'}`
        : connected
          ? `SDK connected on ${status.interface}`
          : 'Disconnected • connect the G1 SDK before physical execution');
    } catch (error) {
      setRobotConnectionStatus(error.status === 401
        ? `${nextVersion === 'duet' ? 'DUET' : 'Legacy'} preview selected • session expired. Sign in again before checking robot status or sending physical commands.`
        : `${nextVersion === 'duet' ? 'DUET' : 'SDK'} status unavailable: ${error.message}`);
    } finally {
      setIsRobotConnecting(false);
    }
  };

  const handleSensorServiceOperation = async (sensorId, operation) => {
    if (currentUser.role !== 'teacher') return;
    const operationKey = `${sensorId}:${operation}`;
    setSensorOperationBusy(operationKey);
    setSensorOperationStatus(`${operation} requested for ${sensorId}…`);
    try {
      await apiFetch('/api/sensors/service', {
        method: 'POST',
        body: JSON.stringify({ sensor_id: sensorId, operation }),
      });
      setSensorOperationStatus(`${operation} completed for ${sensorId}.`);
      try {
        const diagnostics = await apiFetch('/api/sensors/status', { cache: 'no-store' });
        setSensorDiagnostics(diagnostics);
      } catch (error) {
        setSensorOperationStatus(
          `${operation} completed for ${sensorId}, but diagnostics could not be refreshed: ${error.message}`,
        );
      }
    } catch (error) {
      setSensorOperationStatus(`${operation} failed for ${sensorId}: ${error.message}`);
    } finally {
      setSensorOperationBusy('');
    }
  };

  const handleCheckNavigationBridge = async () => {
    if (!session || session.user.role !== 'teacher') {
      setNavigationBridgeStatus('Teacher login is required to check the navigation bridge.');
      return;
    }
    setIsNavigationBridgeChecking(true);
    setIsNavigationMotionReady(false);
    setNavigationDiagnostics(null);
    setNavigationBridgeStatus('Checking bridge, fresh MID-360 data, localization, map metadata, and e-stop health…');
    try {
      const result = await apiFetch('/api/navigation/status');
      setIsNavigationMotionReady(result.motionReady === true);
      setNavigationDiagnostics(result.diagnostics || null);
      if (result.activeOperation) {
        setNavigationOperation(result.activeOperation);
        setNavigationExecutionStatus(
          `Recovered navigation operation ${result.activeOperation.operation_id} • ${result.activeOperation.status}`,
        );
      } else {
        setNavigationOperation(null);
      }
      if (!result.ready) {
        setNavigationBridgeStatus(`Unavailable • ${result.error || 'Bridge is not ready.'}`);
        return;
      }
      const { map, localization } = result;
      setNavigationBridgeStatus(
        `Ready • map ${map.map_id} • version ${map.version} • ${map.frame_id} • `
        + `pose ${localization.pose.x.toFixed(2)}, ${localization.pose.y.toFixed(2)} m `
        + `(${localization.age_ms} ms old) • MID-360 ${result.pointcloudAgeMs} ms old • `
        + (result.motionReady
          ? `robot link and e-stop healthy (${result.robotHealth.age_ms}/${result.estop.age_ms} ms old)`
          : [result.robotHealth?.error, result.estop?.error].filter(Boolean).join(' • ') || 'robot/e-stop health unverified; motion locked'),
      );
    } catch (error) {
      setIsNavigationMotionReady(false);
      setNavigationBridgeStatus(`Check failed • ${error.message}`);
    } finally {
      setIsNavigationBridgeChecking(false);
    }
  };

  const handleLoadNavigationMap = async () => {
    if (!session) {
      setNavigationMapStatus('Sign in to load the map preview.');
      return;
    }
    setIsNavigationMapLoading(true);
    setNavigationMapStatus(
      navigationPlannerMode === 'static'
        ? 'Loading the published 360° scan map…'
        : 'Loading the live SLAM occupancy map…',
    );
    try {
      let result;
      if (navigationPlannerMode === 'static') {
        const published = await apiFetch('/api/lidar/map');
        result = published.map;
        if (!result?.ready || !result.map || !Array.isArray(result.data)) {
          throw new Error('No validated 360° scan map has been published for planning.');
        }
      } else {
        result = await apiFetch('/api/navigation/map');
      }
      const previous = navigationMapSnapshotRef.current?.map || navigationWaypointFrameRef.current;
      const sameFrame = previous?.map_id === result.map.map_id
        && previous?.frame_id === result.map.frame_id;
      if (
        navigationMapSnapshotRef.current?.map?.version !== result.map.version
        || navigationMapSnapshotRef.current?.map?.frame_id !== result.map.frame_id
      ) {
        setNavigationRoutePreview(null);
        setNavigationPreviewStatus('Map changed • preview the route again');
      }
      if (!sameFrame && previous) {
        navigationRouteWaypointsRef.current = [];
        setNavigationRouteWaypoints([]);
        setIsNavigationGoalPlacementEnabled(false);
      }
      navigationMapSnapshotRef.current = result;
      navigationWaypointFrameRef.current = {
        map_id: result.map.map_id,
        frame_id: result.map.frame_id,
      };
      setNavigationMapSnapshot(result);
      liveNavigationMapVersionRef.current = result.map.version;
      setIsNavigationMapVisible(true);
      setNavigationMapStatus(
        `${navigationPlannerMode === 'static' ? 'Static scan map loaded' : 'Live SLAM map loaded'} • `
        + `${result.map.width} × ${result.map.height} cells • map ${result.map.map_id} • version ${result.map.version}`
        + (navigationRouteWaypointsRef.current.length
          ? ' • existing waypoints remain fixed in map coordinates'
          : ''),
      );
    } catch (error) {
      navigationMapSnapshotRef.current = null;
      liveNavigationMapVersionRef.current = null;
      setNavigationMapSnapshot(null);
      setIsNavigationMapVisible(false);
      setNavigationMapStatus(`Unavailable • ${error.message}`);
    } finally {
      setIsNavigationMapLoading(false);
    }
  };

  const handleNavigationPlannerModeChange = (mode) => {
    if (mode === navigationPlannerMode) return;
    setNavigationPlannerMode(mode);
    setNavigationRoutePreview(null);
    setNavigationPreviewStatus('Planner mode changed • load the selected map and preview again');
    navigationMapSnapshotRef.current = null;
    liveNavigationMapVersionRef.current = null;
    setNavigationMapSnapshot(null);
    setIsNavigationMapVisible(false);
    setNavigationMapStatus(
      mode === 'static'
        ? 'Load the published 360° scan map to place waypoints.'
        : 'Load the live SLAM map; adaptive mode needs commissioned Nav2 obstacle avoidance.',
    );
  };

  const handlePathPlannerModeChange = async (mode) => {
    if (!Object.prototype.hasOwnProperty.call(PLANNER_PATH_MODES, mode)) return;
    if (session?.user?.role !== 'teacher') {
      setNavigationExecutionStatus('Only a teacher can change the classroom path planner mode.');
      return;
    }
    setPathPlannerMode(mode);
    setPlannerRouteVariants({ initial: '', corrected: '', final: '' });
    setSelectedPlannerVariant('initial');
    if (mode === PLANNER_PATH_MODES.autonomous) {
      setNavigationPlannerMode('live');
    }
    try {
      await apiFetch('/api/planner/settings', {
        method: 'PUT',
        body: JSON.stringify({ active_mode: mode }),
      });
    } catch (error) {
      setNavigationExecutionStatus(`Planner mode was not saved for the classroom • ${error.message}`);
    }
  };

  const handleStartLidarScan = async () => {
    if (session?.user?.role !== 'teacher') return;
    if (!isNavigationMotionReady) {
      setLidarScanStatus(
        `Scan blocked • ${navigationDiagnostics?.execution_enabled === false
          ? 'physical motion is disabled by deployment configuration.'
          : navigationDiagnostics?.controller?.error || 'verify fresh healthy robot-link and e-stop signals first.'}`,
      );
      return;
    }
    const confirmed = window.confirm(
      'The G1 will rotate in place through 360° while the LiDAR captures the room. Continue only after confirming the robot is stable, the rotation area is clear, a teacher is supervising, and the independent emergency stop is immediately available.',
    );
    if (!confirmed) return;
    setIsLidarScanStarting(true);
    setLidarScanStatus('Checking localization, LiDAR, map, and Nav2 Spin readiness…');
    try {
      const scan = await apiFetch('/api/lidar/scan', {
        method: 'POST',
        body: JSON.stringify({ confirm_rotation: true }),
      });
      setLidarScanJob(scan);
      setLiveLidarScanPoints([]);
      setLidarScanStatus('G1 is rotating in place • capturing LiDAR in the SLAM map frame');
    } catch (error) {
      setLidarScanStatus(`Scan could not start • ${error.message}`);
    } finally {
      setIsLidarScanStarting(false);
    }
  };

  const handleCompleteLidarScan = async () => {
    if (!lidarScanJob?.job_id || session?.user?.role !== 'teacher') return;
    setIsLidarScanFinalizing(true);
    setLidarScanStatus('Validating 3D point cloud and metric occupancy grid…');
    try {
      const result = await apiFetch(`/api/lidar/scan/${lidarScanJob.job_id}/complete`, {
        method: 'POST',
      });
      setLidarScanJob(result);
      setLidarScanStatus(
        `360° scan complete • ${result.point_count} 3D points • ${result.map.width} × ${result.map.height} cells at ${result.map.resolution_m} m/cell`,
      );
    } catch (error) {
      setLidarScanStatus(`Scan finalization failed • ${error.message}`);
    } finally {
      setIsLidarScanFinalizing(false);
    }
  };

  const handleCancelLidarScan = async () => {
    if (!lidarScanJob?.job_id || session?.user?.role !== 'teacher') return;
    setIsLidarScanFinalizing(true);
    try {
      const result = await apiFetch(`/api/lidar/scan/${lidarScanJob.job_id}/cancel`, {
        method: 'POST',
      });
      setLidarScanJob(result);
      setLiveLidarScanPoints([]);
      setLidarScanStatus(result.status === 'scanning'
        ? 'Nav2 rotation cancellation requested • waiting for confirmed stop'
        : 'Room scan canceled • no map was published');
    } catch (error) {
      setLidarScanStatus(`Scan cancellation failed • ${error.message}`);
    } finally {
      setIsLidarScanFinalizing(false);
    }
  };

  const handlePublishLidarMap = async () => {
    if (!lidarScanJob?.job_id || session?.user?.role !== 'teacher') return;
    try {
      const result = await apiFetch('/api/lidar/map/publish', {
        method: 'POST',
        body: JSON.stringify({ job_id: lidarScanJob.job_id }),
      });
      const sharedMap = await apiFetch('/api/lidar/map');
      setSharedLidarMap(sharedMap);
      sharedMapVersionRef.current = result.map.version;
      sharedMapLoadedRef.current = Boolean(sharedMap.map);
      setLidarScanStatus(
        `Published shared room map • ${result.map.width * result.map.resolution_m} m × ${result.map.height * result.map.resolution_m} m`,
      );
    } catch (error) {
      setLidarScanStatus(`Map publication failed • ${error.message}`);
    }
  };

  const handleRefreshSharedLidarMap = async () => {
    setIsSharedLidarMapLoading(true);
    try {
      const result = await apiFetch('/api/lidar/map');
      setSharedLidarMap(result.map ? result : null);
      sharedMapVersionRef.current = result.map?.map?.version || null;
      sharedMapLoadedRef.current = Boolean(result.map);
    } catch (error) {
      setNavigationLiveStatus(`Shared map unavailable • ${error.message}`);
    } finally {
      setIsSharedLidarMapLoading(false);
    }
  };

  const handleSharedLidarOverlayToggle = async (enabled) => {
    if (session?.user?.role !== 'teacher') return;
    const previousValue = sharedLidarOverlayEnabled;
    setSharedLidarOverlayEnabled(enabled);
    try {
      const result = await apiFetch('/api/lidar/settings', {
        method: 'PUT',
        body: JSON.stringify({ show_shared_overlay: enabled }),
      });
      setSharedLidarOverlayEnabled(result.show_shared_overlay);
    } catch (error) {
      setSharedLidarOverlayEnabled(previousValue);
      setNavigationLiveStatus(`Shared overlay setting was not saved • ${error.message}`);
    }
  };

  useEffect(() => {
    const jobId = lidarScanJob?.job_id;
    if (!jobId || lidarScanJob.status !== 'scanning' || session?.user?.role !== 'teacher') return undefined;
    let active = true;
    let requestInFlight = false;
    const pollScan = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const result = await apiFetch(`/api/lidar/scan/${jobId}`);
        if (!active) return;
        setLidarScanJob(result);
        setLiveLidarScanPoints(Array.isArray(result.preview_points) ? result.preview_points : []);
        const rotationStatus = result.rotation_status === 'completed'
          ? `360° rotation confirmed (${result.rotation_radians.toFixed(2)} rad) • ready to validate`
          : result.rotation_status === 'cancel_requested' || result.rotation_status === 'uncertain'
            ? `Rotation stopping • ${result.error || 'waiting for Nav2 terminal confirmation'}`
            : `G1 rotating in place • ${result.rotation_radians.toFixed(2)} rad captured`;
        setLidarScanStatus(
          `${result.rotation_status === 'submitted'
            ? 'Waiting for Nav2 to accept the in-place rotation'
            : rotationStatus} • ${result.point_count || 0} unique 3D points${result.error ? ` • ${result.error}` : ''}`,
        );
      } catch (error) {
        if (active) setLidarScanStatus(`Scan status unavailable • ${error.message}`);
      } finally {
        requestInFlight = false;
      }
    };
    pollScan();
    const timer = window.setInterval(pollScan, 100);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [lidarScanJob?.job_id, lidarScanJob?.status, session?.user?.role, apiFetch]);


  const handleNavigationMapClick = (event) => {
    if (!isNavigationGoalPlacementEnabled || !navigationMapSnapshot?.map) return;
    const mapGroup = navigationMapCoordinatesRef.current;
    if (!mapGroup) return;
    const screenPoint = mapGroup.ownerSVGElement.createSVGPoint();
    screenPoint.x = event.clientX;
    screenPoint.y = event.clientY;
    const localPoint = screenPoint.matrixTransform(mapGroup.getScreenCTM().inverse());
    const { map } = navigationMapSnapshot;
    const mapWidth = map.width * map.resolution_m;
    const mapHeight = map.height * map.resolution_m;
    if (localPoint.x < 0 || localPoint.y < 0 || localPoint.x >= mapWidth || localPoint.y >= mapHeight) return;
    const mapLocalY = localPoint.y;
    const occupancy = occupancyAtMapLocalPoint(
      localPoint.x, mapLocalY, map, navigationMapSnapshot.data,
    );
    if (!Number.isInteger(occupancy) || occupancy < 0 || occupancy >= 65) {
      setNavigationExecutionStatus('Destination rejected • choose a known free map cell.');
      return;
    }
    const { x, y } = mapLocalToWorld(localPoint.x, mapLocalY, map);
    navigationWaypointFrameRef.current = {
      map_id: map.map_id,
      frame_id: map.frame_id,
    };
    setNavigationRouteWaypoints((points) => [
      ...points,
      { id: `nav-${Date.now()}-${points.length}`, x, y },
    ]);
    setNavigationRoutePreview(null);
    setNavigationPreviewStatus('Destinations changed • preview the route again');
    setNavigationExecutionStatus('Destination added • route will be checked against the current map before start.');
  };

  const handlePreviewNavigationRoute = async () => {
    if (!session) {
      setNavigationPreviewStatus('Sign in to preview a route.');
      return;
    }
    if (!navigationMapSnapshot?.map || navigationRouteWaypoints.length < 1) {
      setNavigationPreviewStatus('Load the map and add at least one destination before previewing.');
      return;
    }
    if (navigationPlannerMode === 'live' && !isLiveAvoidanceReady) {
      setNavigationPreviewStatus(
        `Live adaptive preview unavailable • ${liveNavigationObstacles?.error || 'Nav2 local obstacle avoidance is not commissioned.'}`,
      );
      return;
    }
    setIsNavigationPreviewing(true);
    setNavigationRoutePreview(null);
    setNavigationPreviewStatus('Requesting a non-motion path preview from Nav2…');
    try {
      const result = await apiFetch('/api/navigation/plan', {
        method: 'POST',
        body: JSON.stringify({
          map_id: navigationMapSnapshot.map.map_id,
          version: navigationMapSnapshot.map.version,
          frame_id: navigationMapSnapshot.map.frame_id,
          planner_mode: navigationPlannerMode,
          waypoints: navigationRouteWaypoints.map(({ x, y }) => ({ x, y })),
        }),
      });
      if (
        result.map_id !== navigationMapSnapshot.map.map_id
        || result.version !== navigationMapSnapshot.map.version
        || result.frame_id !== navigationMapSnapshot.map.frame_id
      ) {
        throw new Error('The map changed while Nav2 was planning. Reload it and preview again.');
      }
      setNavigationRoutePreview(result);
      setNavigationPreviewStatus(
        `Preview ready • ${result.path.length} path points • ${result.planner_id} • no motion sent`,
      );
    } catch (error) {
      setNavigationPreviewStatus(`Route preview unavailable • ${error.message}`);
    } finally {
      setIsNavigationPreviewing(false);
    }
  };

  const handleStartNavigation = async () => {
    if (!session || session.user.role !== 'teacher') {
      setNavigationExecutionStatus('Teacher login is required to start navigation.');
      return;
    }
    if (!isNavigationMotionReady) {
      setNavigationExecutionStatus(
        `Physical start blocked • ${navigationDiagnostics?.execution_enabled === false
          ? 'physical motion is disabled by deployment configuration.'
          : navigationDiagnostics?.controller?.error || 'verify a fresh healthy e-stop and robot-link signal first.'}`,
      );
      return;
    }
    if (navigationPlannerMode === 'live' && !isLiveAvoidanceReady) {
      setNavigationExecutionStatus(
        `Physical start blocked • ${liveNavigationObstacles?.error || 'Nav2 local obstacle avoidance is not commissioned.'}`,
      );
      return;
    }
    if (pathPlannerMode === PLANNER_PATH_MODES.autonomous && navigationPlannerMode !== 'live') {
      setNavigationExecutionStatus('Autonomous path mode requires Live adaptive Nav2 with commissioned obstacle avoidance.');
      return;
    }
    if (!navigationMapSnapshot?.map || navigationRouteWaypoints.length < 1) {
      setNavigationExecutionStatus('Load the map and add at least one destination before starting.');
      return;
    }
    if (
      !navigationRoutePreview
      || navigationRoutePreview.map_id !== navigationMapSnapshot.map.map_id
      || navigationRoutePreview.version !== navigationMapSnapshot.map.version
      || navigationRoutePreview.frame_id !== navigationMapSnapshot.map.frame_id
    ) {
      setNavigationExecutionStatus('Preview the current route on the latest map before starting Nav2.');
      return;
    }
    if (navigationOperation && ['accepted', 'starting', 'running', 'cancel_requested'].includes(navigationOperation.status)) {
      setNavigationExecutionStatus('A navigation operation is already active.');
      return;
    }
    const plannedPoints = (navigationRoutePreview.path || [])
      .map((point, index) => `${index + 1}. (${Number(point.x).toFixed(2)}, ${Number(point.y).toFixed(2)})`)
      .join('\n');
    if (!window.confirm(
      `Teacher approval required: start ${navigationPlannerMode === 'live' ? 'live adaptive' : 'static scan-map'} ROS navigation on map ${navigationMapSnapshot.map.map_id} (${navigationMapSnapshot.map.version}) `
      + `with ${navigationRouteWaypoints.length} destination(s)?\n\nPlanner path preview (map-frame coordinates, not motor commands):\n${plannedPoints || '(no path points returned)'}\n\nKeep the robot area clear and the physical emergency stop accessible.`,
    )) return;

    setIsNavigationStarting(true);
    setNavigationExecutionStatus('Submitting route to the ROS Nav2 controller…');
    try {
      const result = await apiFetch('/api/navigation/start', {
        method: 'POST',
        body: JSON.stringify({
          map_id: navigationMapSnapshot.map.map_id,
          version: navigationMapSnapshot.map.version,
          frame_id: navigationMapSnapshot.map.frame_id,
          planner_mode: navigationPlannerMode,
          waypoints: navigationRouteWaypoints.map(({ x, y }) => ({ x, y })),
        }),
      });
      setNavigationOperation(result);
      setNavigationExecutionStatus(
        `Route ${result.operation_id} • ${result.status}; controller status will be polled.`,
      );
      setIsNavigationGoalPlacementEnabled(false);
    } catch (error) {
      setNavigationExecutionStatus(`Navigation start rejected • ${error.message}`);
    } finally {
      setIsNavigationStarting(false);
    }
  };

  const handleStopNavigation = async () => {
    if (!navigationOperation?.operation_id) return;
    setNavigationExecutionStatus('Requesting Nav2 cancellation…');
    try {
      const result = await apiFetch(`/api/navigation/operation/${navigationOperation.operation_id}/stop`, {
        method: 'POST',
      });
      setNavigationOperation((current) => current
        ? { ...current, status: result.status }
        : current);
      setNavigationExecutionStatus(
        `Cancellation requested • waiting for Nav2 terminal status (${navigationOperation.operation_id}).`,
      );
    } catch (error) {
      setNavigationExecutionStatus(`Cancellation request failed • ${error.message}`);
    }
  };

  useEffect(() => {
    const operationId = navigationOperation?.operation_id;
    if (!operationId) return undefined;
    if (['completed', 'succeeded', 'canceled', 'failed'].includes(navigationOperation.status)) {
      if (
        navigationOperation.status === 'completed'
        && pathPlannerMode === PLANNER_PATH_MODES.autonomous
        && processedAutonomousOperationRef.current !== operationId
      ) {
        processedAutonomousOperationRef.current = operationId;
        const saveCompletedRoute = async () => {
          try {
            if (navigationOperation.path_trace_truncated || navigationOperation.path_trace_error) {
              throw new Error(navigationOperation.path_trace_error || 'The executed route trace was truncated.');
            }
            const pathTrace = navigationOperation.path_trace || [];
            const code = buildSdkCommandsFromTrace(pathTrace).join('\n');
            const safeCode = sanitizeRobotCode(code).code;
            if (!safeCode) throw new Error('The recorded route did not produce validated SDK commands.');
            const waypoints = relativePlannerWaypointsFromTrace(pathTrace);
            const projectLabel = (plannerProjectLabel || buildPlannerProjectName(PLANNER_PATH_MODES.autonomous)).trim();
            const saved = await apiFetch('/api/classroom/project/save-execution', {
              method: 'POST',
              body: JSON.stringify({
                name: projectLabel,
                sceneObjects,
                plannerWaypoints: waypoints,
                generatedCode: safeCode,
                duetCode: codeByVersionRef.current.duet || '',
                plannerMode: PLANNER_PATH_MODES.autonomous,
                plannerLabel: projectLabel,
                plannerVariants: { corrected: safeCode, final: safeCode },
                selectedPlannerVariant: 'final',
              }),
            });
            await refreshClassroomData();
            setNavigationExecutionStatus(
              `Nav2 completed with ${pathTrace.length} localization feedback samples. Saved ${saved.project.name} to the shared project library; the active Blocks/IDE workspace was left unchanged.`,
            );
          } catch (error) {
            setNavigationExecutionStatus(`Nav2 completed, but its executed path could not be saved as an SDK project • ${error.message}`);
          }
        };
        saveCompletedRoute();
      }
      return undefined;
    }
    let active = true;
    const pollOperation = async () => {
      try {
        const result = await apiFetch(`/api/navigation/operation/${operationId}`);
        if (!active) return;
        setNavigationOperation(result);
        {
          let statusText = `Navigation ${result.status}`;
          if (result.status === 'succeeded') statusText = `Navigation completed${result.current_waypoint ? ` • destination ${result.current_waypoint}` : ''}`;
          else if (result.status === 'failed') statusText = `Navigation failed${result.current_waypoint ? ` • destination ${result.current_waypoint}` : ''}`;
          else if (result.status === 'canceled') statusText = `Navigation canceled${result.current_waypoint ? ` • destination ${result.current_waypoint}` : ''}`;
          setNavigationExecutionStatus(statusText);
        }
      } catch (error) {
        if (active) setNavigationExecutionStatus(`Navigation status unavailable • ${error.message}; execution remains locked.`);
      }
    };
    pollOperation();
    const timer = window.setInterval(pollOperation, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [navigationOperation, pathPlannerMode, plannerProjectLabel, sceneObjects, apiFetch, refreshClassroomData]);

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

  const generateToolboxXML = useCallback((language) => {
    const cats = UI_TEXT[language].toolbox;
    const isDuetVersion = controllerVersion === 'duet';
    const commandBlocks = isDuetVersion
      ? getDuetBlocklyCommandBlocks()
      : getG1BlocklyCommandBlocks(G1_EXECUTABLE_COMMANDS);
    const categories = [...new Set(commandBlocks.map((definition) => definition.category))];
    const commandCategoriesXml = categories.map((category) => {
      const blocks = commandBlocks
        .filter((block) => block.category === category)
        .map((block) => `<block type="${block.type}"></block>`)
        .join('');
      const colour = category === 'Concurrent actions'
        ? 210
        : category === 'Gestures' || category === 'Arm gestures' || category === 'Arm poses'
        ? 280
        : category === 'Control' ? 190 : 160;
      return `<category name="${category}" colour="${colour}">${blocks}</category>`;
    }).join('');

    return `
    <xml xmlns="https://developers.google.com/blockly/xml">
      ${commandCategoriesXml}
      ${isDuetVersion ? '' : `
        <category name="${language === 'zh' ? '距离条件' : 'Distance conditions'}" colour="200">
          <block type="controls_if"></block>
          <block type="controls_if"><mutation else="1"></mutation></block>
          <block type="logic_compare"></block>
          <block type="g1_front_distance_m"></block>
          <block type="g1_rear_distance_m"></block>
          <block type="math_number"><field name="NUM">1</field></block>
        </category>
        <category name="${language === 'zh' ? '变量' : 'Variables'}" custom="VARIABLE"></category>
      `}
      <sep></sep>
      <category name="${cats.loops}" colour="120">
        <block type="controls_repeat_ext"><value name="TIMES"><shadow type="math_number"><field name="NUM">10</field></shadow></value></block>
      </category>
    </xml>
    `;
  }, [controllerVersion]);

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
    const activeRobotCategories = controllerVersion === 'duet' ? [] : robotCategories;
    const allBlocks = [...systemCategories, ...activeRobotCategories].flatMap(cat => cat.blocks);
    const commandBlocks = [
      ...ROBOT_IDE_COMMAND_BLOCKS,
      ...getG1BlocklyCommandBlocks(G1_COMMANDS),
      ...getG1BlocklyConditionBlocks(),
      ...getDuetBlocklyCommandBlocks(),
    ];
    const definitions = [...allBlocks, ...commandBlocks].map((blockDef) => {
      const definition = { ...blockDef };
      delete definition.codeTemplate;
      delete definition.stringFields;
      delete definition.category;
      delete definition.armPreset;
      delete definition.poseName;
      definition.extensions = definition.extensions || undefined;
      return definition;
    });
    Blockly.common.defineBlocksWithJsonArray(definitions);
    
    [...allBlocks, ...commandBlocks].forEach(blockDef => {
      if (blockDef.type === 'duet_concurrent_action') {
        pythonGenerator.forBlock[blockDef.type] = (block, generator) => (
          `with duet.concurrent():\n${generator.statementToCode(block, 'LOCOMOTION')}${generator.statementToCode(block, 'GESTURE')}`
        );
        return;
      }
      if (!blockDef.codeTemplate) return;
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

            if (blockDef.stringFields?.includes(name)) {
              value = JSON.stringify(value);
            }

            if (arg.type === 'field_number' && name) {
              const safeValue = clampSafeValue(name, value);
              value = String(safeValue);
            }

            code = code.split(`{{${name}}}`).join(value);
          });
        }

        if (controllerVersion === 'legacy') code = sanitizeRobotCode(code).code;
        
        if (blockDef.output !== undefined) return [code, pythonGenerator.ORDER_ATOMIC];
        return code;
      };
    });
  }, [lang, controllerVersion]);

  useEffect(() => {
    if (!isBlocklyLoaded || !blocklyDiv.current) return;
    
    Blockly.dialog.setPrompt(function(message, defaultValue, callback) {
      setPromptState({ isOpen: true, message, defaultValue, inputValue: defaultValue, callback });
      setTimeout(() => promptInputRef.current?.focus(), 100);
    });

    registerBlocks(robotConfig);
    if (workspaceRef.current) {
      workspaceRef.current.updateToolbox(generateToolboxXML(lang));
      return undefined;
    }

    const initFrame = requestAnimationFrame(() => {
      if (!blocklyDiv.current) return;
      workspaceRef.current = Blockly.inject(blocklyDiv.current, {
        toolbox: generateToolboxXML(lang),
        scrollbars: false,
        move: {
          scrollbars: false,
          drag: true,
          wheel: true
        },
        grid: { spacing: 20, length: 3, colour: '#ccc', snap: true },
        zoom: { controls: true, wheel: true, startScale: 0.75, maxScale: 3, minScale: 0.3, scaleSpeed: 1.2 },
        trashcan: true,
      });

      const scheduleResize = () => {
        requestAnimationFrame(() => {
          if (workspaceRef.current) Blockly.svgResize(workspaceRef.current);
        });
      };

      if (resizeObserverRef.current) resizeObserverRef.current.disconnect();
      resizeObserverRef.current = new ResizeObserver(scheduleResize);
      resizeObserverRef.current.observe(blocklyDiv.current);

      const handleBlocklyEvents = (event) => {
        if (event.type === Blockly.Events.UI || event.element === 'category') {
          scheduleResize();
        }
      };
      workspaceRef.current.addChangeListener(handleBlocklyEvents);

      const updateCode = () => {
        try {
          const code = generateBlocklyPythonCode(workspaceRef.current);
          applyGeneratedCodeRef.current?.(code, { syncBlocks: false });
          setBlockSyncError('');
        } catch (error) {
          setBlockSyncError(`Cannot read the Blocks workspace: ${error.message}`);
          console.error('Failed to generate code from the Blockly workspace.', error);
        }
      };
      workspaceRef.current.addChangeListener(updateCode);
      scheduleResize();
      syncBlocksFromGeneratedCode(generatedCodeRef.current);
    });
    
    return () => {
      cancelAnimationFrame(initFrame);
    };
  }, [isBlocklyLoaded, registerBlocks, generateToolboxXML, robotConfig, lang]);

  useEffect(() => () => resizeObserverRef.current?.disconnect(), []);

  const handleApplyConfig = () => { try { setRobotConfig(JSON.parse(configText)); setShowConfigEditor(false); } catch (e) { alert("JSON Error: " + e.message); } };
  const handleImportConfig = (e) => { const r = new FileReader(); r.onload = (ev) => setConfigText(ev.target.result); if(e.target.files[0]) r.readAsText(e.target.files[0]); };
  const handleExportConfig = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([configText], {type: "application/json"})); a.download = "robot_config.json"; a.click(); };
  const saveProject = () => {
    if (!workspaceRef.current) return;
    const workspace = window.Blockly.serialization.workspaces.save(workspaceRef.current);
    const payload = controllerVersion === 'duet'
      ? { controllerVersion, generatedCode, workspace }
      : workspace;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
    a.download = controllerVersion === 'duet' ? 'duet-project.json' : 'project.json';
    a.click();
  };

  const savePathPlannerProject = async () => {
    if (!session?.user?.username || plannerWaypoints.length < 2) {
      alert('Add at least two waypoints to save a path project.');
      return;
    }
    if (
      pathPlannerMode !== PLANNER_PATH_MODES.manual
      && !plannerRouteVariants.corrected
      && !plannerRouteVariants.final
    ) {
      alert('Run the selected sensor-corrected or autonomous mode first. Only the measured executed route can be saved as the final path.');
      return;
    }
    const label = (plannerProjectLabel || projectName || buildPlannerProjectName(pathPlannerMode)).trim() || buildPlannerProjectName(pathPlannerMode);
    const variantCode = selectedPlannerVariant === 'initial'
      ? plannerRouteVariants.initial
      : selectedPlannerVariant === 'corrected'
        ? plannerRouteVariants.corrected
        : plannerRouteVariants.final || generatedCode;
    const projectPayload = {
      name: label,
      sceneObjects,
      plannerWaypoints,
      generatedCode: attachPlannerProjectMeta(variantCode || generatedCode, {
        plannerMode: pathPlannerMode,
        plannerLabel: label,
        plannerVariants: plannerRouteVariants,
        selectedPlannerVariant,
      }),
      duetCode: codeByVersionRef.current.duet || '',
      plannerMode: pathPlannerMode,
      plannerLabel: label,
      plannerVariants: plannerRouteVariants,
    };

    try {
      await apiFetch('/api/classroom/project/save', {
        method: 'POST',
        body: JSON.stringify(projectPayload),
      });
      setProjectName(label);
      setPlannerProjectLabel(label);
      alert(`Saved planner project as “${label}”. Open it from the project library to load the saved route and code.`);
    } catch (error) {
      alert(`Could not save the planner project: ${error.message}`);
    }
  };
  
  const loadProject = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result);
        if (controllerVersion === 'duet') {
          if (json?.controllerVersion !== 'duet' || typeof json.generatedCode !== 'string' || !json.workspace) {
            throw new Error('This file is not a version-two DUET project. Switch to legacy mode to open a legacy project.');
          }
          parseDuetProgram(json.generatedCode);
          applyGeneratedCode(json.generatedCode, { syncBlocks: true });
          return;
        }
        if (json?.controllerVersion === 'duet') {
          throw new Error('This is a DUET version-two project. Switch to DUET mode before opening it.');
        }
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
      setSelectedSceneObjectId(null);
      setPlannerWaypoints([]);
      setOriginalPlannerCode('');
      setIsWaypointPlacementEnabled(false);
      applyGeneratedCode('', { syncBlocks: false });
      setIsPreviewPlaying(false);
      if (session?.user?.username) {
        localStorage.removeItem(`edu-scene-objects:${session.user.username}`);
      }
    }
  };

  const loadProjectFromLibrary = (project) => {
    if (!project) return;
    const legacyCode = typeof project.generatedCode === 'string' ? project.generatedCode : '';
    const meta = parsePlannerProjectMeta(legacyCode) || {
      plannerMode: project.plannerMode,
      plannerLabel: project.plannerLabel,
      plannerVariants: project.plannerVariants,
      selectedPlannerVariant: project.selectedPlannerVariant,
    };
    const cleanLegacyCode = stripPlannerProjectMeta(legacyCode);
    const duetCode = typeof project.duetCode === 'string' ? project.duetCode : '';
    const nextCode = controllerVersion === 'duet' ? duetCode : cleanLegacyCode;
    if (controllerVersion === 'duet') {
      try {
        parseDuetProgram(nextCode);
      } catch (error) {
        alert(`Saved DUET project code is invalid and was not loaded: ${error.message}`);
        return;
      }
    }
    const projectOwner = project.username || currentUser.username;
    const sourceName = project.name || meta.plannerLabel || 'default';
    let destinationName = sourceName;
    if (projectOwner !== currentUser.username) {
      const ownedNames = new Set(projectLibrary
        .filter((entry) => entry.username === currentUser.username)
        .map((entry) => entry.name));
      let suffix = 1;
      destinationName = `${sourceName} (copy)`;
      while (ownedNames.has(destinationName)) {
        suffix += 1;
        destinationName = `${sourceName} (copy ${suffix})`;
      }
    }
    setProjectName(destinationName);
    setPlannerProjectLabel(projectOwner !== currentUser.username
      ? destinationName
      : meta.plannerLabel || project.name || 'default');
    if (meta.plannerMode && Object.prototype.hasOwnProperty.call(PLANNER_PATH_MODES, meta.plannerMode)) {
      setPathPlannerMode(meta.plannerMode);
    }
    setPlannerRouteVariants(meta.plannerVariants || { initial: cleanLegacyCode, corrected: cleanLegacyCode, final: cleanLegacyCode });
    setOriginalPlannerCode(meta.plannerMode === PLANNER_PATH_MODES.sensor_corrected
      ? meta.plannerVariants?.initial || ''
      : '');
    setSelectedPlannerVariant(meta.selectedPlannerVariant || 'final');
    setSceneObjects(Array.isArray(project.sceneObjects) ? project.sceneObjects : []);
    setSelectedSceneObjectId(null);
    setPlannerWaypoints(Array.isArray(project.plannerWaypoints) ? project.plannerWaypoints : []);
    setIsWaypointPlacementEnabled(false);
    codeByVersionRef.current.legacy = cleanLegacyCode;
    codeByVersionRef.current.duet = duetCode;
    compiledPlannerCodeRef.current = nextCode;
    applyGeneratedCode(nextCode, { syncBlocks: true });
    setMainTab('blocks');
  };

  const placePlannerWaypoint = ({ x, y }) => {
    const position = clampScenePoint(x, y, gridSize);
    setPlannerWaypoints((prev) => [
      ...prev,
      {
        id: `planner-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ...position,
      },
    ]);
    setIsWaypointPlacementEnabled(false);
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
    if (controllerVersion === 'duet') {
      alert('Path planner export is not available in DUET version two yet. Use the DUET Blocks or IDE commands instead.');
      return;
    }
    if (pathPlannerMode === PLANNER_PATH_MODES.autonomous) {
      alert('For autonomous routing, place destinations on the LiDAR map, preview them, then start the Nav2 route. Only the completed Nav2 feedback trace can be translated into SDK commands.');
      return;
    }
    if (plannerWaypoints.length < 2) {
      alert('Add at least two waypoints before compiling a motion path.');
      return;
    }
    if (generatedCode.trim() && !window.confirm('Compiling this path will replace the current Blocks and IDE code. Continue?')) return;

    const initialCode = buildPlannerMotionCommands(plannerWaypoints).join('\n');
    const selectedCode = initialCode;
    const safePlannerCode = sanitizeRobotCode(selectedCode).code || selectedCode;
    if (safePlannerCode !== generatedCode) {
      compiledPlannerCodeRef.current = safePlannerCode;
    }

    setPlannerRouteVariants({
      initial: initialCode,
      corrected: '',
      final: '',
    });
    setSelectedPlannerVariant('initial');
    setPlannerProjectLabel((previous) => previous || buildPlannerProjectName(pathPlannerMode));
    updateGeneratedCode(selectedCode);
    setIsWaypointPlacementEnabled(false);
  };

  const handleRunCheckpointedPlanner = async () => {
    if (session?.user?.role !== 'teacher') {
      setNavigationExecutionStatus('Teacher login is required to run checkpointed SDK paths.');
      return;
    }
    if (pathPlannerMode !== PLANNER_PATH_MODES.sensor_corrected) {
      setNavigationExecutionStatus('Select the sensor-corrected planner mode to run checkpointed SDK motion.');
      return;
    }
    if (plannerWaypoints.length < 2) {
      setNavigationExecutionStatus('Add at least two waypoints before running a checkpointed path.');
      return;
    }
    if (!plannerRouteVariants.initial) {
      setNavigationExecutionStatus('Compile the initial SDK path first; it will be shown in Blocks and IDE before execution.');
      return;
    }
    if (!window.confirm(
      `Teacher approval required: run the initial path through the G1 SDK? The backend will verify fresh localization and safety health at each waypoint, make at most one correction per waypoint, and stop if a checkpoint cannot be verified.\n\nExact initial SDK program:\n${plannerRouteVariants.initial}`,
    )) return;
    setIsRunning(true);
    setNavigationExecutionStatus('Running initial path through the SDK; checking live localization at each waypoint…');
    try {
      const result = await apiFetch('/api/planner/checkpointed-run', {
        method: 'POST',
        body: JSON.stringify({
          waypoints: plannerWaypoints.map(({ x, y }) => ({ x, y })),
        }),
      });
      if (result.status !== 'completed' || typeof result.correctedCode !== 'string') {
        throw new Error('Backend did not confirm completion with a recorded SDK command sequence.');
      }
      const correctedCode = result.correctedCode;
      const projectLabel = (plannerProjectLabel || buildPlannerProjectName(pathPlannerMode)).trim();
      const saved = await apiFetch('/api/classroom/project/save-execution', {
        method: 'POST',
        body: JSON.stringify({
          name: projectLabel,
          sceneObjects,
          plannerWaypoints,
          generatedCode: correctedCode,
          duetCode: codeByVersionRef.current.duet || '',
          plannerMode: PLANNER_PATH_MODES.sensor_corrected,
          plannerLabel: projectLabel,
          plannerVariants: {
            initial: plannerRouteVariants.initial,
            corrected: correctedCode,
            final: correctedCode,
          },
          selectedPlannerVariant: 'corrected',
        }),
      });
      await refreshClassroomData();
      setNavigationExecutionStatus(
        `SDK route completed • ${result.checkpoints.length} waypoint checkpoints confirmed. Saved ${saved.project.name} to the shared project library; the original compiled route is retained there. Physical accuracy remains unverified.`,
      );
    } catch (error) {
      setNavigationExecutionStatus(`Checkpointed SDK route stopped or rejected • ${error.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleRunCode = async () => {
    if (isRunning) {
      try {
        const result = await activeRobotConnection.stop();
        if (controllerVersion === 'duet') {
          if (result.status === 'stopped' && result.zeroCommandConfirmed === true) {
            duetProgramActiveRef.current = false;
            setIsDuetProgramActive(false);
            setIsRunning(false);
          }
          setRobotConnectionStatus(result.status === 'stopping'
            ? 'DUET stop requested; waiting for confirmation of zero velocity and cleared arm-pose lease.'
            : result.status === 'stopped' && result.zeroCommandConfirmed === true
              ? 'DUET confirmed zero velocity and requested carry/default arm return; physical immobility or pose attainment is not verified.'
            : 'DUET stop was not confirmed.');
        } else {
          setIsRunning(false);
          setRobotConnectionStatus(result.status === 'stopping' || result.status === 'stopped'
            ? 'SDK stop requested.'
            : 'Robot is not connected');
        }
      } catch (error) {
        alert(`Stop failed: ${error.message}`);
      }
    } else {
      try {
        if (session?.user?.role !== 'teacher') {
          throw new Error('A teacher must review and approve physical motion requests. Submit this exact program to the teacher queue for review.');
        }
        if (!isRobotConnected) {
          throw new Error(controllerVersion === 'duet'
            ? 'Connect the DUET G1 23-DOF controller before sending a program.'
            : 'Connect the G1 SDK before sending a program.');
        }
        if (controllerVersion === 'duet') parseDuetProgram(generatedCode);
        else parseG1Program(generatedCode);
        if (!window.confirm(
          `Teacher approval required: send this exact ${controllerVersion === 'duet' ? 'DUET v2' : 'legacy SDK'} program to the robot?\n\n${generatedCode}`,
        )) return;
        setIsRunning(true);
        const result = await activeRobotConnection.run(generatedCode);
        let keepDuetRunLock = false;
        if (controllerVersion === 'duet' && result.status === 'accepted') {
          duetProgramActiveRef.current = true;
          setIsDuetProgramActive(true);
          keepDuetRunLock = true;
          setRobotConnectionStatus(`DUET accepted ${result.commandsExecuted} command(s); waiting for controller completion. Physical movement is not verified.`);
        } else {
          if (controllerVersion === 'duet') {
            duetProgramActiveRef.current = false;
            setIsDuetProgramActive(false);
          }
        }
        const output = result.results?.length ? ` SDK output: ${JSON.stringify(result.results)}` : '';
        const conditionOutput = result.conditionsEvaluated?.length
          ? ` Condition branches: ${result.conditionsEvaluated.map((decision) => (
            decision.variable
              ? `${decision.variable} is ${decision.value} → ${decision.branch}`
              : `${decision.clear ? `clear within ${decision.max_range_m} m` : `${decision.distance_m.toFixed(2)} m`} ${decision.operator} ${decision.threshold_m} m → ${decision.branch}`
          )).join('; ')}.`
          : '';
        if (!keepDuetRunLock) {
          const controllerName = controllerVersion === 'duet' ? 'DUET' : 'SDK';
          const accepted = controllerVersion === 'duet' ? 'accepted' : 'finished sending';
          setRobotConnectionStatus(`${controllerName} ${accepted} ${result.commandsExecuted} command(s). Physical movement is not verified.${conditionOutput}${output}`);
        }
      } catch (error) {
        alert(`Robot run failed: ${error.message}`);
      } finally {
        if (!duetProgramActiveRef.current) setIsRunning(false);
      }
    }
  };

  const activeObstacles = useMemo(() => sceneObjects, [sceneObjects]);
  const queueReviewSnapshot = queueReviewItem?.project_snapshot || {};
  const queueReviewPlannerRequest = queueReviewItem?.planner_request;
  const queueReviewWaypoints = queueReviewPlannerRequest?.planner_waypoints
    || queueReviewSnapshot.plannerWaypoints
    || [];

  useEffect(() => {
    const operationId = queueReviewNavigationOperation?.operation_id;
    if (!operationId) return undefined;
    let active = true;
    let timer;
    const pollOperation = async () => {
      try {
        const operation = await apiFetch(`/api/navigation/operation/${operationId}`);
        if (!active) return;
        setQueueReviewNavigationOperation(operation);
        if (operation.saved_project) setQueueReviewSavedProject(operation.saved_project);
        if (['completed', 'succeeded', 'canceled', 'failed'].includes(operation.status)) {
          window.clearInterval(timer);
          const completed = ['completed', 'succeeded'].includes(operation.status);
          const queueStatus = completed ? 'completed' : operation.status === 'canceled' ? 'paused' : 'failed';
          setQueueReviewStatus(completed
            ? operation.saved_project
              ? `Autonomous request completed and saved as ${operation.saved_project.name}. Physical movement is not independently verified.`
              : operation.saved_project_error
                ? `Autonomous request completed, but its project could not be saved • ${operation.saved_project_error}`
                : 'Autonomous request completed. Physical movement is not independently verified.'
            : `Autonomous request ${operation.status}.`);
          setQueueReviewItem((item) => item?.id === operation.route?.queue_item_id
            ? { ...item, status: queueStatus }
            : item);
          const items = await refreshClassroomData();
          const item = items.find((entry) => entry.id === operation.route?.queue_item_id);
          if (item) setQueueReviewItem(item);
          if (item?.result_project) setQueueReviewSavedProject(item.result_project);
        }
      } catch (error) {
        if (active) setQueueReviewError(`Could not refresh operation status • ${error.message}`);
      }
    };
    pollOperation();
    timer = window.setInterval(pollOperation, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [queueReviewNavigationOperation?.operation_id, apiFetch, refreshClassroomData]);

  const previewPreviewState = useCallback(() => {
    try {
      const state = controllerVersion === 'duet'
        ? simulateDuetG1Edu23Program(generatedCode).at(-1)
        : simulateG1Edu23Program(generatedCode, {
          mode: simulatorMode,
          obstacles: activeObstacles,
        });
      setSimulatorState(state);
    } catch (error) {
      setSimulatorState({
        ...createEmptyG1Edu23State(),
        status: `Invalid ${controllerVersion === 'duet' ? 'DUET' : 'G1'} program`,
        actions: [{ label: 'Preview rejected', summary: error.message }],
        mode: controllerVersion === 'duet' ? 'duet-preview' : simulatorMode,
      });
    }
  }, [controllerVersion, generatedCode, simulatorMode, activeObstacles]);

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
    setIsWaypointPlacementEnabled(false);
  };

  const handlePlaybackSpeedChange = (value) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;
    setPlaybackSpeed(Math.min(3, Math.max(0.1, Math.round(numericValue * 10) / 10)));
  };

  const syncBlocksFromGeneratedCode = useCallback((code) => {
    if (!workspaceRef.current || !window.Blockly) return false;
    const workspace = workspaceRef.current;
    let nodes;
    try {
      nodes = controllerVersion === 'duet'
        ? parseDuetProgram(code || '')
        : parseG1Program(code || '');
    } catch (error) {
      setBlockSyncError(`Cannot display this code as Blocks: ${error.message}`);
      return false;
    }
    setBlockSyncError('');
    Blockly.Events.disable();
    try {
      workspace.clear();
      const createBlocks = (program, parentConnection = null) => {
        let previousBlock = null;
        program.forEach((node) => {
          let block;
          if (node.type === 'repeat') {
            block = workspace.newBlock('controls_repeat_ext');
          } else if (node.type === 'concurrent') {
            block = workspace.newBlock('duet_concurrent_action');
          } else if (node.type === 'condition') {
            block = workspace.newBlock('controls_if');
            if (node.else.length) {
              const mutation = document.createElement('mutation');
              mutation.setAttribute('else', '1');
              block.domToMutation(mutation);
            }
          } else if (node.type === 'boolean_assignment') {
            block = workspace.newBlock('variables_set');
          } else {
            block = controllerVersion === 'duet'
              ? workspace.newBlock(`duet_command_${node.method}`)
              : workspace.newBlock(node.method === 'arm_action'
                ? getG1BlocklyCommandBlocks().find((definition) => definition.armPreset === node.values[0])?.type || 'g1_command_arm_action'
                : `g1_command_${node.method}`);
          }
          if (node.type === 'repeat') {
            const repeatCount = workspace.newBlock('math_number');
            repeatCount.setFieldValue(String(node.times), 'NUM');
            repeatCount.initSvg();
            repeatCount.render();
            block.getInput('TIMES').connection.connect(repeatCount.outputConnection);
          } else if (node.type === 'condition') {
            if (node.variable) {
              const variableMap = workspace.getVariableMap();
              const variable = variableMap.getVariable(node.variable) || variableMap.createVariable(node.variable);
              const variableBlock = workspace.newBlock('variables_get');
              variableBlock.setFieldValue(variable.getId(), 'VAR');
              variableBlock.initSvg();
              variableBlock.render();
              block.getInput('IF0').connection.connect(variableBlock.outputConnection);
            } else {
              const comparison = workspace.newBlock('logic_compare');
              const distance = workspace.newBlock(node.sensor === 'rear_distance_m'
                ? 'g1_rear_distance_m'
                : 'g1_front_distance_m');
              const threshold = workspace.newBlock('math_number');
              const operatorFields = { '<': 'LT', '<=': 'LTE', '>': 'GT', '>=': 'GTE', '==': 'EQ', '!=': 'NEQ' };
              comparison.setFieldValue(operatorFields[node.operator], 'OP');
              threshold.setFieldValue(String(node.threshold), 'NUM');
              [distance, threshold, comparison].forEach((conditionBlock) => {
                conditionBlock.initSvg();
                conditionBlock.render();
              });
              comparison.getInput('A').connection.connect(distance.outputConnection);
              comparison.getInput('B').connection.connect(threshold.outputConnection);
              block.getInput('IF0').connection.connect(comparison.outputConnection);
            }
          } else if (node.type === 'boolean_assignment') {
            const variableMap = workspace.getVariableMap();
            const variable = variableMap.getVariable(node.name) || variableMap.createVariable(node.name);
            const valueBlock = workspace.newBlock('logic_boolean');
            valueBlock.setFieldValue(node.value ? 'TRUE' : 'FALSE', 'BOOL');
            valueBlock.initSvg();
            valueBlock.render();
            block.setFieldValue(variable.getId(), 'VAR');
            block.getInput('VALUE').connection.connect(valueBlock.outputConnection);
          } else if (node.type === 'command') {
            const definition = (controllerVersion === 'duet' ? DUET_COMMANDS : G1_COMMANDS)
              .find((entry) => entry.method === node.method);
            definition?.args.forEach((argument, index) => {
              const valueIndex = node.poseName && definition.poseInput ? index - 1 : index;
              if (block.getField(argument.name) && node.values[valueIndex] !== undefined) {
                block.setFieldValue(String(node.values[valueIndex]), argument.name);
              }
            });
          }
          block.initSvg();
          block.render();
          if (node.type === 'command' && node.poseName) {
            const poseBlock = workspace.newBlock(`duet_pose_target_${node.poseName}`);
            poseBlock.initSvg();
            poseBlock.render();
            block.getInput('POSE').connection.connect(poseBlock.outputConnection);
          }
          if (previousBlock) previousBlock.nextConnection.connect(block.previousConnection);
          else if (parentConnection) parentConnection.connect(block.previousConnection);
          if (node.type === 'repeat') createBlocks(node.body, block.getInput('DO').connection);
          if (node.type === 'concurrent') {
            createBlocks([node.movement], block.getInput('LOCOMOTION').connection);
            createBlocks([node.gesture], block.getInput('GESTURE').connection);
          }
          if (node.type === 'condition') {
            createBlocks(node.then, block.getInput('DO0').connection);
            if (node.else.length) createBlocks(node.else, block.getInput('ELSE').connection);
          }
          previousBlock = block;
        });
      };
      createBlocks(nodes);

      if (workspace.getAllBlocks().length) {
        workspace.zoomToFit();
        workspace.setScale(Math.min(workspace.getScale(), 0.8));
        workspace.scrollCenter();
      }
      return true;
    } catch (error) {
      setBlockSyncError(`Cannot display this code as Blocks: ${error.message}`);
      console.error('Failed to synchronize IDE code to Blockly.', error);
      return false;
    } finally {
      Blockly.Events.enable();
    }
  }, [controllerVersion]);

  useEffect(() => {
    if (mainTab !== 'blocks' || !workspaceRef.current) return;
    let fitFrame = 0;
    const frame = requestAnimationFrame(() => {
      if (!workspaceRef.current) return;
      Blockly.svgResize(workspaceRef.current);
      fitFrame = requestAnimationFrame(() => {
        if (!workspaceRef.current) return;
        syncBlocksFromGeneratedCode(generatedCodeRef.current);
        Blockly.svgResize(workspaceRef.current);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(fitFrame);
    };
  }, [mainTab, syncBlocksFromGeneratedCode]);

  const derivePlannerWaypointsFromCode = useCallback((code = '') => {
    if (!code || !code.trim()) return [];
    let commands;
    try {
      commands = flattenG1Commands(parseG1Program(code));
    } catch {
      return [];
    }
    if (!commands.length) return [];
    let x = 0;
    let y = 0;
    let heading = 0;
    const points = [{ id: 'planner-0', x, y }];
    commands.forEach(({ method, values }) => {
      const numberOfSteps = Number(values[0] || 0);
      let forwardDistance = 0;
      let moved = false;
      if (method === 'walk') forwardDistance = numberOfSteps * G1_NOMINAL_STEP_METERS;
      if (method === 'backward') forwardDistance = -numberOfSteps * G1_NOMINAL_STEP_METERS;
      if (method === 'walktime') forwardDistance = numberOfSteps * 0.4;
      if (method === 'backwardtime') forwardDistance = -numberOfSteps * 0.4;
      if (method === 'slowwalk') forwardDistance = numberOfSteps * G1_NOMINAL_STEP_METERS;
      if (method === 'slowwalktime') forwardDistance = numberOfSteps * 0.2;
      if (method === 'fastwalk') forwardDistance = numberOfSteps * G1_NOMINAL_STEP_METERS;
      if (method === 'fastwalktime') forwardDistance = numberOfSteps * 0.8;
      if (method === 'sidestep') {
        const sideHeading = heading + (values[0] === 'left' ? 90 : -90);
        x += Math.cos((sideHeading * Math.PI) / 180) * G1_NOMINAL_STEP_METERS;
        y += Math.sin((sideHeading * Math.PI) / 180) * G1_NOMINAL_STEP_METERS;
        moved = true;
      } else if (method === 'turn') {
        heading += values[0] === 'right' ? -Number(values[1]) : Number(values[1]);
      } else if (forwardDistance) {
        x += Math.cos((heading * Math.PI) / 180) * forwardDistance;
        y += Math.sin((heading * Math.PI) / 180) * forwardDistance;
        moved = true;
      }
      if (moved) {
        points.push({ id: `planner-${points.length}`, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
      }
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
    const { syncBlocks = true, preserveFormatting = false } = options;
    const cleanedCode = stripPlannerProjectMeta(nextCode ?? '');
    let boundedCode = cleanedCode;
    let boundsChanged = false;
    if (!preserveFormatting && cleanedCode.trim()) {
      try {
        boundedCode = controllerVersion === 'duet'
          ? formatDuetProgram(parseDuetProgram(cleanedCode))
          : formatG1Program(parseG1Program(cleanedCode));
        boundsChanged = boundedCode.trim() !== cleanedCode.trim();
      } catch {
        // Keep in-progress IDE edits intact; execution validates the complete program.
      }
    }
    const result = controllerVersion === 'duet'
      ? { code: boundedCode, changed: false }
      : sanitizeRobotCode(boundedCode);
    const safeCode = result.code || boundedCode;
    generatedCodeRef.current = safeCode;
    codeByVersionRef.current[controllerVersion] = safeCode;
    setGeneratedCode(safeCode);
    setSafetyNotice(result.changed || boundsChanged ? 'Commands were normalized to the shared syntax and safe ranges.' : '');
    if (syncBlocks && workspaceRef.current && window.Blockly) {
      syncBlocksFromGeneratedCode(safeCode);
    }
  }, [controllerVersion, syncBlocksFromGeneratedCode]);
  applyGeneratedCodeRef.current = applyGeneratedCode;

  const updateGeneratedCode = useCallback((nextCode) => {
    applyGeneratedCode(nextCode, { syncBlocks: true });
  }, [applyGeneratedCode]);

  const applyMotionPromptResult = (promptText, source) => {
    const result = controllerVersion === 'duet'
      ? compileDuetMotionPrompt(promptText)
      : compileMotionPrompt(promptText);
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
    } catch {
      applyMotionPromptResult(motionPrompt, 'Local fallback');
      setMotionPromptStatus('fallback');
    }
  };

  const insertRobotCommand = (snippet) => {
    const nextCode = generatedCode ? `${generatedCode.trimEnd()}\n${snippet}\n` : `${snippet}\n`;
    updateGeneratedCode(nextCode);
  };

  const handleRecordMotionCapture = () => {
    const sampleScript = controllerVersion === 'duet'
      ? [
        'duet.move(0.15, 0, 0, 1)',
        'duet.move(0, 0, 0.25, 1)',
      ].join('\n')
      : [
        'robot.stand()',
        'robot.walk(3)',
        'robot.turn("left", 90)',
        'robot.walk(2)',
        'robot.stand()',
      ].join('\n');

    if (generatedCode && generatedCode.trim()) {
      const confirmed = window.confirm('Inserting the example program will overwrite the current blocks and IDE code. Continue?');
      if (!confirmed) return;
    }

    updateGeneratedCode(sampleScript);
    setMainTab('blocks');
  };

  useEffect(() => {
    try {
      const state = controllerVersion === 'duet'
        ? simulateDuetG1Edu23Program(generatedCode).at(-1)
        : simulateG1Edu23Program(generatedCode, { mode: simulatorMode, obstacles: activeObstacles });
      setSimulatorState(state);
    } catch (error) {
      setSimulatorState({
        ...createEmptyG1Edu23State(),
        status: `Invalid ${controllerVersion === 'duet' ? 'DUET' : 'G1'} program`,
        actions: [{ label: 'Preview rejected', summary: error.message }],
        mode: controllerVersion === 'duet' ? 'duet-preview' : simulatorMode,
      });
    }
  }, [controllerVersion, generatedCode, simulatorMode, activeObstacles]);

  const addStudentObstacle = (type = 'box') => {
    const preset = OBJECT_LIBRARY.find((item) => item.id === type) || OBJECT_LIBRARY[0];
    setSceneObjects((prev) => {
      const coordinateLimit = Math.max(0, sceneExtent / 2 - 1);
      const coordinates = Array.from({ length: 5 }, (_, index) => (
        -coordinateLimit + (coordinateLimit * 2 * index) / 4
      ));
      const candidates = coordinates.flatMap((x) => coordinates.map((y) => ({
        x: x + sceneCenterX,
        y: y + sceneCenterY,
      })))
        .sort((left, right) => (
          Math.hypot(left.x - sceneCenterX, left.y - sceneCenterY)
          - Math.hypot(right.x - sceneCenterX, right.y - sceneCenterY)
        ));
      const position = candidates
        .map((candidate) => ({
          ...candidate,
          overlap: prev.reduce((score, obstacle) => {
            const requiredSpace = (preset.defaultRadius + (Number(obstacle.radius) || 10)) / 12 + 0.5;
            const distance = Math.hypot(candidate.x - obstacle.x, candidate.y - obstacle.y);
            return score + Math.max(0, requiredSpace - distance);
          }, 0),
        }))
        .sort((left, right) => (
          left.overlap - right.overlap
          || Math.hypot(left.x - sceneCenterX, left.y - sceneCenterY)
            - Math.hypot(right.x - sceneCenterX, right.y - sceneCenterY)
        ))[0];
      const defaultPosition = clampGridPoint(position.x, position.y);
      return [
        ...prev,
        {
        id: `student-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: preset.id,
        label: preset.label,
        color: preset.color,
        x: defaultPosition.x,
        y: defaultPosition.y,
        radius: preset.defaultRadius,
        dimensions: getSceneObjectDimensions({ type: preset.id, radius: preset.defaultRadius }),
        },
      ];
    });
  };

  const selectSceneObject = (id) => {
    setSelectedSceneObjectId(id);
    setSimulatorSidebarTab('scene-objects');
  };

  const updateStudentObstacle = (id, patch) => {
    setSceneObjects((prev) => prev.map((obstacle) => {
      if (obstacle.id !== id) return obstacle;
      const nextPosition = clampGridPoint(
        patch.x !== undefined ? patch.x : obstacle.x,
        patch.y !== undefined ? patch.y : obstacle.y,
      );
      return { ...obstacle, ...patch, x: nextPosition.x, y: nextPosition.y };
    }));
  };

  const removeStudentObstacle = (id) => {
    setSceneObjects((prev) => prev.filter((obstacle) => obstacle.id !== id));
    setSelectedSceneObjectId((selectedId) => selectedId === id ? null : selectedId);
  };

  const obstacleDragRef = useRef(null);
  const plannerDragRef = useRef(null);
  const sceneOrigin = 110;
  const sharedMapMetadata = sharedLidarMap?.map?.map;
  const mapWidthMeters = sharedMapMetadata ? sharedMapMetadata.width * sharedMapMetadata.resolution_m : 0;
  const mapHeightMeters = sharedMapMetadata ? sharedMapMetadata.height * sharedMapMetadata.resolution_m : 0;
  const mapCenterLocalX = mapWidthMeters / 2;
  const mapCenterLocalY = mapHeightMeters / 2;
  const mapCenterCosine = Math.cos(sharedMapMetadata?.origin?.yaw_rad || 0);
  const mapCenterSine = Math.sin(sharedMapMetadata?.origin?.yaw_rad || 0);
  const sceneCenterX = sharedLidarOverlayEnabled && sharedMapMetadata
    ? sharedMapMetadata.origin.x + mapCenterCosine * mapCenterLocalX - mapCenterSine * mapCenterLocalY
    : 0;
  const sceneCenterY = sharedLidarOverlayEnabled && sharedMapMetadata
    ? sharedMapMetadata.origin.y + mapCenterSine * mapCenterLocalX + mapCenterCosine * mapCenterLocalY
    : 0;
  const rotatedMapWidth = Math.abs(mapCenterCosine) * mapWidthMeters + Math.abs(mapCenterSine) * mapHeightMeters;
  const rotatedMapHeight = Math.abs(mapCenterSine) * mapWidthMeters + Math.abs(mapCenterCosine) * mapHeightMeters;
  const sceneExtent = sharedLidarOverlayEnabled && sharedMapMetadata
    ? Math.max(gridSize, rotatedMapWidth, rotatedMapHeight)
    : gridSize;
  const sceneScale = 220 / sceneExtent;
  const sceneX = (meters) => sceneOrigin + (meters - sceneCenterX) * sceneScale;
  const sceneY = (meters) => sceneOrigin - (meters - sceneCenterY) * sceneScale;
  const clampGridPoint = (x, y) => ({
    x: Math.max(sceneCenterX - sceneExtent / 2, Math.min(sceneCenterX + sceneExtent / 2, x)),
    y: Math.max(sceneCenterY - sceneExtent / 2, Math.min(sceneCenterY + sceneExtent / 2, y)),
  });
  const navigationOccupiedCellsPath = useMemo(() => {
    if (!navigationMapSnapshot?.data?.length || !navigationMapSnapshot.map) return '';
    const { data, map } = navigationMapSnapshot;
    const commands = [];
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] < 65) continue;
      const column = index % map.width;
      const row = Math.floor(index / map.width);
      const x = column * map.resolution_m;
      const y = row * map.resolution_m;
      const size = map.resolution_m;
      commands.push(`M${x} ${y}h${size}v${size}h-${size}z`);
    }
    return commands.join('');
  }, [navigationMapSnapshot]);
  const navigationRoutePreviewPoints = useMemo(() => {
    if (
      !navigationRoutePreview
      || !navigationMapSnapshot?.map
      || navigationRoutePreview.map_id !== navigationMapSnapshot.map.map_id
      || navigationRoutePreview.version !== navigationMapSnapshot.map.version
      || navigationRoutePreview.frame_id !== navigationMapSnapshot.map.frame_id
    ) return '';
    const { map } = navigationMapSnapshot;
    return navigationRoutePreview.path.map((point) => {
      const local = worldToMapLocal(point.x, point.y, map);
      return `${local.x},${local.y}`;
    }).join(' ');
  }, [navigationMapSnapshot, navigationRoutePreview]);
  const navigationLiveScanPreview = useMemo(() => {
    const map = navigationMapSnapshot?.map;
    if (!map || !Array.isArray(liveLidarScanPoints) || lidarScanJob?.frame_id !== map.frame_id) return [];
    const mapWidth = map.width * map.resolution_m;
    const mapHeight = map.height * map.resolution_m;
    return liveLidarScanPoints.flatMap((point) => {
      const local = worldToMapLocal(point.x, point.y, map);
      if (local.x < 0 || local.y < 0 || local.x >= mapWidth || local.y >= mapHeight) return [];
      return [{ ...point, mapX: local.x, mapY: local.y }];
    });
  }, [lidarScanJob?.frame_id, liveLidarScanPoints, navigationMapSnapshot]);
  const navigationLiveObstaclePreview = useMemo(() => {
    const map = navigationMapSnapshot?.map;
    if (
      navigationPlannerMode !== 'live'
      || !map
      || liveNavigationObstacles?.ready !== true
      || liveNavigationObstacles.frame_id !== map.frame_id
      || !Array.isArray(liveNavigationObstacles.points)
    ) return [];
    const mapWidth = map.width * map.resolution_m;
    const mapHeight = map.height * map.resolution_m;
    return liveNavigationObstacles.points.flatMap((point) => {
      const local = worldToMapLocal(point.x, point.y, map);
      if (local.x < 0 || local.y < 0 || local.x >= mapWidth || local.y >= mapHeight) return [];
      return [{ ...point, mapX: local.x, mapY: local.y }];
    });
  }, [liveNavigationObstacles, navigationMapSnapshot, navigationPlannerMode]);
  const navigationLivePosePreview = useMemo(() => {
    const map = navigationMapSnapshot?.map;
    if (!map || liveNavigationPose?.frame_id !== map.frame_id) return null;
    const local = worldToMapLocal(liveNavigationPose.x, liveNavigationPose.y, map);
    if (
      local.x < 0 || local.y < 0
      || local.x >= map.width * map.resolution_m
      || local.y >= map.height * map.resolution_m
    ) return null;
    return { ...local, yaw_rad: liveNavigationPose.yaw_rad };
  }, [liveNavigationPose, navigationMapSnapshot]);
  const sharedOccupiedCellsPath = useMemo(() => {
    const snapshot = sharedLidarMap?.map;
    if (!snapshot?.data?.length || !snapshot.map) return '';
    const { data, map } = snapshot;
    const commands = [];
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] < 65) continue;
      const column = index % map.width;
      const row = Math.floor(index / map.width);
      const x = column * map.resolution_m;
      const y = row * map.resolution_m;
      const size = map.resolution_m;
      commands.push(`M${x} ${y}h${size}v${size}h-${size}z`);
    }
    return commands.join('');
  }, [sharedLidarMap]);
  const sharedPointCloudPreview = useMemo(() => {
    const snapshot = sharedLidarMap?.map;
    const points = sharedLidarMap?.pointcloud?.points;
    if (!snapshot?.map || !Array.isArray(points)) return [];
    const { map } = snapshot;
    const stride = Math.max(1, Math.ceil(points.length / 5_000));
    const cosine = Math.cos(map.origin.yaw_rad);
    const sine = Math.sin(map.origin.yaw_rad);
    return points.filter((_, index) => index % stride === 0).flatMap((point) => {
      const dx = point.x - map.origin.x;
      const dy = point.y - map.origin.y;
      const x = cosine * dx + sine * dy;
      const y = -sine * dx + cosine * dy;
      if (x < 0 || y < 0 || x >= map.width * map.resolution_m || y >= map.height * map.resolution_m) return [];
      return [{ ...point, mapX: x, mapY: y }];
    });
  }, [sharedLidarMap]);
  const sharedGridOverlayPath = useMemo(() => {
    const snapshot = sharedLidarMap?.map;
    if (!sharedLidarOverlayEnabled || !snapshot?.data?.length || !snapshot.map) return '';
    const { data, map } = snapshot;
    const resolution = map.resolution_m;
    const cosine = Math.cos(map.origin.yaw_rad);
    const sine = Math.sin(map.origin.yaw_rad);
    const halfGrid = sceneExtent / 2;
    const commands = [];
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] < 65) continue;
      const column = index % map.width;
      const row = Math.floor(index / map.width);
      const localX = (column + 0.5) * resolution;
      const localY = (row + 0.5) * resolution;
      const centerX = map.origin.x + cosine * localX - sine * localY;
      const centerY = map.origin.y + sine * localX + cosine * localY;
      if (
        centerX < sceneCenterX - halfGrid - resolution || centerX > sceneCenterX + halfGrid + resolution
        || centerY < sceneCenterY - halfGrid - resolution || centerY > sceneCenterY + halfGrid + resolution
      ) continue;
      const corners = [
        [column * resolution, row * resolution],
        [(column + 1) * resolution, row * resolution],
        [(column + 1) * resolution, (row + 1) * resolution],
        [column * resolution, (row + 1) * resolution],
      ].map(([x, y]) => {
        const worldX = map.origin.x + cosine * x - sine * y;
        const worldY = map.origin.y + sine * x + cosine * y;
        return `${sceneOrigin + (worldX - sceneCenterX) * sceneScale} ${sceneOrigin - (worldY - sceneCenterY) * sceneScale}`;
      });
      commands.push(`M${corners.join('L')}z`);
    }
    return commands.join('');
  }, [sceneCenterX, sceneCenterY, sceneExtent, sceneOrigin, sceneScale, sharedLidarMap, sharedLidarOverlayEnabled]);

  const getSvgCoords = (event) => {
    const svg = event.currentTarget.ownerSVGElement || event.currentTarget;
    const screenPoint = svg.createSVGPoint();
    screenPoint.x = event.clientX;
    screenPoint.y = event.clientY;
    const svgPoint = screenPoint.matrixTransform(svg.getScreenCTM().inverse());
    const worldX = (svgPoint.x - sceneOrigin) / sceneScale + sceneCenterX;
    const worldY = (sceneOrigin - svgPoint.y) / sceneScale + sceneCenterY;
    return clampGridPoint(worldX, worldY);
  };

  const handleObstaclePointerDown = (event, obstacleId) => {
    selectSceneObject(obstacleId);
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
    const { x, y } = getSvgCoords(event);
    updateStudentObstacle(obstacleDragRef.current.obstacleId, { x, y });
  };

  const handlePlannerWaypointPointerMove = (event) => {
    if (!plannerDragRef.current) return;
    const { x, y } = getSvgCoords(event);
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
        const nextCode = generateBlocklyPythonCode(workspaceRef.current);
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

          <form onSubmit={isRegistering ? handleRegisterStudent : handleLogin} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                <input
                  type="text"
                  value={loginForm.username}
                  onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
                  autoComplete="username"
                  required
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                  autoComplete={isRegistering ? 'new-password' : 'current-password'}
                  minLength={isRegistering ? 8 : undefined}
                  required
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {!isRegistering && <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Role</label>
                <select
                  value={loginForm.role}
                  onChange={(e) => setLoginForm({ ...loginForm, role: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="teacher">Teacher</option>
                  <option value="student">Student</option>
                </select>
              </div>}
              {loginError && <p className="text-red-600 text-sm">{loginError}</p>}
              <button type="submit" className="w-full bg-blue-600 text-white rounded-xl py-2.5 font-semibold hover:bg-blue-700 transition-colors">
                {isRegistering ? 'Create Student Account' : 'Log In'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsRegistering((registering) => !registering);
                  setLoginError('');
                }}
                className="w-full rounded-xl border border-slate-200 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50"
              >
                {isRegistering ? 'Back to Log In' : 'Create Account'}
              </button>
              <div className="text-xs text-slate-500 space-y-1">
                {isRegistering
                  ? <p>Student accounts only. Username: 3–32 letters, numbers, _ or -. Password: 8–128 characters.</p>
                  : <>
                    <p>Teacher demo: teacher / teacher</p>
                    <p>Student demo: student1 / student1</p>
                    <p>Create a student account to join the classroom.</p>
                  </>}
              </div>
          </form>
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
            {currentUser.role === 'teacher' && (
              <div className="flex items-center justify-between gap-3 border-t bg-white px-5 py-3">
                <div>
                  <p className="text-sm font-semibold text-gray-800">Shared LiDAR map</p>
                  <p className="text-xs text-gray-500">Show the teacher-approved room map on student grids.</p>
                </div>
                <input
                  type="checkbox"
                  aria-label="Show shared LiDAR map overlay in Settings"
                  checked={sharedLidarOverlayEnabled}
                  onChange={(event) => handleSharedLidarOverlayToggle(event.target.checked)}
                  className="h-5 w-5 accent-cyan-700"
                />
              </div>
            )}
            {currentUser.role === 'teacher' && (
              <div className="flex items-center justify-between gap-3 border-t bg-blue-50 px-5 py-3">
                <div>
                  <p className="text-sm font-semibold text-gray-800">DUET version two preview</p>
                  <p className="text-xs text-gray-600">
                    Switches Blocks, IDE, simulation, and connection to the separate DUET path. Legacy programs stay unchanged. Physical DUET motion remains unavailable until a separately validated controller gateway is installed.
                  </p>
                </div>
                <input
                  type="checkbox"
                  aria-label="Enable DUET version two"
                  checked={controllerVersion === 'duet'}
                  disabled={isRunning || isRobotConnecting}
                  onChange={(event) => handleControllerVersionChange(event.target.checked)}
                  className="h-5 w-5 accent-blue-700"
                />
              </div>
            )}
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
              <span className="text-xs rounded-full bg-blue-100 text-blue-700 px-2 py-1" aria-label={`Classroom queue: ${classroomStatus}`}>
                Queue: {classroomStatus}
              </span>
              <button type="button" onClick={() => setIsSimulatorOpen(false)} className="rounded-md p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800" aria-label="Close simulator">
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="p-3 space-y-3">
            {currentUser.role === 'teacher' && (
              <>
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] uppercase tracking-wide text-blue-700 font-semibold">Robot connection</p>
                    <span
                      role="status"
                      aria-live="polite"
                      className={`rounded-full px-2 py-1 text-[10px] font-bold ${
                        isRobotConnected
                          ? 'bg-green-100 text-green-800'
                          : isRobotConnecting
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-slate-200 text-slate-700'
                      }`}
                    >
                      {isRobotConnected ? 'CONNECTED' : isRobotConnecting ? 'CONNECTING' : 'DISCONNECTED'}
                    </span>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={handleConnectRobot}
                      disabled={isRobotConnecting || isRunning}
                      className="flex-1 rounded-lg bg-blue-600 text-white px-2.5 py-1.5 text-xs font-medium disabled:cursor-wait disabled:opacity-60"
                    >
                      {isRobotConnecting
                        ? 'Connecting…'
                        : controllerVersion === 'duet' && isRobotConnected
                          ? 'Disconnect DUET'
                          : isRobotConnected ? 'Reconnect' : 'Connect'}
                    </button>
                    {isRobotConnected && (
                      <button
                        type="button"
                        onClick={handleTestRobotMotion}
                        disabled={isRunning || isRobotConnecting}
                        className="flex-1 rounded-lg bg-amber-500 text-slate-950 px-2.5 py-1.5 text-xs font-semibold disabled:cursor-wait disabled:opacity-60"
                      >
                        {isRunning ? 'Motion test running…' : controllerVersion === 'duet' ? 'Test DUET motion' : 'Test motion'}
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleTestLidar}
                      disabled={isLidarTesting || isRobotConnecting}
                      className="rounded-lg border border-cyan-700 bg-white px-2.5 py-1.5 text-xs font-semibold text-cyan-800 disabled:cursor-wait disabled:opacity-60"
                    >
                      {isLidarTesting ? 'Testing LiDAR…' : 'Test LiDAR'}
                    </button>
                    <span role="status" aria-live="polite" className="min-w-0 text-xs text-slate-700">
                      {lidarTestStatus}
                    </span>
                  </div>
                  <p className="mt-2 text-[10px] text-slate-600">
                    {controllerVersion === 'duet'
                      ? 'Connect uses the separate DUET controller gateway. The SDK connection path is unchanged and is not used for DUET commands.'
                      : 'Connect uses the G1 host&apos;s configured Ethernet interface. Test LiDAR reads backend sensor status without robot motion; simulation works while disconnected.'}
                  </p>
                  <p className={`mt-2 text-xs ${isRobotConnected ? 'text-green-700' : 'text-slate-600'}`}>{robotConnectionStatus}</p>
                </div>

                <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-cyan-800 font-semibold">Sensors and diagnostics</p>
                      <p className="mt-1 text-[10px] text-slate-600">Teacher-only controls; no network, topic, frame, or route editing.</p>
                    </div>
                    <button
                      type="button"
                      onClick={handleDiscoverSensors}
                      disabled={isSensorDiscovering}
                      className="rounded-lg bg-cyan-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      {isSensorDiscovering ? 'Discovering…' : 'Discover sensors'}
                    </button>
                  </div>
                  <p role="status" aria-live="polite" className="mt-2 text-[10px] text-slate-700">
                    {sensorOperationStatus || 'Run discovery to check each source independently.'}
                  </p>
                  {sensorDiagnostics && (
                    <div className="mt-2 space-y-2">
                      <div className="rounded-lg border border-cyan-100 bg-white p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-slate-800">MID-360</span>
                          <span className="text-[10px] text-slate-600">
                            {sensorDiagnostics.lidar?.discovery?.connection?.method || 'unknown'}
                            {' · '}
                            {sensorDiagnostics.lidar?.calibration?.status || 'unverified'}
                          </span>
                        </div>
                        <p className="mt-1 text-[10px] text-slate-600">
                          {sensorDiagnostics.lidar?.calibration?.reason
                            || sensorDiagnostics.lidar?.discovery?.connection?.reason
                            || 'No LiDAR diagnostic reported.'}
                        </p>
                        {sensorDiagnostics.lidar?.calibration?.candidate_mounts?.mid360?.available && (
                          <p className="mt-1 text-[10px] text-amber-700">
                            Unverified model mount candidate ({sensorDiagnostics.lidar.calibration.candidate_mounts.mid360.parent_frame} → {sensorDiagnostics.lidar.calibration.candidate_mounts.mid360.sensor_frame}): {sensorDiagnostics.lidar.calibration.candidate_mounts.mid360.translation_m.map((value) => Number(value).toFixed(3)).join(', ')} m
                          </p>
                        )}
                        <p className="mt-1 text-[10px] text-slate-600">
                          Forward distance: {sensorDiagnostics.lidar?.distance?.ready ? 'ready' : sensorDiagnostics.lidar?.distance?.error || 'unavailable'}
                          {' · '}
                          Rear distance: {sensorDiagnostics.lidar?.distance?.rear?.ready ? 'ready' : sensorDiagnostics.lidar?.distance?.rear?.error || 'unavailable'}
                        </p>
                        {['direct_livox', 'existing_driver'].includes(
                          sensorDiagnostics.lidar?.discovery?.connection?.method,
                        ) && (
                          <button
                            type="button"
                            onClick={() => handleSensorServiceOperation('lidar_driver', 'repair')}
                            disabled={Boolean(sensorOperationBusy)}
                            className="mt-2 rounded-md border border-cyan-300 bg-white px-2 py-1 text-[10px] font-semibold text-cyan-900 disabled:opacity-50"
                          >
                            {sensorOperationBusy === 'lidar_driver:repair' ? 'Repairing…' : 'Restart managed LiDAR driver'}
                          </button>
                        )}
                      </div>
                      {Object.entries(sensorDiagnostics.cameras?.sources || {}).map(([sourceId, source]) => {
                        return (
                          <div key={sourceId} className="rounded-lg border border-cyan-100 bg-white p-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-slate-800">
                                {sourceId === 'unitree' ? 'Unitree camera' : 'USB RealSense'}
                              </span>
                              <span className={`text-[10px] ${source.ready ? 'text-emerald-700' : 'text-amber-700'}`}>
                                {source.status}
                              </span>
                            </div>
                            <p className="mt-1 text-[10px] text-slate-600">{source.reason}</p>
                            {[...(source.image_topics || []), ...(source.camera_info_topics || [])].map((topic) => (
                              <p key={`${topic.name}:${topic.type}`} className="mt-1 break-all text-[10px] text-slate-500">
                                {topic.name} · {topic.type}
                                {topic.frame_id ? ` · frame ${topic.frame_id}` : ''}
                                {topic.age_ms != null ? ` · ${Math.round(topic.age_ms)} ms old` : ''}
                              </p>
                            ))}
                            {source.intrinsics && (
                              <p className="mt-1 text-[10px] text-slate-500">
                                Intrinsics: fx {source.intrinsics.fx_px}, fy {source.intrinsics.fy_px}, cx {source.intrinsics.cx_px}, cy {source.intrinsics.cy_px} px
                              </p>
                            )}
                            {source.devices?.map((device) => (
                              <p key={device.usb_path} className="mt-1 text-[10px] text-slate-500">
                                {device.product || device.usb_path}
                                {device.serial ? ` · serial ${device.serial}` : ''}
                              </p>
                            ))}
                          </div>
                        );
                      })}
                      {(sensorDiagnostics.lidar?.discovery?.diagnostics || []).map((diagnostic) => (
                        <p key={diagnostic} className="break-words text-[10px] text-amber-800">{diagnostic}</p>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-[9px] text-slate-500">
                    Camera frames are transient only. No video is recorded or saved. Registered LiDAR-camera fusion requires verified transforms and time alignment.
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[10px] uppercase tracking-wide text-slate-600 font-semibold">Manage classroom accounts</p>
                  <form onSubmit={handleCreateStudent} className="mt-2 space-y-2 rounded-lg border border-blue-100 bg-white p-2">
                    <label className="block text-xs font-medium text-slate-700">
                      Account type
                      <select
                        value={newStudent.role}
                        onChange={(event) => setNewStudent({ ...newStudent, role: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                      >
                        <option value="student">Student</option>
                        <option value="teacher">Teacher</option>
                      </select>
                    </label>
                    <label className="block text-xs font-medium text-slate-700">
                      New {newStudent.role} username
                      <input
                        type="text"
                        value={newStudent.username}
                        onChange={(event) => setNewStudent({ ...newStudent, username: event.target.value })}
                        minLength={3}
                        maxLength={32}
                        pattern="[A-Za-z0-9_-]{3,32}"
                        autoComplete="off"
                        required
                        className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                        placeholder="student24"
                      />
                    </label>
                    <label className="block text-xs font-medium text-slate-700">
                      Initial password
                      <input
                        type="password"
                        value={newStudent.password}
                        onChange={(event) => setNewStudent({ ...newStudent, password: event.target.value })}
                        minLength={8}
                        maxLength={128}
                        autoComplete="new-password"
                        required
                        className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                      />
                    </label>
                    <p className="text-[10px] text-slate-500">Username: 3–32 letters, numbers, _ or -. Password: 8–128 characters.</p>
                    <button
                      type="submit"
                      disabled={isCreatingStudent}
                      className="w-full rounded-lg bg-blue-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      {isCreatingStudent ? 'Creating…' : `Create ${newStudent.role} account`}
                    </button>
                  </form>
                  {accountManagementError && (
                    <p role="alert" className="mt-2 text-xs text-red-700">{accountManagementError}</p>
                  )}
                  <div className="mt-2 space-y-2">
                    {teacherRoster.length === 0 ? (
                      <p className="text-xs text-slate-500">No classroom accounts found.</p>
                    ) : teacherRoster.map((user) => (
                      <div key={user.username} className="flex items-center justify-between rounded-lg bg-white border border-slate-200 px-2 py-1.5">
                        <span className="min-w-0 truncate text-sm text-slate-700">{user.username}</span>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-[10px] uppercase rounded-full bg-slate-100 text-slate-600 px-2 py-1">{user.role}</span>
                          {user.username !== currentUser.username && (
                            <button
                              type="button"
                              onClick={() => handleDeleteUser(user.username)}
                              disabled={deletingUsername === user.username}
                              aria-label={`Delete account ${user.username}`}
                              className="rounded px-2 py-1 text-[10px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                            >
                              {deletingUsername === user.username ? 'Deleting…' : 'Delete'}
                            </button>
                          )}
                        </div>
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
                    <p className="text-xs text-slate-500 mt-1">
                      by {item.student} • {item.controller_version === 'duet' ? 'DUET v2' : 'legacy SDK'}
                    </p>
                    {item.planner_request && (
                      <p className="mt-1 text-[10px] font-semibold text-cyan-800">
                        Planner request • {PLANNER_MODE_LABELS[item.planner_request.planner_mode] || item.planner_request.planner_mode}
                        {item.planner_request.navigation
                          ? ` • ${item.planner_request.navigation.waypoints.length} Nav2 goal(s) • map ${item.planner_request.navigation.map_id} ${item.planner_request.navigation.version}`
                          : ` • ${(item.planner_request.planner_waypoints || []).length} grid waypoint(s)`}
                      </p>
                    )}
                    <details className="mt-2 rounded-md bg-slate-50 p-2">
                      <summary className="cursor-pointer text-[10px] font-semibold text-blue-700">
                        Review exact command preview
                      </summary>
                      <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-900 p-2 text-[10px] text-slate-100">
                        {item.code || '(No SDK/DUET commands yet; review the requested planner goals below.)'}
                      </pre>
                      {item.planner_request && (
                        <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-100 p-2 text-[10px] text-slate-700">
                          {JSON.stringify(item.planner_request, null, 2)}
                        </pre>
                      )}
                    </details>
                    <button
                      type="button"
                      onClick={() => handleLoadQueueItemForReview(item)}
                      className="mt-2 rounded-md border border-blue-200 px-2 py-1 text-[10px] font-semibold text-blue-700 hover:bg-blue-50"
                    >
                      Review request
                    </button>
                    <button onClick={() => handleDeleteQueueItem(item.id)} className="mt-2 text-xs text-red-600 hover:text-red-700">Delete</button>
                  </div>
                ))}

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[10px] uppercase tracking-wide text-slate-600 font-semibold">Shared project library</p>
                  <div className="mt-2 space-y-2">
                    {projectLibrary.length === 0 ? (
                      <p className="text-xs text-slate-500">No saved projects yet.</p>
                    ) : projectLibrary.map((project) => (
                      <div key={`${project.username}-${project.name}`} className="rounded-lg border border-slate-200 bg-white p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-slate-800">{project.name}</span>
                          <div className="flex shrink-0 items-center gap-1">
                            {project.plannerMode && <span className="text-[9px] uppercase rounded-full bg-cyan-100 text-cyan-800 px-2 py-1">{PLANNER_MODE_LABELS[project.plannerMode] || project.plannerMode}</span>}
                            <span className="text-[10px] uppercase rounded-full bg-slate-100 text-slate-600 px-2 py-1">{project.username}</span>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3">
                          <button type="button" onClick={() => loadProjectFromLibrary(project)} className="text-xs text-blue-600 hover:text-blue-700">Open project</button>
                          <button type="button" onClick={() => handleRenameProject(project)} className="text-xs text-slate-600 hover:text-slate-900">Rename</button>
                          <button type="button" onClick={() => handleDeleteProject(project)} className="text-xs text-red-600 hover:text-red-700">Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[10px] uppercase tracking-wide text-slate-600 font-semibold">Shared project library</p>
                  <div className="mt-2 space-y-2">
                    {projectLibrary.length === 0 ? (
                      <p className="text-xs text-slate-500">No saved projects yet.</p>
                    ) : projectLibrary.map((project) => (
                      <div key={`${project.username}-${project.name}`} className="rounded-lg border border-slate-200 bg-white p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-medium text-slate-800">{project.name}</span>
                          <div className="flex shrink-0 items-center gap-1">
                            {project.plannerMode && <span className="text-[9px] uppercase rounded-full bg-cyan-100 text-cyan-800 px-2 py-1">{PLANNER_MODE_LABELS[project.plannerMode] || project.plannerMode}</span>}
                            <span className="text-[10px] uppercase rounded-full bg-slate-100 text-slate-600 px-2 py-1">{project.username}</span>
                          </div>
                        </div>
                        <button type="button" onClick={() => loadProjectFromLibrary(project)} className="mt-2 text-xs text-blue-600 hover:text-blue-700">Open project</button>
                      </div>
                    ))}
                  </div>
                </div>
                {savedCodes.length === 0 ? <p className="text-sm text-slate-500">No saved code yet.</p> : savedCodes.map((code) => (
                  <div key={code.name} className="rounded-lg border border-slate-200 p-2">
                    <p className="font-medium text-slate-800 text-sm">{code.name}</p>
                    <p className="text-xs text-slate-500 mt-1">{code.code.slice(0, 60)}{code.code.length > 60 ? '...' : ''}</p>
                    <button type="button" onClick={() => updateGeneratedCode(code.code)} className="mt-2 text-xs text-blue-600 hover:text-blue-700">Load</button>
                  </div>
                ))}
              </>
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
                    <div
                      key={obstacle.id}
                      onClick={() => setSelectedSceneObjectId(obstacle.id)}
                      className={`rounded-lg border p-2 ${selectedSceneObjectId === obstacle.id ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-200' : 'border-slate-200 bg-slate-50'}`}
                    >
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
                      <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-slate-600">
                        {Object.entries(getSceneObjectDimensions(obstacle)).map(([dimension, value]) => (
                          <label key={dimension}>
                            {dimension === 'width' ? 'Width (m)' : dimension === 'height' ? 'Height (m)' : 'Depth (m)'}
                            <input
                              type="number"
                              value={value}
                              min="0.1"
                              max="8"
                              step="0.1"
                              onChange={(event) => updateStudentObstacle(obstacle.id, {
                                dimensions: {
                                  ...getSceneObjectDimensions(obstacle),
                                  [dimension]: Math.min(8, Math.max(0.1, Number(event.target.value))),
                                },
                              })}
                              className="mt-1 w-full rounded border border-slate-200 bg-white px-1 py-1"
                            />
                          </label>
                        ))}
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
                      <path d={`M ${sceneScale} 0 L 0 0 0 ${sceneScale}`} fill="none" stroke="#dfe7f3" strokeWidth="0.25"/>
                  </pattern>
                </defs>
                <rect x="0" y="0" width="220" height="220" fill="url(#grid-pattern)" rx="12"/>
                {sharedLidarOverlayEnabled && sharedLidarMap?.map?.map && (
                  <g pointerEvents="none">
                    <path
                      data-testid="shared-lidar-grid-overlay"
                      d={sharedGridOverlayPath}
                      fill="#ef4444"
                      fillOpacity="0.24"
                      stroke="#b91c1c"
                      strokeOpacity="0.35"
                      strokeWidth="0.35"
                    />
                    <g data-testid="shared-lidar-pointcloud-overlay">
                      {sharedPointCloudPreview.map((point, index) => (
                        <circle
                          key={`${index}-${point.x}-${point.y}`}
                          cx={sceneX(point.x)}
                          cy={sceneY(point.y)}
                          r={Math.max(0.45, Math.min(1.4, sceneScale * 0.025))}
                          fill={point.z < 0.25 ? '#2563eb' : point.z < 1.2 ? '#16a34a' : point.z < 2.2 ? '#f59e0b' : '#a855f7'}
                          fillOpacity="0.72"
                        />
                      ))}
                    </g>
                  </g>
                )}
                {session?.user?.role === 'teacher' && lidarScanJob?.status === 'scanning' && (
                  <g data-testid="live-lidar-scan-preview" pointerEvents="none">
                    {liveLidarScanPoints.map((point, index) => (
                      <circle
                        key={`live-${index}-${point.x}-${point.y}`}
                        cx={sceneX(point.x)}
                        cy={sceneY(point.y)}
                        r={Math.max(0.5, Math.min(1.5, sceneScale * 0.03))}
                        fill={point.z < 0.25 ? '#2563eb' : point.z < 1.2 ? '#16a34a' : point.z < 2.2 ? '#f59e0b' : '#a855f7'}
                        fillOpacity="0.8"
                      />
                    ))}
                  </g>
                )}
                {activeObstacles.map((obstacle) => {
                  const isStudentObstacle = String(obstacle.id).startsWith('student-');
                  const isDragging = activeDragItem?.kind === 'obstacle' && activeDragItem.id === obstacle.id;
                  const color = obstacle.color || (isStudentObstacle ? '#a78bfa' : '#fbbf24');
                  const centerX = sceneX(obstacle.x);
                  const centerY = sceneY(obstacle.y);
                  const size = (obstacle.radius / 12) * sceneScale;
                  const dimensions = getSceneObjectDimensions(obstacle);
                  const baseDimensions = getSceneObjectBaseDimensions(obstacle.type, obstacle.radius);
                  const objectScaleX = dimensions.width / baseDimensions.width;
                  const objectScaleY = dimensions.depth / baseDimensions.depth;
                  return (
                    <g key={obstacle.id} onPointerDown={(event) => handleObstaclePointerDown(event, obstacle.id)} style={{ cursor: isDragging ? 'grabbing' : 'grab' }}>
                      <g data-obstacle-type={obstacle.type || 'unknown'}>
                      {(isDragging || selectedSceneObjectId === obstacle.id) && <circle cx={centerX} cy={centerY} r={size + 4} fill="none" stroke="#0891b2" strokeWidth="2" strokeDasharray="4 2" />}
                      <g transform={`translate(${centerX} ${centerY}) scale(${objectScaleX} ${objectScaleY}) translate(${-centerX} ${-centerY})`}>
                      <SceneObstacleShape
                        obstacle={obstacle}
                        centerX={centerX}
                        centerY={centerY}
                        size={size}
                        color={color}
                        opacity={isStudentObstacle ? 0.45 : 0.35}
                        stroke={isStudentObstacle ? '#7c3aed' : '#f59e0b'}
                        strokeWidth={2.5}
                        strokeDasharray="0"
                      />
                      </g>
                      <text x={centerX} y={centerY + 4} textAnchor="middle" fontSize="8" fill="#fff">drag</text>
                      </g>
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
          controllerVersion={controllerVersion}
          obstacles={activeObstacles}
          waypoints={plannerWaypoints}
          isWaypointPlacementEnabled={isWaypointPlacementEnabled}
          onObstacleSelect={selectSceneObject}
          onObstacleChange={updateStudentObstacle}
          onWaypointChange={updatePlannerWaypoint}
          onWaypointPlace={placePlannerWaypoint}
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
          className="absolute z-40 flex flex-col overflow-visible rounded-xl border border-slate-700 bg-slate-950/90 shadow-[0_0_30px_rgba(15,23,42,0.5)] backdrop-blur-sm"
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
                    <button
                      type="button"
                      onClick={handleRunCode}
                      disabled={lidarScanJob?.status === 'scanning' && !isRunning}
                      className="rounded-md bg-amber-500 px-2 py-2 text-[10px] font-bold text-slate-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                      title={lidarScanJob?.status === 'scanning' ? 'SDK motion is locked while the LiDAR room scan is capturing' : isRunning ? 'Stops locomotion; cannot cancel an active arm preset' : 'Run code on connected robot'}
                    >
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
                <div className={`${mainTab === 'blocks' ? '' : 'hidden'} space-y-3 text-slate-200`}>
                    <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
                        {controllerVersion === 'duet' ? 'Workspace • DUET version two' : 'Workspace'}
                      </p>
                      <div className="mt-3 flex gap-2">
                        <button type="button" onClick={handleRunSimulation} className="flex-1 rounded-md bg-emerald-600 px-2 py-2 text-xs font-semibold text-white hover:bg-emerald-500">Run simulation</button>
                        {currentUser.role === 'teacher' && (
                          <button
                            type="button"
                            onClick={handleRunCode}
                            disabled={(!isRobotConnected && !isRunning) || (lidarScanJob?.status === 'scanning' && !isRunning)}
                            title={lidarScanJob?.status === 'scanning' ? 'SDK motion is locked while the LiDAR room scan is capturing' : isRunning ? 'Stops locomotion; cannot cancel an active arm preset' : isRobotConnected ? 'Send this program to the connected G1' : 'Connect the G1 SDK before sending commands'}
                            className="flex-1 rounded-md bg-amber-500 px-2 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {isRunning ? 'Stop robot' : 'Send to robot'}
                          </button>
                        )}
                        <button type="button" onClick={handleClear} className="flex-1 rounded-md bg-slate-700 px-2 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-600">Clear</button>
                      </div>
                      {currentUser.role === 'teacher' && (
                        <p className="mt-2 text-[10px] text-slate-400" role="status" aria-live="polite">
                          {lidarScanJob?.status === 'scanning'
                            ? 'SDK motion is locked while the room scan captures data.'
                            : isRunning ? 'Sending/running program on the G1…' : isRobotConnected ? 'G1 connected and ready for a program.' : 'Connect the G1 SDK before sending a physical run.'}
                        </p>
                      )}
                    </div>
                    <div className="relative h-[min(680px,calc(100vh-16rem))] min-h-[420px] overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
                      <div ref={blocklyDiv} className="h-full w-full" />
                      {blockSyncError && (
                        <div className="pointer-events-auto absolute inset-0 z-[10000] flex items-center justify-center overflow-y-auto bg-slate-800 p-4" role="alert">
                          <div className="max-w-lg rounded-xl border border-amber-500/60 bg-amber-950 p-5 text-center shadow-xl">
                            <p className="text-sm font-semibold text-amber-200">This code cannot be represented with Blocks</p>
                            <p className="mt-2 text-xs leading-5 text-slate-200">{blockSyncError}</p>
                            <p className="mt-2 text-[10px] text-slate-400">Your IDE code is preserved. Edit the unsupported line in the IDE to restore block editing.</p>
                            <div className="mt-3 flex flex-wrap justify-center gap-2">
                              <button
                                type="button"
                                onClick={() => setMainTab('ide')}
                                className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                              >
                                Edit in IDE
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (window.confirm('Clear the unsupported code from the IDE and Blocks workspace?')) {
                                    applyGeneratedCode('', { syncBlocks: true });
                                    setBlockSyncError('');
                                  }
                                }}
                                className="rounded-md border border-amber-300/50 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-900"
                              >
                                Clear unsupported code
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                      {!blockSyncError && !generatedCode.trim() && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-900/90 p-4 text-center">
                          <p className="max-w-sm text-xs leading-5 text-slate-300">Choose a command from the toolbox to get started. Your blocks will appear here.</p>
                        </div>
                      )}
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Generated code</p>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-6 text-slate-200">
                        {generatedCode || '# Python code will appear here'}
                      </pre>
                    </div>
                    {originalPlannerCode && pathPlannerMode === PLANNER_PATH_MODES.sensor_corrected && (
                      <details open className="rounded-xl border border-amber-800 bg-amber-950/30 p-3">
                        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-amber-200">Original route · read only</summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-amber-100">{originalPlannerCode}</pre>
                      </details>
                    )}
                </div>

                {mainTab === 'planner' && (
                  <div className="space-y-3 text-slate-200">
                    {session?.user?.role === 'teacher' && (
                      <>
                        <p className="rounded-lg border border-amber-500/30 bg-amber-950/40 p-2 text-[10px] text-amber-200">
                          Compile remains the open-loop SDK path. Start Nav2 submits map-frame goals to the separate ROS controller and requires a commissioned gateway.
                        </p>
                    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">ROS navigation bridge</span>
                        {session?.user?.role === 'teacher' && (
                          <button
                            type="button"
                            onClick={handleCheckNavigationBridge}
                            disabled={isNavigationBridgeChecking}
                            className="rounded-md border border-cyan-700 px-2 py-1 text-[10px] font-semibold text-cyan-200 disabled:opacity-60"
                          >
                            {isNavigationBridgeChecking ? 'Checking…' : 'Check status'}
                          </button>
                        )}
                      </div>
                      <p role="status" aria-live="polite" className="break-words text-[10px] text-slate-400">
                        {navigationBridgeStatus}
                      </p>
                      {navigationDiagnostics && (
                        <div data-testid="navigation-diagnostics" className="space-y-1 break-words text-[10px] text-slate-400">
                          <p>
                            LiDAR {navigationDiagnostics.topics?.pointcloud || 'topic unavailable'}
                            {' • '}frame {navigationDiagnostics.frames?.pointcloud || 'unavailable'}
                            {' • '}{Number.isFinite(navigationDiagnostics.pointcloud?.rate_hz)
                              ? `${navigationDiagnostics.pointcloud.rate_hz.toFixed(1)} Hz measured`
                              : 'measured rate pending'}
                            {' • '}sample age {navigationDiagnostics.pointcloud?.age_ms ?? '—'} ms
                            {' • '}stamp age {navigationDiagnostics.pointcloud?.stamp_age_ms ?? '—'} ms
                            {' • '}callback {navigationDiagnostics.pointcloud?.callback_duration_ms ?? '—'} ms
                            {' • '}{navigationDiagnostics.pointcloud?.count ?? 0} valid clouds
                          </p>
                          <p>
                            Map {navigationDiagnostics.topics?.map || 'topic unavailable'}
                            {' • '}local costmap {navigationDiagnostics.topics?.local_costmap || 'topic unavailable'}
                            {' • '}frame {navigationDiagnostics.frames?.map || 'unavailable'}
                            {' • '}base {navigationDiagnostics.frames?.base || 'unavailable'}
                            {' • '}threshold {navigationDiagnostics.map?.occupied_threshold ?? '—'}
                            {navigationDiagnostics.map?.metadata && (
                              <>
                                {' • '}{navigationDiagnostics.map.metadata.resolution_m} m/cell
                                {' • '}origin {navigationDiagnostics.map.metadata.origin.x.toFixed(2)}, {navigationDiagnostics.map.metadata.origin.y.toFixed(2)} m
                                {' • '}map age {navigationDiagnostics.map.age_ms ?? '—'} ms
                              </>
                            )}
                          </p>
                          <p>
                            Live obstacle layer {navigationDiagnostics.local_costmap?.ready
                              ? `ready • ${navigationDiagnostics.local_costmap.obstacle_count ?? 0} points • ${navigationDiagnostics.local_costmap.age_ms ?? '—'} ms old`
                              : 'unavailable'}
                            {' • '}avoidance commissioning {navigationDiagnostics.local_costmap?.live_avoidance_enabled ? 'enabled' : 'not enabled'}
                          </p>
                          <p>
                            Localization {navigationDiagnostics.localization?.quality || 'unavailable'}
                            {' • '}actions Nav2 {navigationDiagnostics.actions?.navigation ? 'ready' : 'unavailable'},
                            {' '}preview {navigationDiagnostics.actions?.route_preview ? 'ready' : 'unavailable'},
                            {' '}Spin {navigationDiagnostics.actions?.spin ? 'ready' : 'unavailable'}
                            {' • '}locomotion owner {navigationDiagnostics.controller?.owner || 'unverified'}
                            {' • '}{navigationDiagnostics.controller?.ready ? 'commissioned' : 'not commissioned; motion locked'}
                            {' • '}execution {navigationDiagnostics.execution_enabled ? 'enabled' : 'deployment-disabled'}
                          </p>
                        </div>
                      )}
                      {session && (
                        <div className="space-y-2">
                        <div className="flex flex-wrap gap-2" role="group" aria-label="Path planner mode">
                          <button
                            type="button"
                            aria-pressed={navigationPlannerMode === 'static'}
                            onClick={() => handleNavigationPlannerModeChange('static')}
                            className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${navigationPlannerMode === 'static' ? 'border-cyan-500 bg-cyan-950 text-cyan-100' : 'border-slate-600 text-slate-300'}`}
                          >
                            Static 360° map
                          </button>
                          <button
                            type="button"
                            aria-pressed={navigationPlannerMode === 'live'}
                            onClick={() => handleNavigationPlannerModeChange('live')}
                            className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${navigationPlannerMode === 'live' ? 'border-emerald-500 bg-emerald-950 text-emerald-100' : 'border-slate-600 text-slate-300'}`}
                          >
                            Live adaptive
                          </button>
                        </div>
                        <p className="text-[10px] text-slate-400">
                          {navigationPlannerMode === 'live'
                            ? 'Live adaptive keeps destinations fixed in map-frame coordinates, shows fresh Nav2 local-costmap obstacles, and relies on the commissioned Nav2 controller to adjust motion around them.'
                            : 'Static planning uses the teacher-published 360° scan image. Waypoints are checked against both that saved map and the current live map before Nav2 may move.'}
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleLoadNavigationMap}
                            disabled={isNavigationMapLoading}
                            className="rounded-md border border-slate-600 px-2 py-1 text-[10px] font-semibold text-slate-200 disabled:opacity-60"
                          >
                            {isNavigationMapLoading
                              ? 'Loading map…'
                              : navigationPlannerMode === 'static'
                                ? 'Load static 360° map'
                                : 'Load live occupancy map'}
                          </button>
                          {navigationMapSnapshot && (
                            <button
                              type="button"
                              onClick={() => setIsNavigationMapVisible((visible) => !visible)}
                              className="rounded-md border border-slate-600 px-2 py-1 text-[10px] font-semibold text-slate-200"
                            >
                              {isNavigationMapVisible ? 'Hide overlay' : 'Show overlay'}
                            </button>
                          )}
                        </div>
                        </div>
                      )}
                      <p className="break-words text-[10px] text-slate-400">{navigationMapStatus}</p>
                      <p className="text-[10px] text-amber-300">
                        Execution requires the separately installed Nav2 gateway, a healthy map/localization/controller, and an accessible physical emergency stop.
                      </p>
                    </div>
                    <div className="space-y-2 rounded-lg border border-cyan-800 bg-slate-900 p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-cyan-200">3D room scan</span>
                        {session?.user?.role === 'teacher' && (
                          <div className="flex flex-wrap gap-2">
                            {!lidarScanJob || ['completed', 'failed', 'canceled'].includes(lidarScanJob.status) ? (
                              <button
                                type="button"
                                onClick={handleStartLidarScan}
                                disabled={isLidarScanStarting}
                                className="rounded-md bg-cyan-700 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-50"
                              >
                                {isLidarScanStarting ? 'Starting…' : 'Start supervised 360° scan'}
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={handleCompleteLidarScan}
                                  disabled={isLidarScanFinalizing || lidarScanJob?.rotation_status !== 'completed'}
                                  className="rounded-md bg-amber-500 px-2 py-1 text-[10px] font-semibold text-slate-950 disabled:opacity-50"
                                >
                                  {isLidarScanFinalizing ? 'Validating…' : lidarScanJob?.rotation_status === 'completed' ? 'Validate 360° scan' : 'Waiting for 360° rotation'}
                                </button>
                                <button
                                  type="button"
                                  onClick={handleCancelLidarScan}
                                  disabled={isLidarScanFinalizing}
                                  className="rounded-md border border-red-700 px-2 py-1 text-[10px] font-semibold text-red-200 disabled:opacity-50"
                                >
                                  Cancel scan
                                </button>
                              </>
                            )}
                            {lidarScanJob?.status === 'completed' && (
                              <button
                                type="button"
                                onClick={handlePublishLidarMap}
                                className="rounded-md border border-emerald-600 px-2 py-1 text-[10px] font-semibold text-emerald-200"
                              >
                                Publish shared map
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      <p role="status" aria-live="polite" className="break-words text-[10px] text-slate-300">{lidarScanStatus}</p>
                      <p className="text-[10px] leading-4 text-amber-200">
                        The teacher-started scan uses Nav2’s commissioned Spin behavior and the existing G1 velocity bridge. It requires fresh LiDAR, localization, and SLAM map data. Keep the rotation area clear, supervise continuously, and keep the independent emergency stop ready. A failed or incomplete rotation cannot be published.
                      </p>
                      <p className="text-[10px] text-slate-400">{navigationLiveStatus}</p>
                    </div>
                      </>
                    )}
                    {session?.user?.role === 'teacher' && (
                    <div className="space-y-2 rounded-lg border border-cyan-800 bg-slate-900 p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-cyan-200">Shared LiDAR map</span>
                        {session?.user?.role === 'teacher' && (
                          <button
                            type="button"
                            onClick={handleRefreshSharedLidarMap}
                            disabled={isSharedLidarMapLoading}
                            className="rounded-md border border-slate-600 px-2 py-1 text-[10px] font-semibold text-slate-200 disabled:opacity-60"
                          >
                            {isSharedLidarMapLoading ? 'Refreshing…' : 'Refresh shared map'}
                          </button>
                        )}
                      </div>
                      {session?.user?.role === 'teacher' ? (
                        <label className="flex items-center justify-between gap-2 text-[10px] font-semibold text-slate-200">
                          <span>Show shared map on student grids</span>
                          <input
                            type="checkbox"
                            aria-label="Show shared LiDAR map overlay"
                            checked={sharedLidarOverlayEnabled}
                            onChange={(event) => handleSharedLidarOverlayToggle(event.target.checked)}
                            className="h-4 w-4 accent-cyan-600"
                          />
                        </label>
                      ) : (
                        <p className="text-[10px] text-slate-300">
                          Teacher-managed student grid overlay: {sharedLidarOverlayEnabled ? 'enabled' : 'disabled'}.
                        </p>
                      )}
                      {sharedLidarOverlayEnabled && (
                        <p className="text-[10px] text-slate-400">
                          {sharedLidarMap?.map?.map
                            ? `${sharedLidarMap.map.map.width * sharedLidarMap.map.map.resolution_m} m × ${sharedLidarMap.map.map.height * sharedLidarMap.map.map.resolution_m} m • ${sharedLidarMap.map.map.resolution_m} m/cell`
                            : 'No shared room map is currently available.'}
                        </p>
                      )}
                      <p role="status" aria-live="polite" className="break-words text-[10px] text-slate-400">{navigationLiveStatus}</p>
                    </div>
                    )}
                    {session?.user?.role === 'teacher' && sharedLidarMap?.map?.map && (
                      <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900 p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-200">Published room map • 3D points projected to grid</span>
                          <span className="text-[10px] text-slate-400">
                            {sharedLidarMap.map.map.width * sharedLidarMap.map.map.resolution_m} m × {sharedLidarMap.map.map.height * sharedLidarMap.map.map.resolution_m} m • {sharedLidarMap.map.map.resolution_m} m/cell
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400">
                          Frame {sharedLidarMap.map.map.frame_id} • origin {sharedLidarMap.map.map.origin.x.toFixed(2)}, {sharedLidarMap.map.map.origin.y.toFixed(2)} m • {sharedLidarMap.pointcloud?.point_count || 0} 3D points
                        </p>
                        <svg
                          viewBox={`0 0 ${sharedLidarMap.map.map.width * sharedLidarMap.map.map.resolution_m} ${sharedLidarMap.map.map.height * sharedLidarMap.map.map.resolution_m}`}
                          role="img"
                          aria-label="Published shared occupancy map with 3D LiDAR points colored by height"
                          className="block max-h-72 w-full rounded-md bg-slate-100"
                        >
                          <rect
                            x="0"
                            y="0"
                            width={sharedLidarMap.map.map.width * sharedLidarMap.map.map.resolution_m}
                            height={sharedLidarMap.map.map.height * sharedLidarMap.map.map.resolution_m}
                            fill="#f8fafc"
                          />
                          <g transform={`translate(0 ${sharedLidarMap.map.map.height * sharedLidarMap.map.map.resolution_m}) scale(1 -1)`}>
                            <path d={sharedOccupiedCellsPath} fill="#ef4444" fillOpacity="0.45" />
                            {sharedPointCloudPreview.map((point, index) => (
                              <circle
                                key={`${index}-${point.x}-${point.y}`}
                                cx={point.mapX}
                                cy={point.mapY}
                                r={sharedLidarMap.map.map.resolution_m * 0.35}
                                fill={point.z < 0.25 ? '#2563eb' : point.z < 1.2 ? '#16a34a' : point.z < 2.2 ? '#f59e0b' : '#a855f7'}
                                fillOpacity="0.8"
                              />
                            ))}
                          </g>
                        </svg>
                        <p className="text-[10px] text-slate-400">Blue: low points • green/orange: room-height structure • purple: high points. Overlay positions use the map’s resolution, origin, rotation, and frame.</p>
                      </div>
                    )}
                    {isNavigationMapVisible && navigationMapSnapshot && (
                      <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-800 p-1">
                        <svg
                          viewBox={`0 0 ${navigationMapSnapshot.map.width * navigationMapSnapshot.map.resolution_m} ${navigationMapSnapshot.map.height * navigationMapSnapshot.map.resolution_m}`}
                          role="img"
                          aria-label="ROS occupancy map and navigation destinations"
                          onClick={handleNavigationMapClick}
                          className={`block max-h-80 w-full rounded-md bg-slate-100 ${isNavigationGoalPlacementEnabled ? 'cursor-crosshair' : ''}`}
                        >
                          <defs>
                            <pattern id="navigation-grid-pattern" width={navigationMapSnapshot.map.resolution_m} height={navigationMapSnapshot.map.resolution_m} patternUnits="userSpaceOnUse">
                              <path d={`M ${navigationMapSnapshot.map.resolution_m} 0 L 0 0 0 ${navigationMapSnapshot.map.resolution_m}`} fill="none" stroke="#dfe7f3" strokeWidth="0.004"/>
                            </pattern>
                          </defs>
                          <rect
                            x="0"
                            y="0"
                            width={navigationMapSnapshot.map.width * navigationMapSnapshot.map.resolution_m}
                            height={navigationMapSnapshot.map.height * navigationMapSnapshot.map.resolution_m}
                            fill="url(#navigation-grid-pattern)"
                          />
                          <g
                            ref={navigationMapCoordinatesRef}
                            data-testid="navigation-map-coordinate-layer"
                            transform={`translate(0 ${navigationMapSnapshot.map.height * navigationMapSnapshot.map.resolution_m}) scale(1 -1)`}
                            style={{ cursor: isNavigationGoalPlacementEnabled ? 'crosshair' : 'default' }}
                          >
                            <rect
                              x="0"
                              y="0"
                              width={navigationMapSnapshot.map.width * navigationMapSnapshot.map.resolution_m}
                              height={navigationMapSnapshot.map.height * navigationMapSnapshot.map.resolution_m}
                              fill="transparent"
                              pointerEvents="none"
                            />
                            <g
                            data-testid="ros-occupancy-overlay"
                            pointerEvents="none"
                            >
                              <path d={navigationOccupiedCellsPath} fill="#ef4444" fillOpacity="0.72" />
                            </g>
                            {navigationLiveObstaclePreview.length > 0 && (
                              <g data-testid="navigation-live-obstacles-overlay" pointerEvents="none">
                                {navigationLiveObstaclePreview.map((point, index) => (
                                  <circle
                                    key={`live-obstacle-${index}-${point.x}-${point.y}`}
                                    cx={point.mapX}
                                    cy={point.mapY}
                                    r={navigationMapSnapshot.map.resolution_m * 0.65}
                                    fill="#111827"
                                    fillOpacity="0.9"
                                  />
                                ))}
                              </g>
                            )}
                            {navigationLivePosePreview && (
                              <g data-testid="navigation-live-robot-pose" pointerEvents="none">
                                <circle
                                  cx={navigationLivePosePreview.x}
                                  cy={navigationLivePosePreview.y}
                                  r={navigationMapSnapshot.map.resolution_m * 2}
                                  fill="#06b6d4"
                                  stroke="#fff"
                                  strokeWidth={navigationMapSnapshot.map.resolution_m * 0.3}
                                />
                                <path
                                  d={`M${navigationLivePosePreview.x} ${navigationLivePosePreview.y}L${navigationLivePosePreview.x + Math.cos(navigationLivePosePreview.yaw_rad - navigationMapSnapshot.map.origin.yaw_rad) * navigationMapSnapshot.map.resolution_m * 5} ${navigationLivePosePreview.y + Math.sin(navigationLivePosePreview.yaw_rad - navigationMapSnapshot.map.origin.yaw_rad) * navigationMapSnapshot.map.resolution_m * 5}`}
                                  stroke="#0891b2"
                                  strokeWidth={navigationMapSnapshot.map.resolution_m * 0.6}
                                />
                              </g>
                            )}
                            {session?.user?.role === 'teacher' && lidarScanJob?.status === 'scanning' && (
                              <g data-testid="navigation-live-lidar-scan-overlay" pointerEvents="none">
                                {navigationLiveScanPreview.map((point, index) => (
                                  <circle
                                    key={`planner-scan-${index}-${point.x}-${point.y}`}
                                    cx={point.mapX}
                                    cy={point.mapY}
                                    r={navigationMapSnapshot.map.resolution_m * 0.35}
                                    fill={point.z < 0.25 ? '#2563eb' : point.z < 1.2 ? '#16a34a' : point.z < 2.2 ? '#f59e0b' : '#a855f7'}
                                    fillOpacity="0.85"
                                  />
                                ))}
                              </g>
                            )}
                            {navigationRoutePreviewPoints && (
                              <polyline
                                data-testid="navigation-route-preview"
                                points={navigationRoutePreviewPoints}
                                fill="none"
                                stroke="#059669"
                                strokeWidth={navigationMapSnapshot.map.resolution_m * 0.8}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                pointerEvents="none"
                              />
                            )}
                            {navigationRouteWaypoints.map((point, index) => {
                              const local = worldToMapLocal(
                                point.x, point.y, navigationMapSnapshot.map,
                              );
                              return (
                                <g key={point.id} pointerEvents="none">
                                  <circle
                                    data-testid={`navigation-waypoint-${index + 1}`}
                                    cx={local.x}
                                    cy={local.y}
                                    r={navigationMapSnapshot.map.resolution_m * 2}
                                    fill={isNavigationWaypointInFreeSpace(point, navigationMapSnapshot) ? '#2563eb' : '#dc2626'}
                                    stroke={isNavigationWaypointInFreeSpace(point, navigationMapSnapshot) ? '#fff' : '#fca5a5'}
                                    strokeWidth={navigationMapSnapshot.map.resolution_m * 0.15}
                                  />
                                  <text
                                    x={local.x}
                                    y={local.y}
                                    textAnchor="middle"
                                    dominantBaseline="central"
                                    fontSize={navigationMapSnapshot.map.resolution_m * 1.3}
                                    fill="#fff"
                                  >
                                    {index + 1}
                                  </text>
                                </g>
                              );
                            })}
                          </g>
                        </svg>
                      </div>
                    )}
                    {session && navigationMapSnapshot && (
                      <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900 p-2">
                        <p className="text-[10px] text-slate-300">
                          Add ordered goals by clicking the map. Their world/map coordinates stay fixed as live updates arrive; blocked goals are highlighted and rejected by the backend before motion.
                        </p>
                        {navigationPlannerMode === 'live' && (
                          <p role="status" className="text-[10px] text-emerald-200">
                            {isLiveAvoidanceReady
                              ? `Live local costmap • ${liveNavigationObstacles?.points?.length || 0} obstacle samples • ${liveNavigationObstacles?.age_ms ?? '—'} ms old • Nav2 adjusts motion using its commissioned local controller.`
                              : `Adaptive execution locked • ${liveNavigationObstacles?.error || 'fresh costmap and explicit Nav2 avoidance commissioning are required.'}`}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setIsNavigationGoalPlacementEnabled((enabled) => !enabled)}
                            disabled={Boolean(navigationOperation && ['accepted', 'starting', 'running', 'cancel_requested'].includes(navigationOperation.status))}
                            className={`rounded-md px-2 py-1 text-[10px] font-semibold ${isNavigationGoalPlacementEnabled ? 'bg-blue-600 text-white' : 'border border-slate-600 text-slate-200'} disabled:opacity-50`}
                          >
                            {isNavigationGoalPlacementEnabled ? 'Click map to add goals' : 'Add map goals'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              navigationRouteWaypointsRef.current = [];
                              setNavigationRouteWaypoints([]);
                              setNavigationRoutePreview(null);
                              setNavigationPreviewStatus('Destinations cleared');
                            }}
                            disabled={!navigationRouteWaypoints.length || Boolean(navigationOperation && ['accepted', 'starting', 'running', 'cancel_requested'].includes(navigationOperation.status))}
                            className="rounded-md border border-slate-600 px-2 py-1 text-[10px] text-slate-200 disabled:opacity-50"
                          >
                            Clear goals
                          </button>
                          <button
                            type="button"
                            onClick={handlePreviewNavigationRoute}
                            disabled={isNavigationPreviewing || !navigationRouteWaypoints.length || Boolean(navigationOperation && ['accepted', 'starting', 'running', 'cancel_requested'].includes(navigationOperation.status))}
                            className="rounded-md border border-emerald-700 px-2 py-1 text-[10px] font-semibold text-emerald-200 disabled:opacity-50"
                          >
                            {isNavigationPreviewing ? 'Planning…' : 'Preview route • no motion'}
                          </button>
                          {session?.user?.role === 'teacher' ? (
                            <button
                              type="button"
                              aria-label="Start Nav2"
                              onClick={handleStartNavigation}
                              disabled={isNavigationStarting || !isNavigationMotionReady || !navigationRouteWaypoints.length || !navigationRoutePreview || navigationRoutePreview.version !== navigationMapSnapshot.map.version || Boolean(navigationOperation && ['accepted', 'starting', 'running', 'cancel_requested'].includes(navigationOperation.status))}
                              className="rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-50"
                            >
                              {isNavigationStarting ? 'Starting…' : 'Approve & start Nav2'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={handleSubmitPlannerRequest}
                              disabled={!navigationRouteWaypoints.length || !navigationRoutePreview || navigationRoutePreview.version !== navigationMapSnapshot.map.version}
                              className="rounded-md border border-amber-600 px-2 py-1 text-[10px] font-semibold text-amber-200 disabled:opacity-50"
                            >
                              Send route to teacher for review
                            </button>
                          )}
                          {navigationOperation && ['accepted', 'starting', 'running', 'cancel_requested'].includes(navigationOperation.status) && (
                            <button
                              type="button"
                              onClick={handleStopNavigation}
                              className="rounded-md bg-red-600 px-2 py-1 text-[10px] font-semibold text-white"
                            >
                              Request stop
                            </button>
                          )}
                        </div>
                        <p role="status" aria-live="polite" data-testid="navigation-execution-status" className="break-words text-[10px] text-cyan-200">
                          {navigationExecutionStatus}
                        </p>
                        <p role="status" aria-live="polite" data-testid="navigation-preview-status" className="break-words text-[10px] text-emerald-200">
                          {navigationPreviewStatus}
                        </p>
                        {navigationRouteWaypoints.map((point, index) => (
                          <div key={point.id} className="flex items-center justify-between text-[10px] text-slate-400">
                            <span>Goal {index + 1}: {point.x.toFixed(2)}, {point.y.toFixed(2)} m ({navigationMapSnapshot.map.frame_id})</span>
                            <button
                              type="button"
                              onClick={() => {
                                const remaining = navigationRouteWaypointsRef.current.filter((item) => item.id !== point.id);
                                navigationRouteWaypointsRef.current = remaining;
                                setNavigationRouteWaypoints(remaining);
                                setNavigationRoutePreview(null);
                                setNavigationPreviewStatus('Destinations changed • preview the route again');
                              }}
                              disabled={Boolean(navigationOperation && ['accepted', 'starting', 'running', 'cancel_requested'].includes(navigationOperation.status))}
                              className="text-red-300 disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      {session?.user?.role === 'teacher' && (
                        <select
                          aria-label="Path planner mode"
                          value={pathPlannerMode}
                          onChange={(event) => handlePathPlannerModeChange(event.target.value)}
                          className="min-w-0 flex-1 rounded-md border border-slate-600 bg-slate-800 px-2 py-2 text-[10px] font-semibold text-slate-200"
                        >
                          {Object.entries(PLANNER_MODE_LABELS).map(([mode, label]) => (
                            <option key={mode} value={mode}>{label}</option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        aria-label="Place waypoint"
                        aria-pressed={isWaypointPlacementEnabled}
                        onClick={() => setIsWaypointPlacementEnabled((enabled) => !enabled)}
                        className={`flex-1 rounded-md px-2 py-2 text-[10px] font-semibold text-white ${isWaypointPlacementEnabled ? 'bg-cyan-600 hover:bg-cyan-500' : 'bg-blue-600 hover:bg-blue-500'}`}
                      >
                        {isWaypointPlacementEnabled ? 'Click grid to place' : 'Place waypoint'}
                      </button>
                      <button type="button" onClick={compilePlannerPath} className="flex-1 rounded-md bg-emerald-600 px-2 py-2 text-[10px] font-semibold text-white hover:bg-emerald-500">Compile</button>
                    </div>
                    {session && session.user.role !== 'teacher' && (
                      <button
                        type="button"
                        onClick={handleSubmitPlannerRequest}
                        className="w-full rounded-md border border-amber-600 bg-amber-950/40 px-2 py-2 text-[10px] font-semibold text-amber-200 hover:bg-amber-900/50"
                      >
                        Send {PLANNER_MODE_LABELS[pathPlannerMode]} request to teacher
                      </button>
                    )}
                    {session?.user?.role !== 'teacher' && (
                      <p className="text-[10px] text-slate-400">Teacher-selected mode: {PLANNER_MODE_LABELS[pathPlannerMode]}</p>
                    )}
                    {pathPlannerMode === PLANNER_PATH_MODES.sensor_corrected && session?.user?.role === 'teacher' && (
                      <button
                        type="button"
                        onClick={handleRunCheckpointedPlanner}
                        disabled={isRunning || !plannerRouteVariants.initial}
                        className="w-full rounded-md bg-amber-500 px-2 py-2 text-[10px] font-semibold text-slate-950 disabled:opacity-50"
                      >
                        {isRunning ? 'Running SDK path and checking waypoints…' : 'Run SDK path • checkpoint and correct'}
                      </button>
                    )}
                    {pathPlannerMode === PLANNER_PATH_MODES.autonomous && (
                      <p className="rounded-md border border-amber-700 bg-amber-950/40 p-2 text-[10px] text-amber-200">
                        Autonomous mode runs only from the teacher Nav2 map controls. The completed Nav2 feedback path—not the preview—is translated to SDK commands.
                      </p>
                    )}
                    {pathPlannerMode !== PLANNER_PATH_MODES.manual && (
                      <div className="space-y-1 rounded-md border border-slate-700 bg-slate-900 p-2">
                        <p className="text-[10px] uppercase tracking-wide text-slate-300">Compiled route variants</p>
                        <div className="flex flex-wrap gap-2">
                          {['initial', 'corrected', 'final'].filter((variant) => (
                            typeof plannerRouteVariants[variant] === 'string' && plannerRouteVariants[variant].length > 0
                          )).map((variant) => (
                            <button
                              key={variant}
                              type="button"
                              aria-pressed={selectedPlannerVariant === variant}
                              onClick={() => {
                                setSelectedPlannerVariant(variant);
                                const nextCode = plannerRouteVariants[variant];
                                if (nextCode) {
                                  compiledPlannerCodeRef.current = nextCode;
                                  updateGeneratedCode(nextCode);
                                }
                              }}
                              className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${selectedPlannerVariant === variant ? 'border-emerald-500 bg-emerald-950 text-emerald-100' : 'border-slate-600 text-slate-300'}`}
                            >
                              {variant === 'initial' ? 'Initial' : variant === 'corrected' ? 'Corrected' : 'Final'}
                            </button>
                          ))}
                        </div>
                        <p className="text-[10px] text-slate-400">
                          {pathPlannerMode === PLANNER_PATH_MODES.sensor_corrected
                            ? 'Initial is the compiled SDK plan. Corrected appears only after checkpointed SDK execution and contains the commands actually sent, including any measured corrections.'
                            : 'The autonomous SDK variant appears only after a successful Nav2 run with a valid localization feedback trace.'}
                        </p>
                      </div>
                    )}
                    {session?.user?.username && pathPlannerMode !== PLANNER_PATH_MODES.manual
                      && (plannerRouteVariants.corrected || plannerRouteVariants.final) && (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          value={plannerProjectLabel}
                          onChange={(event) => setPlannerProjectLabel(event.target.value)}
                          placeholder="Planner route label"
                          className="flex-1 rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-[10px] text-slate-100"
                        />
                        <button
                          type="button"
                          onClick={savePathPlannerProject}
                          className="rounded-md bg-slate-700 px-2 py-1 text-[10px] font-semibold text-white"
                        >
                          Save path project
                        </button>
                      </div>
                    )}
                    {isWaypointPlacementEnabled && (
                      <p className="rounded-lg border border-cyan-500/30 bg-cyan-950/50 p-2 text-xs text-cyan-200">
                        Click an open spot on the grid to place a waypoint, or click again to cancel.
                      </p>
                    )}
                    {plannerWaypoints.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-slate-600 bg-slate-900 p-3 text-xs text-slate-400">No waypoints yet.</p>
                    ) : (
                      plannerWaypoints.map((point, index) => (
                        <div key={point.id} className="rounded-lg border border-slate-700 bg-slate-900 p-2">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">Waypoint {index + 1}</span>
                            <button type="button" onClick={() => removePlannerWaypoint(point.id)} className="text-[10px] text-red-400">Delete</button>
                          </div>
                          {index > 0 && (
                            <p data-testid="waypoint-distance" className="mb-2 text-[10px] font-semibold text-cyan-300">
                              {Math.hypot(point.x - plannerWaypoints[index - 1].x, point.y - plannerWaypoints[index - 1].y).toFixed(2)} m from waypoint {index}
                            </p>
                          )}
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
                    {plannerWaypoints.length > 1 && (
                      <p data-testid="waypoint-total-distance" className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-xs font-semibold text-slate-200">
                        {plannerWaypoints.slice(1).reduce((total, point, index) => (
                          total + Math.hypot(
                            point.x - plannerWaypoints[index].x,
                            point.y - plannerWaypoints[index].y,
                          )
                        ), 0).toFixed(2)} m total
                      </p>
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
                        'Walk backward 2 steps and turn right 90 degrees',
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
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Camera preview</p>
                      <label className="mt-2 block text-xs text-slate-300">
                        Camera source
                        <select
                          value={cameraInputSource}
                          onChange={(event) => setCameraInputSource(event.target.value)}
                          className="mt-1 block w-full rounded-md border border-slate-600 bg-slate-800 px-2 py-2 text-xs text-white"
                        >
                          <option value="device">This device (private preview)</option>
                          <option value="unitree">G1 Unitree camera</option>
                          <option value="realsense">G1 USB RealSense</option>
                        </select>
                      </label>
                      {cameraInputSource === 'device' ? (
                        <>
                          <video
                            ref={deviceCameraVideoRef}
                            autoPlay
                            playsInline
                            muted
                            aria-label="Private live camera preview from this device"
                            className="mt-3 aspect-video w-full rounded-lg bg-black object-contain"
                          />
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <span role="status" aria-live="polite" className="text-[10px] text-slate-300">
                              {deviceCameraStatus}
                            </span>
                            <button
                              type="button"
                              onClick={isDeviceCameraActive ? stopDeviceCamera : startDeviceCamera}
                              disabled={deviceCameraStatus === 'Requesting camera permission…'}
                              className="shrink-0 rounded-md bg-cyan-600 px-2.5 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50"
                            >
                              {deviceCameraStatus === 'Requesting camera permission…'
                                ? 'Requesting…'
                                : isDeviceCameraActive ? 'Stop preview' : 'Start preview'}
                            </button>
                          </div>
                          {deviceCameraError && (
                            <p role="alert" className="mt-2 text-[10px] text-rose-300">{deviceCameraError}</p>
                          )}
                          <p className="mt-2 text-[10px] text-slate-400">
                            The preview stays in this browser tab. Frames are not sent to Uni-EDU-Studio, recorded, or saved. Safari requires HTTPS except on localhost.
                          </p>
                        </>
                      ) : (
                        (() => {
                          const sourceId = cameraInputSource === 'unitree' ? 'unitree' : 'realsense';
                          const source = sensorDiagnostics?.cameras?.sources?.[sourceId];
                          return (
                            <div className="mt-3 rounded-lg border border-slate-700 bg-slate-800 p-3">
                              <p className="text-xs font-semibold text-slate-200">
                                {source?.status || 'Not discovered'}
                              </p>
                              <p className="mt-1 text-[10px] text-slate-400">
                                {source?.reason || 'A teacher must run sensor discovery before this source can be diagnosed.'}
                              </p>
                              <p className="mt-2 text-[10px] text-amber-300">
                                ROS camera topics can be discovered, but this app does not yet provide a browser stream for the G1 camera.
                              </p>
                            </div>
                          );
                        })()
                      )}
                      <p className="mt-3 text-[10px] text-amber-300">
                        Camera-to-motion pose inference is not implemented. No pose is recognized or derived from these frames.
                      </p>
                    </div>
                    <div className="rounded-xl border border-amber-200/50 bg-amber-500/10 p-3 text-amber-100">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300">Example program</p>
                      <p className="mt-2 text-xs">This inserts a fixed example program; it does not use camera frames. Saving is a separate, explicit action.</p>
                      <button type="button" onClick={handleRecordMotionCapture} className="mt-3 w-full rounded-md bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500">Insert example program</button>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Quick actions</p>
                      <div className="mt-2 max-h-56 space-y-2 overflow-y-auto text-xs text-slate-200">
                        {(controllerVersion === 'duet'
                          ? getDuetCommandExamples().map(({ label, code }) => [label, code])
                          : [
                            ['Stand / Ready', 'robot.stand()'],
                            ['Walk Forward (3 steps)', 'robot.walk(3)'],
                            ['Turn Left (90°)', 'robot.turn("left", 90)'],
                            ['Hands Up arm preset', 'robot.arm_action("hands up")'],
                          ]).map(([label, code]) => (
                          <button
                            key={code}
                            type="button"
                            onClick={() => insertRobotCommand(code)}
                            className="block w-full rounded-md bg-slate-800 px-2 py-1.5 text-left hover:bg-slate-700"
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {mainTab === 'ide' && (
                  <div className="space-y-3 text-slate-200">
                    <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
                        {controllerVersion === 'duet' ? 'Executable DUET commands' : 'Executable robot commands'}
                      </p>
                      <div className="mt-2 max-h-56 space-y-2 overflow-y-auto text-[10px]">
                        {(controllerVersion === 'duet'
                          ? getDuetCommandExamples().map((example) => ({
                            ...example,
                            method: example.key,
                            description: example.label,
                            script: example.code,
                          }))
                          : G1_EXECUTABLE_COMMANDS).flatMap((command) => {
                          if (controllerVersion === 'duet') {
                            return [{
                              ...command,
                            }];
                          }
                          if (command.method === 'arm_action') {
                            return command.args[0].choices.map(([presetLabel, preset]) => ({
                              ...command,
                              key: `arm_action_${preset}`,
                              script: `robot.arm_action(${JSON.stringify(preset)})`,
                              label: `Arm preset: ${presetLabel.replace(/ \(\d+\)$/, '')}`,
                              description: G1_ARM_PRESET_DESCRIPTIONS[preset],
                            }));
                          }
                          const args = command.args.map((argument) => argument.kind === 'choice'
                            ? `"${argument.value}"`
                            : argument.kind === 'text'
                              ? JSON.stringify(argument.value)
                              : String(argument.value));
                          return [{
                            ...command,
                            key: command.method,
                            script: `robot.${command.method}(${args.join(', ')})`,
                            label: command.label,
                          }];
                        }).map((command) => (
                          <div key={command.key} className="rounded-md bg-slate-800 px-2 py-1.5">
                            <span className="block text-slate-200">{command.label}</span>
                            <code className="text-cyan-300">{command.script}</code>
                            <p className="mt-1 text-slate-400">{command.description}</p>
                            {controllerVersion === 'legacy' && command.sdkMethod
                              ? <p className="mt-1 text-emerald-300">Unitree SDK: {command.sdkMethod}</p>
                              : controllerVersion === 'legacy' && command.method === 'wait'
                                ? <p className="mt-1 text-emerald-300">Runs as a timed pause.</p>
                                : null}
                            {controllerVersion === 'legacy' && command.method === 'arm_action' && <p className="mt-1 text-amber-300">Stop cannot cancel an arm preset; keep the area clear.</p>}
                            {controllerVersion === 'legacy' && !command.adapters.simulator && <p className="mt-1 text-amber-300">Hardware only; not simulated.</p>}
                          </div>
                        ))}
                        <div className="rounded-md bg-slate-800 px-2 py-1.5">
                          <code className="text-cyan-300">for _ in range(3):</code>
                          <code className="block pl-3 text-cyan-300">{controllerVersion === 'duet' ? 'duet.move(0.15, 0, 0, 1)' : 'robot.walk(2)'}</code>
                          <p className="mt-1 text-slate-400">Repeat an indented group of commands.</p>
                        </div>
                      </div>
                    </div>
                    <textarea
                      value={generatedCode || ''}
                      onChange={(event) => {
                        const nextCode = event.target.value;
                        applyGeneratedCode(nextCode, { syncBlocks: false, preserveFormatting: true });
                        setBlockSyncError('');
                      }}
                      onBlur={() => syncBlocksFromGeneratedCode(generatedCodeRef.current)}
                      spellCheck={false}
                      className="h-64 w-full resize-none rounded-xl border border-slate-700 bg-slate-900 p-3 font-mono text-[11px] leading-6 text-slate-100 outline-none"
                    />
                    {blockSyncError && <p role="alert" className="text-xs text-amber-300">{blockSyncError}</p>}
                    {safetyNotice && <p className="text-[10px] text-amber-300">{safetyNotice}</p>}
                    <p className="text-[10px] text-slate-400">IDE text is synchronized to Blocks when you leave the editor. Incomplete or unsupported lines remain editable here but cannot be shown as Blocks.</p>
                    {originalPlannerCode && pathPlannerMode === PLANNER_PATH_MODES.sensor_corrected && (
                      <details open className="rounded-xl border border-amber-800 bg-amber-950/30 p-3">
                        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-amber-200">Original route · read only</summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-amber-100">{originalPlannerCode}</pre>
                      </details>
                    )}
                    {controllerVersion === 'duet'
                      ? <p className="text-[10px] text-amber-300">DUET supports bounded base-velocity commands, fixed carry/forward/box-hold arm poses and sequences built only from those poses, waits, and stop. These are not arbitrary joint targets; physical arm commands require the controller&apos;s separate DUET_ARM_ACCEPT gate. Simulator motion is a preview only.</p>
                      : <p className="text-[10px] text-slate-400">The IDE and Blocks support front-obstacle distance conditions. Physical conditions require a fresh MID-360 reading (500 ms maximum) from the configured provider; missing or stale readings abort and request a stop.</p>}
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
      {queueReviewItem && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/70 p-3 sm:p-6"
          role="presentation"
          onClick={() => {
            if (!isQueueReviewRunning && !queueReviewNavigationOperation) setQueueReviewItem(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="queue-review-title"
            className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-950 text-slate-100 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-start justify-between gap-4 border-b border-slate-800 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-300">Teacher approval required</p>
                <h2 id="queue-review-title" className="mt-1 truncate text-base font-semibold">{queueReviewItem.name}</h2>
                <p className="mt-1 text-xs text-slate-400">
                  Submitted by {queueReviewItem.student} · {queueReviewItem.controller_version === 'duet' ? 'DUET v2' : 'G1 SDK'} · {queueReviewItem.status}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setQueueReviewItem(null)}
                disabled={isQueueReviewRunning || Boolean(queueReviewNavigationOperation && !['completed', 'succeeded', 'canceled', 'failed'].includes(queueReviewNavigationOperation.status))}
                aria-label="Close request review"
                className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-40"
              >
                <X size={18} />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {queueReviewPlannerRequest && (
                <div className="rounded-md border border-cyan-900 bg-cyan-950/40 p-3">
                  <p className="text-xs font-semibold text-cyan-200">
                    {PLANNER_MODE_LABELS[queueReviewPlannerRequest.planner_mode] || queueReviewPlannerRequest.planner_mode}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-300">
                    {queueReviewPlannerRequest.planner_mode === PLANNER_PATH_MODES.autonomous
                      ? `${queueReviewPlannerRequest.navigation?.waypoints?.length || 0} map goals · ${queueReviewPlannerRequest.navigation?.map_id || 'map unavailable'} ${queueReviewPlannerRequest.navigation?.version || ''}`
                      : `${queueReviewWaypoints.length} planner-grid waypoints`}
                  </p>
                </div>
              )}

              <details open className="rounded-md border border-slate-800 bg-slate-900/70 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-slate-200">Exact command preview</summary>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-black/50 p-3 font-mono text-[11px] leading-5 text-emerald-200">
                  {queueReviewItem.code || '(No direct SDK commands; review planner goals and generated route data below.)'}
                </pre>
              </details>

              {queueReviewPlannerRequest && queueReviewPlannerRequest.planner_mode !== PLANNER_PATH_MODES.autonomous && (
                <section className="rounded-md border border-slate-800 bg-slate-900/70 p-3">
                  <h3 className="text-xs font-semibold text-slate-200">Submitted planner grid</h3>
                  {queueReviewWaypoints.length > 0 ? (
                    <svg viewBox="0 0 400 240" role="img" aria-label="Submitted planner waypoints" className="mt-2 h-48 w-full rounded bg-slate-950">
                      <path d="M 40 120 H 360 M 200 20 V 220" stroke="#334155" strokeWidth="1" />
                      {queueReviewWaypoints.length > 1 && (
                        <polyline
                          points={queueReviewWaypoints.map((point) => `${200 + Number(point.x) * 16},${120 - Number(point.y) * 10}`).join(' ')}
                          fill="none"
                          stroke="#22d3ee"
                          strokeWidth="3"
                        />
                      )}
                      {queueReviewWaypoints.map((point, index) => (
                        <g key={`${point.x}:${point.y}:${index}`}>
                          <circle cx={200 + Number(point.x) * 16} cy={120 - Number(point.y) * 10} r="7" fill={index === 0 ? '#34d399' : '#f59e0b'} />
                          <text x={208 + Number(point.x) * 16} y={116 - Number(point.y) * 10} fill="#e2e8f0" fontSize="10">{index + 1}</text>
                        </g>
                      ))}
                    </svg>
                  ) : <p className="mt-2 text-xs text-slate-400">No planner-grid waypoints were saved with this request.</p>}
                  <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 font-mono text-[10px] text-slate-300">
                    {JSON.stringify(queueReviewWaypoints, null, 2)}
                  </pre>
                </section>
              )}

              {queueReviewPlannerRequest?.planner_mode === PLANNER_PATH_MODES.autonomous && (
                <section className="rounded-md border border-slate-800 bg-slate-900/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold text-slate-200">Autonomous route preview</h3>
                    <button
                      type="button"
                      onClick={handlePreviewQueuedNavigation}
                      disabled={isQueueReviewPreviewing || isQueueReviewRunning}
                      className="rounded-md border border-emerald-700 px-2.5 py-1.5 text-[10px] font-semibold text-emerald-200 disabled:opacity-50"
                    >
                      {isQueueReviewPreviewing ? 'Planning…' : 'Preview route · no motion'}
                    </button>
                  </div>
                  <p className="mt-2 text-[10px] text-slate-400">
                    Map {queueReviewPlannerRequest.navigation?.map_id} · version {queueReviewPlannerRequest.navigation?.version} · frame {queueReviewPlannerRequest.navigation?.frame_id}
                  </p>
                  <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 font-mono text-[10px] text-slate-300">
                    {JSON.stringify(queueReviewPlannerRequest.navigation?.waypoints || [], null, 2)}
                  </pre>
                  {queueReviewNavigationPreview && (
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 font-mono text-[10px] text-cyan-200">
                      {JSON.stringify(queueReviewNavigationPreview.path || [], null, 2)}
                    </pre>
                  )}
                </section>
              )}

              <details open className="rounded-md border border-slate-800 bg-slate-900/70 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-slate-200">Complete submitted project state</summary>
                <dl className="mt-2 grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2">
                  <div><dt className="text-slate-500">Project name</dt><dd className="break-words text-slate-200">{queueReviewSnapshot.name || queueReviewPlannerRequest?.planner_label || queueReviewItem.name}</dd></div>
                  <div><dt className="text-slate-500">Planner mode</dt><dd className="text-slate-200">{PLANNER_MODE_LABELS[queueReviewSnapshot.plannerMode] || queueReviewSnapshot.plannerMode || queueReviewPlannerRequest?.planner_mode || 'Not set'}</dd></div>
                  <div><dt className="text-slate-500">Planner label</dt><dd className="break-words text-slate-200">{queueReviewSnapshot.plannerLabel || queueReviewPlannerRequest?.planner_label || 'Not set'}</dd></div>
                  <div><dt className="text-slate-500">Selected route variant</dt><dd className="text-slate-200">{queueReviewSnapshot.selectedPlannerVariant || queueReviewPlannerRequest?.selected_variant || 'Not set'}</dd></div>
                </dl>
                {[
                  ['Scene objects', queueReviewSnapshot.sceneObjects || []],
                  ['Saved planner waypoints', queueReviewSnapshot.plannerWaypoints || []],
                  ['Planner route variants', queueReviewSnapshot.plannerVariants || queueReviewPlannerRequest?.route_variants || {}],
                  ['Legacy generated code', queueReviewSnapshot.generatedCode || ''],
                  ['DUET generated code', queueReviewSnapshot.duetCode || ''],
                ].map(([label, value]) => (
                  <details key={label} open className="mt-2 rounded bg-black/30 p-2">
                    <summary className="cursor-pointer text-[10px] font-semibold text-slate-300">{label}</summary>
                    <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-slate-400">
                      {typeof value === 'string' ? value || '(empty)' : JSON.stringify(value, null, 2)}
                    </pre>
                  </details>
                ))}
              </details>

              {queueReviewError && <p role="alert" className="text-xs text-red-300">{queueReviewError}</p>}
              {queueReviewStatus && <p role="status" aria-live="polite" className="text-xs text-cyan-200">{queueReviewStatus}</p>}
              {queueReviewSavedProject && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-800 bg-emerald-950/40 p-3">
                  <p className="min-w-0 text-xs text-emerald-200">Saved project: {queueReviewSavedProject.name}</p>
                  <button
                    type="button"
                    onClick={() => {
                      loadProjectFromLibrary(queueReviewSavedProject);
                      setQueueReviewItem(null);
                    }}
                    className="rounded-md bg-emerald-700 px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-emerald-600"
                  >
                    Open project
                  </button>
                </div>
              )}
            </div>

            <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-800 px-4 py-3">
              {(isQueueReviewRunning || Boolean(queueReviewNavigationOperation && !['completed', 'succeeded', 'canceled', 'failed'].includes(queueReviewNavigationOperation.status))) && (
                <button
                  type="button"
                  onClick={handleStopQueuedExecution}
                  className="mr-auto rounded-md bg-red-700 px-3 py-2 text-xs font-semibold text-white hover:bg-red-600"
                >
                  Request stop
                </button>
              )}
              <button
                type="button"
                onClick={() => setQueueReviewItem(null)}
                disabled={isQueueReviewRunning || Boolean(queueReviewNavigationOperation && !['completed', 'succeeded', 'canceled', 'failed'].includes(queueReviewNavigationOperation.status))}
                className="rounded-md border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 disabled:opacity-50"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleApproveQueuedExecution}
                disabled={isQueueReviewRunning || queueReviewItem.status !== 'queued' || (queueReviewPlannerRequest?.planner_mode === PLANNER_PATH_MODES.autonomous && !queueReviewNavigationPreview)}
                className="rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isQueueReviewRunning ? 'Starting…' : 'Approve & run queued request'}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}