"""
Base utilities for tool modules.

Provides common patterns and helpers for all tools.
"""

from dataclasses import dataclass
from typing import Dict, Any, Callable, Optional


@dataclass
class ToolConfig:
    """Configuration for a tool."""
    name: str  # tool name/title
    module_name: str  # Python module name (e.g., 'tool_voice_clone')
    description: str  # tool description for settings
    enabled: bool = True  # Whether tool is enabled
    category: str = "general"  # tool category: "generation", "training", "utility", "settings"


class Tool:
    """Base class for tool modules."""

    config: ToolConfig

    @classmethod
    def create_tool(cls, shared_state: Dict[str, Any]):
        """
        Create and return the tool UI.

        Args:
            shared_state: Dictionary with shared globals
                - 'active_emotions': Active emotions dict
                - 'user_config': User configuration
                - 'get_*': Helper functions

        Returns:
            dict with all component references for event wiring
        """
        raise NotImplementedError

    @classmethod
    def setup_events(cls, components: Dict[str, Any], shared_state: Dict[str, Any]):
        """
        Wire up all event handlers for this tool.

        Args:
            components: Component references returned by create_tool()
            shared_state: Dictionary with shared globals
        """
        raise NotImplementedError


def get_helper(shared_state: Dict[str, Any], helper_name: str) -> Callable:
    """Get a helper function from shared state."""
    if helper_name not in shared_state:
        raise KeyError(f"Helper '{helper_name}' not found in shared state")
    return shared_state[helper_name]
