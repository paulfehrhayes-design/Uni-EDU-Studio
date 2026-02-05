import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Save, FolderOpen, Download, Settings, Play, Square,
  Code, X, RefreshCw, FileJson, Check, Loader2, Globe,
  Menu, Undo, Redo, Info, ChevronRight, Sidebar, MoreVertical,
  Upload, FileText, Edit3, FunctionSquare
} from 'lucide-react';

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
const DEFAULT_ROBOT_CONFIG_ZH = [
  {
    "category": "Unitree 基础",
    "colour": "230",
    "blocks": [
      {
        "type": "unitree_init",
        "message0": "初始化 Go2 机器人 %1 接口 %2",
        "args0": [{ "type": "input_dummy" }, { "type": "field_input", "name": "IFACE", "text": "eth0" }],
        "nextStatement": null, "colour": 230,
        "codeTemplate": "channel = ChannelFactory()\nclient = SportClient(channel)\nclient.SetTimeout(10.0)\nclient.Init()\nprint('Robot Initialized on {{IFACE}}')\ntime.sleep(1)\n"
      },
      {
        "type": "unitree_stand", "message0": "🤖 机器人 站立", "previousStatement": null, "nextStatement": null, "colour": 160,
        "codeTemplate": "client.StandUp()\nprint('Standing up...')\ntime.sleep(1)\n"
      },
      {
        "type": "unitree_rest", "message0": "💤 机器人 趴下/休息", "previousStatement": null, "nextStatement": null, "colour": 160,
        "codeTemplate": "client.StopMove()\nclient.RecoveryStand()\nprint('Resting...')\n"
      }
    ]
  },
  {
    "category": "Unitree 运动",
    "colour": "160",
    "blocks": [
      { "type": "unitree_move", "message0": "🏃 移动 速度 X: %1 Y: %2 转向: %3", "args0": [ { "type": "input_value", "name": "VEL_X", "check": "Number" }, { "type": "input_value", "name": "VEL_Y", "check": "Number" }, { "type": "input_value", "name": "YAW", "check": "Number" } ], "previousStatement": null, "nextStatement": null, "colour": 160, "codeTemplate": "client.Move({{VEL_X}}, {{VEL_Y}}, {{YAW}})\n" },
      { "type": "unitree_action", "message0": "✨ 执行特技 %1", "args0": [{ "type": "field_dropdown", "name": "ACTION", "options": [["打招呼", "1001"], ["作揖", "1002"], ["跳舞", "1003"], ["空翻", "1004"]] }], "previousStatement": null, "nextStatement": null, "colour": 290, "codeTemplate": "client.SwitchGait({{ACTION}})\ntime.sleep(2)\n" },
      { "type": "unitree_wait", "message0": "⏳ 等待 %1 秒", "args0": [{ "type": "field_number", "name": "SECONDS", "value": 1, "min": 0 }], "previousStatement": null, "nextStatement": null, "colour": 60, "codeTemplate": "time.sleep({{SECONDS}})\n" }
    ]
  }
];

const DEFAULT_ROBOT_CONFIG_EN = [
  {
    "category": "Robot Basic",
    "colour": "230",
    "blocks": [
      { "type": "unitree_init", "message0": "Init Go2 Robot %1 Interface %2", "args0": [{ "type": "input_dummy" }, { "type": "field_input", "name": "IFACE", "text": "eth0" }], "nextStatement": null, "colour": 230, "codeTemplate": "channel = ChannelFactory()\nclient = SportClient(channel)\nclient.SetTimeout(10.0)\nclient.Init()\nprint('Robot Initialized on {{IFACE}}')\ntime.sleep(1)\n" },
      { "type": "unitree_stand", "message0": "🤖 Robot Stand Up", "previousStatement": null, "nextStatement": null, "colour": 160, "codeTemplate": "client.StandUp()\nprint('Standing up...')\ntime.sleep(1)\n" },
      { "type": "unitree_rest", "message0": "💤 Robot Rest/Lie Down", "previousStatement": null, "nextStatement": null, "colour": 160, "codeTemplate": "client.StopMove()\nclient.RecoveryStand()\nprint('Resting...')\n" }
    ]
  },
  {
    "category": "Robot Motion",
    "colour": "160",
    "blocks": [
      { "type": "unitree_move", "message0": "🏃 Move Vel X: %1 Y: %2 Yaw: %3", "args0": [ { "type": "input_value", "name": "VEL_X", "check": "Number" }, { "type": "input_value", "name": "VEL_Y", "check": "Number" }, { "type": "input_value", "name": "YAW", "check": "Number" } ], "previousStatement": null, "nextStatement": null, "colour": 160, "codeTemplate": "client.Move({{VEL_X}}, {{VEL_Y}}, {{YAW}})\n" },
      { "type": "unitree_action", "message0": "✨ Perform Action %1", "args0": [{ "type": "field_dropdown", "name": "ACTION", "options": [["Hello", "1001"], ["Bow", "1002"], ["Dance1", "1003"], ["Flip", "1004"]] }], "previousStatement": null, "nextStatement": null, "colour": 290, "codeTemplate": "client.SwitchGait({{ACTION}})\ntime.sleep(2)\n" },
      { "type": "unitree_wait", "message0": "⏳ Wait %1 seconds", "args0": [{ "type": "field_number", "name": "SECONDS", "value": 1, "min": 0 }], "previousStatement": null, "nextStatement": null, "colour": 60, "codeTemplate": "time.sleep({{SECONDS}})\n" }
    ]
  }
];

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

