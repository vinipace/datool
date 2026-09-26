"""Datool's Python SDK."""

from ._recording import propagate_attributes
from ._transport import DatoolError, DatoolHTTPError
from .client import Datool, Observation, ObservationType, get_client
from .decorators import observe
from .otel import DatoolSpanProcessor
from .prompts import RuntimePrompt

__version__ = "0.1.0"
__all__ = [
    "Datool",
    "DatoolError",
    "DatoolHTTPError",
    "DatoolSpanProcessor",
    "Observation",
    "ObservationType",
    "RuntimePrompt",
    "get_client",
    "observe",
    "propagate_attributes",
]
