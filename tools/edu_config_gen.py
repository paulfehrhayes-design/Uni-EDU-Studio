import argparse
import ast
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class ParamSpec:
    name: str
    kind: str
    default: Optional[Any]


@dataclass(frozen=True)
class MethodSpec:
    name: str
    params: Tuple[ParamSpec, ...]


@dataclass(frozen=True)
class ClassSpec:
    name: str
    module_import: str
    methods: Tuple[MethodSpec, ...]


def _snake_case(name: str) -> str:
    s1 = re.sub("(.)([A-Z][a-z]+)", r"\1_\2", name)
    s2 = re.sub("([a-z0-9])([A-Z])", r"\1_\2", s1)
    return s2.lower()


def _python_literal(node: Optional[ast.AST]) -> Any:
    if node is None:
        return None
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant):
        if isinstance(node.operand.value, (int, float)):
            return -node.operand.value
    return None


def _annotation_kind(annotation: Optional[ast.AST], default: Any) -> str:
    if isinstance(default, bool):
        return "bool"
    if isinstance(default, int) and not isinstance(default, bool):
        return "int"
    if isinstance(default, float):
        return "float"
    if isinstance(default, str):
        return "str"
    if annotation is None:
        return "unknown"
    if isinstance(annotation, ast.Name):
        if annotation.id in {"bool", "int", "float", "str"}:
            return annotation.id
    return "unknown"


def _module_import_from_path(api_file: Path) -> Optional[str]:
    s = str(api_file).replace("\\", "/")
    marker = "/unitree_sdk2py/"
    if marker not in s:
        return None
    rel = s.split(marker, 1)[1]
    mod = "unitree_sdk2py." + rel[:-3].replace("/", ".")
    return mod


def parse_api_files(api_files: Sequence[Path]) -> Dict[str, ClassSpec]:
    classes: Dict[str, ClassSpec] = {}
    for f in api_files:
        tree = ast.parse(f.read_text(encoding="utf-8"))
        module_import = _module_import_from_path(f)
        if module_import is None:
            continue
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            methods: List[MethodSpec] = []
            for item in node.body:
                if not isinstance(item, ast.FunctionDef):
                    continue
                if item.name.startswith("_") or item.name in {"__init__", "Init"}:
                    continue
                params: List[ParamSpec] = []
                args = item.args.args[1:]
                defaults = [None] * (len(args) - len(item.args.defaults)) + item.args.defaults
                for a, d in zip(args, defaults):
                    dv = _python_literal(d)
                    kind = _annotation_kind(a.annotation, dv)
                    params.append(ParamSpec(name=a.arg, kind=kind, default=dv))
                methods.append(MethodSpec(name=item.name, params=tuple(params)))
            classes[node.name] = ClassSpec(
                name=node.name,
                module_import=module_import,
                methods=tuple(methods),
            )
    return classes


