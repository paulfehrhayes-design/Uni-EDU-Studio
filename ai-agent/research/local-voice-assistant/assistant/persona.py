"""Optional persona overlay on the plain system prompt.

Off by default. When enabled, the system prompt sent to the LLM is composed
from three pieces, in order: the persona's base character text (persona.yaml),
the same speech-formatting rules the plain prompt already uses, and a sentence
describing the current humour/candor/profanity dials in words rather than
numbers. Few-shot examples are handed back separately as real message pairs,
not folded into the prompt text -- callers are expected to splice them into
the message list themselves, ahead of conversation history, so they always
ride along with the system prompt and are never subject to history
truncation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import yaml


def clamp(value: int, lo: int = 0, hi: int = 100) -> int:
    return max(lo, min(hi, value))


def _parse_bands(raw: dict) -> dict[str, list[tuple[int, str]]]:
    """Convert persona.yaml's `bands:` mapping into {dial: [(max, description), ...]}."""
    return {
        dial: [(entry["max"], entry["description"]) for entry in entries]
        for dial, entries in raw.items()
    }


def _band_description(value: int, bands: list[tuple[int, str]]) -> str:
    """The first band's description whose threshold the value doesn't exceed."""
    for threshold, description in bands:
        if value <= threshold:
            return description
    return bands[-1][1]


def describe_dials(humour: int, candor: int, profanity: int, bands: dict[str, list[tuple[int, str]]]) -> str:
    """Compose a sentence describing the current dial levels in words, not numbers,
    using the band descriptions loaded from persona.yaml."""
    return (
        "Current calibration: "
        f"{_band_description(humour, bands['humour'])} "
        f"{_band_description(candor, bands['candor'])} "
        f"{_band_description(profanity, bands['profanity'])}"
    )


@dataclass
class PersonaState:
    name: str
    base_prompt: str
    speech_rules: str
    bands: dict[str, list[tuple[int, str]]]
    examples: list[dict] = field(default_factory=list)
    voice: str = ""
    temperature: float = 1.0
    allow_runtime_adjust: bool = False
    humour: int = 50
    candor: int = 50
    profanity: int = 50

    def system_prompt(self) -> str:
        """Compose the full system prompt. Recompute this every turn -- the
        dials line depends on live dial values, which runtime adjustment can
        change mid-conversation."""
        return (
            f"{self.base_prompt}\n\n"
            f"{self.speech_rules}\n\n"
            f"{describe_dials(self.humour, self.candor, self.profanity, self.bands)}"
        )


def load_persona(persona_path: str, persona_cfg: dict, speech_rules: str) -> PersonaState:
    """Load the one persona from persona_path, combined with the dial values
    and overrides from config.yaml's `persona:` block. The persona's name
    comes only from persona_cfg (config.yaml) -- persona.yaml doesn't repeat it."""
    with open(persona_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)

    examples: list[dict] = []
    for pair in data.get("examples", []):
        examples.append({"role": "user", "content": pair["user"]})
        examples.append({"role": "assistant", "content": pair["assistant"]})

    name = persona_cfg.get("name", "")
    base_prompt = data["system_prompt"].strip().replace("{name}", name)

    return PersonaState(
        name=name,
        base_prompt=base_prompt,
        speech_rules=speech_rules.strip(),
        bands=_parse_bands(data["bands"]),
        examples=examples,
        voice=persona_cfg["voice"],
        temperature=float(persona_cfg["temperature"]),
        allow_runtime_adjust=persona_cfg.get("allow_runtime_adjust", False),
        humour=clamp(int(persona_cfg.get("humour", 50))),
        candor=clamp(int(persona_cfg.get("candor", 50))),
        profanity=clamp(int(persona_cfg.get("profanity", 50))),
    )


# --- Runtime dial adjustment -------------------------------------------------
#
# Detects spoken commands like "set your humour to forty percent" or "turn
# your candor down" in a raw transcript, before it reaches the LLM. In-memory
# only -- never written back to config.yaml.

_DIAL_ALIASES = {
    "humour": "humour",
    "humor": "humour",
    "candor": "candor",
    "candour": "candor",
    "profanity": "profanity",
}

_ONES = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
    "eighteen": 18, "nineteen": 19,
}
_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fourty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}


def _word_to_number(text: str) -> int | None:
    """Parse a spoken number word/phrase (0-100), e.g. 'forty' or 'seventy five'."""
    text = text.strip().lower().replace("-", " ")
    if text in ("a hundred", "one hundred", "hundred"):
        return 100
    words = text.split()
    if len(words) == 1:
        word = words[0]
        if word in _ONES:
            return _ONES[word]
        if word in _TENS:
            return _TENS[word]
        return None
    if len(words) == 2 and words[0] in _TENS and words[1] in _ONES and _ONES[words[1]] < 10:
        return _TENS[words[0]] + _ONES[words[1]]
    return None


def _parse_number(text: str) -> int | None:
    """Parse a 0-100 value from either digits ('40', '40 percent') or words."""
    text = text.strip().lower()
    digit_match = re.fullmatch(r"(\d{1,3})\s*(?:percent)?", text)
    if digit_match:
        return int(digit_match.group(1))
    return _word_to_number(text.replace("percent", "").strip())


_SET_RE = re.compile(
    r"\b(?:set|put|make|dial)\s+(?:your\s+)?(humou?r|candou?r|profanity)\s+"
    r"(?:to|at)\s+([a-z0-9 -]+?)(?:\s*percent)?[.!?]?$"
)
_ADJUST_RE = re.compile(
    r"\b(?:turn|bring|dial|knock)\s+(?:your\s+)?(humou?r|candou?r|profanity)\s+(up|down)\b"
)
_ADJUST_STEP = 20

_ACK_TEMPLATES = {
    "humour": "Humour's at {value} percent now. Try to keep up.",
    "candor": "Candor's at {value} percent now. You asked for it.",
    "profanity": "Profanity's at {value} percent now.",
}


def try_apply_dial_command(text: str, persona: PersonaState) -> str | None:
    """If `text` is a dial-adjustment command, apply it to `persona` in place
    and return an in-character acknowledgement. Returns None otherwise."""
    if not persona.allow_runtime_adjust:
        return None
    lowered = text.strip().lower().rstrip(".!?")

    match = _SET_RE.search(lowered)
    if match:
        dial = _DIAL_ALIASES[match.group(1)]
        value = _parse_number(match.group(2))
        if value is None:
            return None
        setattr(persona, dial, clamp(value))
        return _ACK_TEMPLATES[dial].format(value=getattr(persona, dial))

    match = _ADJUST_RE.search(lowered)
    if match:
        dial = _DIAL_ALIASES[match.group(1)]
        delta = _ADJUST_STEP if match.group(2) == "up" else -_ADJUST_STEP
        setattr(persona, dial, clamp(getattr(persona, dial) + delta))
        return _ACK_TEMPLATES[dial].format(value=getattr(persona, dial))

    return None