export default function App() {
  const blocklyDiv = useRef(null);
  const workspaceRef = useRef(null);
  const promptInputRef = useRef(null);
  const codeEditorRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const fileInputRef = useRef(null);
  
  const [lang, setLang] = useState('zh'); 
  const [robotConfig, setRobotConfig] = useState(DEFAULT_ROBOT_CONFIG_ZH);
  const [generatedCode, setGeneratedCode] = useState("");
  const [configText, setConfigText] = useState(JSON.stringify(DEFAULT_ROBOT_CONFIG_ZH, null, 2));
  
  const [activeMenu, setActiveMenu] = useState(null);
  const [showConfigEditor, setShowConfigEditor] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [isCodeOpen, setIsCodeOpen] = useState(false);
  const [isBlocklyLoaded, setIsBlocklyLoaded] = useState(false);
  
  const [promptState, setPromptState] = useState({ isOpen: false, message: '', defaultValue: '', callback: null, inputValue: '' });
  const [codeEditorState, setCodeEditorState] = useState({ isOpen: false, blockId: null, code: '' });

  // 运行状态管理
  const [isRunning, setIsRunning] = useState(false);

  const t = UI_TEXT[lang];

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

  // --- CDN 加载逻辑 (复原) ---
  const loadBlocklyScript = useCallback(async (language) => {
    const loadScript = (src) => new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const script = document.createElement('script');
      script.src = src; 
      script.async = false;
      script.crossOrigin = "anonymous"; // 修复 Cross-Origin 错误
      script.onload = resolve; 
      script.onerror = reject;
      document.head.appendChild(script);
    });

    try {
      if (!window.Blockly) {
        // 使用指定的稳定版本，防止版本不兼容导致 field_multilinetext 丢失
        await loadScript('https://unpkg.com/blockly@11.1.1/blockly_compressed.js');
        await loadScript('https://unpkg.com/blockly@11.1.1/blocks_compressed.js');
        await loadScript('https://unpkg.com/blockly@11.1.1/python_compressed.js');
      }
      const langFile = language === 'zh' ? 'zh-hans.js' : 'en.js';
      await loadScript(`https://unpkg.com/blockly@11.1.1/msg/${langFile}`);
      
      // 修改 Blockly 内置消息
      if (window.Blockly) {
        window.Blockly.Msg["PROCEDURES_DEFNORETURN_TITLE"] = language === 'zh' ? "功能名称：" : "Function Name:";
        window.Blockly.Msg["PROCEDURES_DEFRETURN_TITLE"] = language === 'zh' ? "功能名称：" : "Function Name:";
      }

      setIsBlocklyLoaded(true);
    } catch (error) { console.error("Failed to load Blockly:", error); }
  }, []);

  useEffect(() => { loadBlocklyScript(lang); }, [lang, loadBlocklyScript]);

  const toggleLanguage = () => {
    const newLang = lang === 'zh' ? 'en' : 'zh';
    setLang(newLang);
    loadBlocklyScript(newLang).then(() => {
      const targetDefault = newLang === 'zh' ? DEFAULT_ROBOT_CONFIG_ZH : DEFAULT_ROBOT_CONFIG_EN;
      setConfigText(JSON.stringify(targetDefault, null, 2));
      setRobotConfig(targetDefault);
    });
  };

  const generateToolboxXML = useCallback((robotCategories, language) => {
    const cats = UI_TEXT[language].toolbox;
    const systemCategories = language === 'zh' ? SYSTEM_CONFIG_ZH : SYSTEM_CONFIG_EN;
    const fullCategories = [...systemCategories, ...robotCategories];

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
    if (!window.Blockly || !window.Blockly.Python) return;
    
    // 注册 Extension
    if (!window.Blockly.Extensions.isRegistered('custom_code_button')) {
      window.Blockly.Extensions.register('custom_code_button', function() {
        const block = this;
        let input = block.getInput('DUMMY') || block.getInput('BTN_DUMMY');
        if (!input) input = block.appendDummyInput('BTN_DUMMY');
        
        // 关键逻辑：初始化隐藏的 data 字段
        if (!block.data) {
           if (block.type === 'raw_code') block.data = "# Click edit icon";
           else if (block.type.includes('def')) block.data = "pass";
        }

        if (!block.getField('EDIT_BTN')) {
           const editBtn = new window.Blockly.FieldImage(
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
    const definitions = allBlocks.map(({ codeTemplate, extensions, ...rest }) => ({ ...rest, extensions: extensions || undefined }));
    window.Blockly.common.defineBlocksWithJsonArray(definitions);
    
    allBlocks.forEach(blockDef => {
      window.Blockly.Python.forBlock[blockDef.type] = function(block, generator) {
        let code = blockDef.codeTemplate;
        
        if (blockDef.type.includes('python_def')) {
           const name = block.getFieldValue('NAME');
           const args = block.getFieldValue('ARGS');
           // 读取 data 属性
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
            if (arg.type === "input_value") value = generator.valueToCode(block, name, window.Blockly.Python.ORDER_ATOMIC) || '0';
            else if (arg.type.startsWith("field_")) value = block.getFieldValue(name);
            code = code.split(`{{${name}}}`).join(value);
          });
        }
        
        if (blockDef.output !== undefined) return [code, window.Blockly.Python.ORDER_ATOMIC];
        return code;
      };
    });
  }, [lang]);

  useEffect(() => {
    if (!isBlocklyLoaded || !blocklyDiv.current) return;
    
    // Override Prompt for Variable Creation
    window.Blockly.dialog.setPrompt(function(message, defaultValue, callback) {
      setPromptState({ isOpen: true, message, defaultValue, inputValue: defaultValue, callback });
      setTimeout(() => promptInputRef.current?.focus(), 100);
    });

    const initTimer = setTimeout(() => {
        registerBlocks(robotConfig);
        if (workspaceRef.current) workspaceRef.current.dispose();
        
        workspaceRef.current = window.Blockly.inject(blocklyDiv.current, {
          toolbox: generateToolboxXML(robotConfig, lang),
          scrollbars: false, // 禁用默认滚动条，使用拖拽导航
          move: {
            scrollbars: false,
            drag: true,
            wheel: true
          },
          grid: { spacing: 20, length: 3, colour: '#ccc', snap: true },
          zoom: { controls: true, wheel: true, startScale: 1.0, maxScale: 3, minScale: 0.3, scaleSpeed: 1.2 },
          trashcan: true,
        });

        // 监听器 1: 外部容器尺寸变化
        if (resizeObserverRef.current) resizeObserverRef.current.disconnect();
        resizeObserverRef.current = new ResizeObserver(() => {
          window.Blockly.svgResize(workspaceRef.current);
        });
        resizeObserverRef.current.observe(blocklyDiv.current);

        const forceResize = () => {
          if(workspaceRef.current) window.Blockly.svgResize(workspaceRef.current);
        };

        const handleBlocklyEvents = (event) => {
          if ([window.Blockly.Events.BLOCK_CHANGE, window.Blockly.Events.BLOCK_MOVE, window.Blockly.Events.BLOCK_DELETE, window.Blockly.Events.VAR_CREATE, window.Blockly.Events.VAR_DELETE, window.Blockly.Events.VAR_RENAME].includes(event.type)) {
            try { setGeneratedCode(window.Blockly.Python.workspaceToCode(workspaceRef.current)); } catch(e) {}
          }
          if (event.type === window.Blockly.Events.UI || event.element === 'category') {
             setTimeout(forceResize, 50);
             setTimeout(forceResize, 200);
             setTimeout(forceResize, 400);
          }
        };
        workspaceRef.current.addChangeListener(handleBlocklyEvents);

        // 监听器 2: DOM 点击事件 (解决菜单收起 Bug)
        const onDivClick = () => {
           setTimeout(forceResize, 50);
           setTimeout(forceResize, 350);
        };
        blocklyDiv.current.addEventListener('click', onDivClick);
        blocklyDiv.current.addEventListener('touchstart', onDivClick);

        const updateCode = () => {
          try {
            const code = window.Blockly.Python.workspaceToCode(workspaceRef.current);
            setGeneratedCode(code);
          } catch(e) {}
        };
        workspaceRef.current.addChangeListener(updateCode);
    }, 100);
    
    return () => {
      if (resizeObserverRef.current) resizeObserverRef.current.disconnect();
    };
  }, [isBlocklyLoaded, registerBlocks, generateToolboxXML, robotConfig, lang]);

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
    }
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
    setCodeEditorState({ ...codeEditorState, isOpen: false });
  };

  const handleOpenProjectClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
    setActiveMenu(null);
  };

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
                <button onClick={() => setConfigText(JSON.stringify(lang === 'zh' ? DEFAULT_ROBOT_CONFIG_ZH : DEFAULT_ROBOT_CONFIG_EN, null, 2))} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-100 rounded hover:bg-red-100"><RefreshCw size={14} /> {t.resetBtn}</button>
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
            { id: 'view', label: t.menuView, content: <><MenuItem label={t.actToggleCode} icon={Sidebar} onClick={() => { setIsCodeOpen(!isCodeOpen); setActiveMenu(null); }} /></> },
            { id: 'help', label: t.menuHelp, content: <><MenuItem label={t.actAbout} icon={Info} onClick={() => { setShowAbout(true); setActiveMenu(null); }} /></> }
          ].map(menu => (
            <div key={menu.id} className="relative h-full"><button className={`h-full px-3 hover:bg-gray-200 transition-colors ${activeMenu === menu.id ? 'bg-gray-200 text-blue-700' : 'text-gray-700'}`} onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === menu.id ? null : menu.id); }}>{menu.label}</button>{activeMenu === menu.id && (<div className="absolute top-full left-0 w-56 bg-white border shadow-xl rounded-b-lg rounded-r-lg py-1 z-50 animate-in fade-in zoom-in-95 duration-100" onClick={e => e.stopPropagation()}>{menu.content}</div>)}</div>
          ))}
        </div>
        <div className="flex-1"></div>
        <button onClick={toggleLanguage} className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-600 px-3 transition-colors"><Globe size={12} /> {lang === 'zh' ? 'English' : '中文'}</button>
      </div>

      <div className="h-12 bg-white border-b flex items-center px-4 gap-2 z-30 shadow-sm">
        <button onClick={() => setShowConfigEditor(true)} className="p-2 text-gray-600 hover:bg-blue-50 hover:text-blue-600 rounded transition-colors" title={t.configTitle}><Settings size={20} /></button>
        <div className="w-px h-6 bg-gray-200 mx-1"></div>
        <button onClick={handleUndo} className="p-2 text-gray-600 hover:bg-gray-100 rounded transition-colors" title={t.actUndo}><Undo size={20} /></button>
        <button onClick={handleRedo} className="p-2 text-gray-600 hover:bg-gray-100 rounded transition-colors" title={t.actRedo}><Redo size={20} /></button>
        <div className="w-px h-6 bg-gray-200 mx-1"></div>
        <button onClick={handleRunCode} className={`flex items-center gap-2 px-4 py-1.5 text-white rounded font-medium text-sm transition-colors shadow-sm ${isRunning ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`} title={isRunning ? t.btnStop : t.btnRun}>
          {isRunning ? <Square size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />} {isRunning ? t.btnStop : t.btnRun}
        </button>
        <div className="flex-1"></div>
        <button onClick={() => setIsCodeOpen(!isCodeOpen)} className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded border transition-all ${isCodeOpen ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}><Code size={16} />{isCodeOpen ? 'Hide Code' : 'Show Code'}</button>
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        <div className="flex-1 relative bg-white z-0"><div ref={blocklyDiv} className="absolute inset-0 overflow-hidden" /></div>
        <div className={`bg-[#1e1e1e] flex flex-col border-l border-gray-700 z-20 transition-all duration-300 ease-in-out ${isCodeOpen ? 'w-[400px]' : 'w-0'}`}>
          <div className="h-10 bg-[#252526] flex items-center justify-between px-4 border-b border-[#3e3e42] shrink-0 overflow-hidden"><span className="text-gray-300 text-xs font-bold tracking-wider flex items-center gap-2 truncate"><Code size={14} className="text-blue-400" />{t.codeTitle}</span><button onClick={() => setIsCodeOpen(false)} className="text-gray-400 hover:text-white"><ChevronRight size={16} /></button></div>
          <div className="flex-1 overflow-auto p-4 custom-scrollbar whitespace-nowrap"><pre className="font-mono text-sm text-[#d4d4d4] leading-relaxed whitespace-pre-wrap">{generatedCode || "# Python Code ..."}</pre></div>
        </div>
      </div>
    </div>
  );
}