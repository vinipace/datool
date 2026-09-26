"""Bounded trusted-local Python scorer. This is not a hostile-code sandbox."""
import builtins
import collections
import contextlib
import datetime
import decimal
import fractions
import functools
import itertools
import json
import math
import re
import resource
import statistics
import string
import sys

MAX_RESULT_BYTES = 16 * 1024
MODULES = {module.__name__: module for module in (
    collections, datetime, decimal, fractions, functools, itertools,
    json, math, re, statistics, string,
)}


class ValidationError(Exception):
    pass


def restricted_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level or name not in MODULES:
        raise ImportError("Python scorers support these modules: " + ", ".join(MODULES))
    return MODULES[name]


def audit(event, args):
    # Defense in depth for mistakes in trusted code, not a security boundary.
    if event == "open" or event.startswith(("os.", "subprocess.", "socket.", "ctypes.")):
        raise PermissionError("Scorers cannot access files, networks, or subprocesses")


def validate(value):
    if not isinstance(value, dict):
        raise ValidationError("Evaluator must return a JSON object with a finite score between 0 and 1")
    unsupported = set(value) - {"name", "metadata", "score", "passed", "label", "reason", "metrics"}
    if unsupported:
        raise ValidationError("Evaluator result contains unsupported fields: " + ", ".join(map(str, unsupported)))
    score = value.get("score")
    if not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
        raise ValidationError("Evaluator result score must be between 0 and 1")
    if "passed" in value and not isinstance(value["passed"], bool):
        raise ValidationError("Evaluator result passed must be a boolean when provided")
    for key in ("name", "label", "reason"):
        if key in value and not isinstance(value[key], str):
            raise ValidationError("Evaluator result " + key + " must be a string")
    if "name" in value and not value["name"].strip():
        raise ValidationError("Evaluator result name must be non-empty")
    for key in ("metrics", "metadata"):
        if key in value and not isinstance(value[key], dict):
            raise ValidationError("Evaluator result " + key + " must be a JSON object")
    metadata = dict(value.get("metadata", {}))
    for key in ("name", "label", "metrics"):
        if key in value:
            metadata[key] = value[key].strip() if key == "name" else value[key]
    if isinstance(score, bool):
        metadata["booleanScore"] = score
        score = int(score)
    result = {"score": score, "passed": value.get("passed"), "metadata": metadata}
    if "reason" in value:
        result["reasoning"] = value["reason"]
    try:
        encoded = json.dumps(result, allow_nan=False)
    except (ValueError, TypeError, OverflowError) as error:
        raise ValidationError("Evaluator result must be JSON serializable") from error
    if len(encoded.encode("utf-8")) > MAX_RESULT_BYTES:
        raise ValidationError("Evaluator result exceeds the 16 KB limit")
    return result


def main():
    request = json.loads(sys.stdin.read(1024 * 1024 + 1))
    code = request["code"]
    if len(code.encode("utf-8")) > 128 * 1024:
        raise ValidationError("Evaluator code exceeds the 128 KB limit")
    # macOS does not enforce an address-space limit; production runs on Linux.
    if sys.platform == "linux":
        resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    seconds = math.ceil(request["timeoutMs"] / 1000) + 1
    resource.setrlimit(resource.RLIMIT_CPU, (seconds, seconds))
    allowed = {name: value for name, value in vars(builtins).items()
               if name not in {"open", "input", "eval", "exec", "compile", "breakpoint", "__import__"}}
    allowed["__import__"] = restricted_import
    scope = {"__builtins__": allowed, "__name__": "scorer"}
    program = compile(code, "<scorer>", "exec")
    sys.addaudithook(audit)
    with contextlib.redirect_stdout(sys.stderr):
        exec(program, scope)
        evaluate = scope.get("evaluate")
        if not callable(evaluate):
            raise ValidationError("Define evaluate(trace, dataset_item=None)")
        result = evaluate(request["trace"], request.get("datasetItem"))
    return validate(result)


try:
    response = {"ok": True, "result": main()}
except BaseException as error:
    kind = "validation" if isinstance(error, ValidationError) else (
        "sandbox" if isinstance(error, (PermissionError, MemoryError)) else "runtime")
    response = {"ok": False, "error": {"kind": kind, "message": str(error)[:1000] or type(error).__name__}}
sys.stdout.write(json.dumps(response, allow_nan=False) + "\n")