def parse_examples_for_varnames(example_files: Sequence[Path], class_names: Iterable[str]) -> Dict[str, str]:
    class_name_set = set(class_names)
    mapping: Dict[str, str] = {}
    for f in example_files:
        tree = ast.parse(f.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
                continue
            target = node.targets[0].id
            if not isinstance(node.value, ast.Call):
                continue
            call = node.value
            if isinstance(call.func, ast.Name) and call.func.id in class_name_set:
                mapping[call.func.id] = target
    return mapping


def build_import_block(classes: Sequence[ClassSpec]) -> str:
    lines: List[str] = []
    for c in classes:
        lines.append(f"from {c.module_import} import {c.name}")
    return "\n".join(lines) + "\n"


def block_field_for_param(p: ParamSpec) -> Dict[str, Any]:
    if p.kind == "bool":
        return {
            "type": "field_dropdown",
            "name": p.name.upper(),
            "options": [["True", "True"], ["False", "False"]],
        }
    if p.kind in {"int", "float"}:
        default = 0 if p.default is None else p.default
        return {"type": "field_number", "name": p.name.upper(), "value": default}
    default = "" if p.default is None else str(p.default)
    return {"type": "field_input", "name": p.name.upper(), "text": default}


def value_expr_for_param(p: ParamSpec) -> str:
    if p.kind == "str" or (p.kind == "unknown" and isinstance(p.default, str)):
        return f"'{{{{{p.name.upper()}}}}}'"
    return f"{{{{{p.name.upper()}}}}}"


def build_method_block(
    robot_prefix: str,
    class_name: str,
    client_var: str,
    method: MethodSpec,
    colour: int,
) -> Dict[str, Any]:
    args0 = [block_field_for_param(p) for p in method.params]
    msg_parts = [f"{method.name}"]
    for idx, p in enumerate(method.params, start=1):
        msg_parts.append(f"{p.name} %"+str(idx))
    message0 = " ".join(msg_parts)
    arg_values = ", ".join(value_expr_for_param(p) for p in method.params)
    call = f"{client_var}.{method.name}({arg_values})" if arg_values else f"{client_var}.{method.name}()"
    return {
        "type": f"{robot_prefix}_{_snake_case(class_name)}_{_snake_case(method.name)}",
        "message0": message0,
        "args0": args0,
        "previousStatement": None,
        "nextStatement": None,
        "colour": colour,
        "codeTemplate": call + "\n",
    }


def generate_config(
    robot_prefix: str,
    api_files: Sequence[Path],
    example_files: Sequence[Path],
    domain_default: int = 0,
    interface_default: str = "eth0",
) -> List[Dict[str, Any]]:
    class_specs = parse_api_files(api_files)
    if not class_specs:
        raise RuntimeError("No classes parsed from api files. Ensure paths include unitree_sdk2py/....py")

    varnames = parse_examples_for_varnames(example_files, class_specs.keys())

    classes_sorted = sorted(class_specs.values(), key=lambda x: x.name)
    import_block = build_import_block(classes_sorted)

    system_category = {
        "category": "System",
        "colour": "230",
        "blocks": [
            {
                "type": f"{robot_prefix}_start",
                "message0": "Start",
                "args0": [],
                "nextStatement": None,
                "colour": 230,
                "codeTemplate": "# uni plus edu studio generated config\nimport time\nimport sys\nimport math\nimport json\nfrom dataclasses import dataclass\n",
            },
            {
                "type": f"{robot_prefix}_system_init",
                "message0": "Init Channel Domain: %1 Interface: %2",
                "args0": [
                    {"type": "field_number", "name": "DOMAIN", "value": domain_default, "precision": 1},
                    {"type": "field_input", "name": "INTERFACE", "text": interface_default},
                ],
                "previousStatement": None,
                "nextStatement": None,
                "colour": 230,
                "codeTemplate": "from unitree_sdk2py.core.channel import ChannelFactoryInitialize\n"
                + f"ChannelFactoryInitialize({{{{DOMAIN}}}}, '{{{{INTERFACE}}}}')\n",
            },
            {
                "type": f"{robot_prefix}_load_modules",
                "message0": "Load Modules",
                "args0": [],
                "previousStatement": None,
                "nextStatement": None,
                "colour": 230,
                "codeTemplate": import_block,
            },
        ],
    }

    categories: List[Dict[str, Any]] = [system_category]
    colours = [160, 60, 120, 210, 300, 20, 290]
    for idx, c in enumerate(classes_sorted):
        colour = colours[idx % len(colours)]
        client_var = varnames.get(c.name) or f"{_snake_case(c.name)}_client"
        blocks: List[Dict[str, Any]] = [
            {
                "type": f"{robot_prefix}_{_snake_case(c.name)}_init",
                "message0": f"Init {c.name}",
                "args0": [],
                "previousStatement": None,
                "nextStatement": None,
                "colour": colour,
                "codeTemplate": f"{client_var} = {c.name}()\n{client_var}.SetTimeout(10.0)\n{client_var}.Init()\n",
            }
        ]
        for m in c.methods:
            blocks.append(build_method_block(robot_prefix, c.name, client_var, m, colour))
        categories.append({"category": c.name, "colour": str(colour), "blocks": blocks})
    return categories


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--robot-prefix", required=True)
    parser.add_argument("--api", action="append", required=True)
    parser.add_argument("--example", action="append", default=[])
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    api_files = [Path(p).resolve() for p in args.api]
    example_files = [Path(p).resolve() for p in args.example]
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    config = generate_config(args.robot_prefix, api_files, example_files)
    out_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

