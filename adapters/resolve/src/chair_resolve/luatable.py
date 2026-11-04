"""Tolerant reader for Fusion's Lua-table text (.setting, .comp, macros).

Fusion writes `Name = Constructor { key = value, ... }` trees, not full Lua.
This reads just that shape: numbers, strings, booleans, nested tables,
`ordered() { ... }` wrappers, `[n] = value` keys, positional values, and both
comment styles. It never evaluates anything and never raises on a stray
token: unknown bytes are skipped so a half-broken file still yields what
parsed. The one hard stop is nesting deeper than MAX_DEPTH, which raises
LuaTableError so a hostile file cannot blow the stack.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

MAX_DEPTH = 80

_TOKEN = re.compile(
    r"""
    (?P<space>\s+)
  | (?P<comment>--\[(?P<eq>=*)\[.*?\](?P=eq)\]|--[^\n]*)
  | (?P<number>-?(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?))
  | (?P<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
  | (?P<long>\[(?P<leq>=*)\[.*?\](?P=leq)\])
  | (?P<ident>[A-Za-z_][A-Za-z0-9_.]*)
  | (?P<punct>[{}()\[\]=,;])
  | (?P<junk>.)
    """,
    re.VERBOSE | re.DOTALL,
)

_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\", '"': '"', "'": "'", "0": "\0"}
_SIMPLE = {"true": True, "false": False, "nil": None}


class LuaTableError(ValueError):
    pass


@dataclass
class Table:
    """A `{ ... }` body: named entries, positional items, optional constructor."""

    type: str | None = None
    named: dict[Any, Any] = field(default_factory=dict)
    items: list[Any] = field(default_factory=list)

    def get(self, key: Any, default: Any = None) -> Any:
        return self.named.get(key, default)


def _unescape(raw: str) -> str:
    body = raw[1:-1]
    if "\\" not in body:
        return body
    return re.sub(r"\\(.)", lambda m: _ESCAPES.get(m.group(1), m.group(1)), body, flags=re.DOTALL)


def _number(text: str) -> int | float:
    if text.lower().lstrip("-").startswith("0x"):
        return int(text, 16)
    return float(text) if any(mark in text for mark in ".eE") else int(text)


def _tokens(text: str) -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    for match in _TOKEN.finditer(text):
        kind = match.lastgroup
        if kind in ("space", "comment", "junk", "eq", "leq"):
            continue
        raw = match.group(kind) if kind else ""
        if kind == "number":
            out.append(("value", _number(raw)))
        elif kind == "string":
            out.append(("value", _unescape(raw)))
        elif kind == "long":
            out.append(("value", re.sub(r"^\[=*\[|\]=*\]$", "", raw)))
        elif kind == "ident":
            out.append(("ident", raw))
        else:
            out.append(("punct", raw))
    return out


class _Reader:
    def __init__(self, tokens: list[tuple[str, Any]]) -> None:
        self.tokens = tokens
        self.at = 0

    def peek(self, offset: int = 0) -> tuple[str, Any] | None:
        index = self.at + offset
        return self.tokens[index] if index < len(self.tokens) else None

    def is_punct(self, char: str, offset: int = 0) -> bool:
        token = self.peek(offset)
        return token is not None and token[0] == "punct" and token[1] == char

    def value(self, depth: int) -> Any:
        if depth > MAX_DEPTH:
            raise LuaTableError(f"tables nest deeper than {MAX_DEPTH}")
        token = self.peek()
        if token is None:
            return None
        kind, content = token
        if kind == "value":
            self.at += 1
            return content
        if kind == "ident":
            self.at += 1
            if content in _SIMPLE:
                return _SIMPLE[content]
            constructor = content
            if self.is_punct("("):  # ordered(), Point(1, 2): args are not needed
                self._skip_parens()
            if self.is_punct("{"):
                table = self.table(depth + 1)
                table.type = constructor
                return table
            return constructor
        if kind == "punct" and content == "{":
            return self.table(depth + 1)
        self.at += 1  # stray closer or operator: skip, stay tolerant
        return None

    def _skip_parens(self) -> None:
        level = 0
        while (token := self.peek()) is not None:
            self.at += 1
            if token == ("punct", "("):
                level += 1
            elif token == ("punct", ")"):
                level -= 1
                if level == 0:
                    return

    def table(self, depth: int) -> Table:
        self.at += 1  # the opening brace
        table = Table()
        while (token := self.peek()) is not None:
            if token == ("punct", "}"):
                self.at += 1
                return table
            if token[0] == "punct" and token[1] in ",;":
                self.at += 1
                continue
            if token == ("punct", "[") and self.peek(1) and self.peek(1)[0] == "value":
                key = self.peek(1)[1]
                if self.is_punct("]", 2) and self.is_punct("=", 3):
                    self.at += 4
                    table.named[key] = self.value(depth)
                    continue
            if token[0] == "ident" and self.is_punct("=", 1):
                self.at += 2
                table.named[token[1]] = self.value(depth)
                continue
            if token[0] == "punct" and token[1] in ")]=":
                self.at += 1
                continue
            table.items.append(self.value(depth))
        return table  # unclosed at end of file: keep what parsed


def parse(text: str) -> Any:
    """First value in the text, or None for an empty or unreadable file."""
    reader = _Reader(_tokens(text))
    return reader.value(0)
