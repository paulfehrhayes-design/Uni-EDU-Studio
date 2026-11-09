from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING, Any, Literal

from gradio.components.base import Component
from gradio.events import Events
from gradio.i18n import I18nData

if TYPE_CHECKING:
    from gradio.components import Timer


class FileLister(Component):
    """
    A file explorer-style list component that displays files with name and date columns.
    Supports sorting by name or date, and multi-selection of files.

    Files can be provided in multiple formats:
        - Simple list of strings: ["file1.wav", "file2.wav"] — date column hidden automatically
        - List of dicts with keys:
            - 'name' (str): filename or folder name
            - 'date' (str, optional): date string for display
            - 'type' (str, optional): one of 'audio', 'video', 'text', 'folder', 'file'.
              If omitted, auto-detected from file extension.

    The component value is a dict with 'files' (all files) and 'selected' (selected file names).

    Double-click events dispatch the clicked file info, useful for folder navigation.
    """

    EVENTS = [
        Events.change,
        Events.input,
        Events.select,
        Events.double_click,
    ]

    def __init__(
        self,
        value=None,
        *,
        file_count="multiple",
        height=400,
        show_footer=True,
        show_icons=True,
        show_date=True,
        show_type_column=False,
        selected_color=None,
        font_size=None,
        row_padding=6,
        date_width=180,
        type_width=90,
        striped=False,
        name_label="Name",
        date_label="Date",
        type_label="Type",
        label=None,
        every=None,
        inputs=None,
        show_label=None,
        scale=None,
        min_width=160,
        interactive=None,
        visible=True,
        elem_id=None,
        elem_classes=None,
        render=True,
        key=None,
        preserved_by_key=None,
    ):
        """
        Parameters:
            value: list of strings ["file.wav", ...] or
                   list of file dicts [{"name": "audio.wav", "date": "2025-01-15 10:30"}, ...].
                   When strings are given or all dates are empty, the date column hides automatically.
                   Dicts may also include 'type' ('audio'|'video'|'text'|'folder'|'file').
                   If 'type' is omitted, it is auto-detected from the file extension.
            file_count: "single" or "multiple" - whether one or many files can be selected.
            height: height of the file list area in pixels.
            show_footer: if True, show the "N files selected" footer bar.
            show_icons: if True, show file icons next to names.
            show_date: if True, show the date column. Set to "auto" or True by default;
                       automatically hidden when all files lack date values.
            show_type_column: if True, show a sortable "Type" column.
            selected_color: custom CSS color for selected row accent (e.g. "#e040fb").
                            None uses the theme default.
            font_size: CSS font size for file rows (e.g. "14px", "0.9rem").
                       None uses the theme default.
            row_padding: vertical padding for each row in pixels.
            date_width: width of the date column in pixels.
            type_width: width of the type column in pixels.
            striped: if True, alternate row backgrounds for readability.
            name_label: header text for the name column.
            date_label: header text for the date column.
            type_label: header text for the type column.
            label: the label for this component.
            every: continuously calls value to recalculate if value is a function.
            inputs: components used as inputs to calculate value if value is a function.
            show_label: if True, will display label.
            scale: relative size compared to adjacent Components.
            min_width: minimum pixel width.
            interactive: if True, files can be selected.
            visible: if False, component will be hidden.
            elem_id: optional string id for the HTML DOM element.
            elem_classes: optional list of CSS class strings.
            render: if False, component will not be rendered initially.
            key: component key for gr.render re-render tracking.
            preserved_by_key: parameters preserved across re-renders with same key.
        """
        self.file_count = file_count
        self.height = height
        self.show_footer = show_footer
        self.show_icons = show_icons
        self.show_date = show_date
        self.show_type_column = show_type_column
        self.selected_color = selected_color
        self.font_size = font_size
        self.row_padding = row_padding
        self.date_width = date_width
        self.type_width = type_width
        self.striped = striped
        self.name_label = name_label
        self.date_label = date_label
        self.type_label = type_label
        super().__init__(
            label=label,
            every=every,
            inputs=inputs,
            show_label=show_label,
            scale=scale,
            min_width=min_width,
            interactive=interactive,
            visible=visible,
            elem_id=elem_id,
            elem_classes=elem_classes,
            value=value,
            render=render,
            key=key,
            preserved_by_key=preserved_by_key or "value",
        )

    def preprocess(self, payload):
        """
        Parameters:
            payload: dict with 'files' and 'selected' from the frontend.
        Returns:
            The same dict - 'files' is the full list, 'selected' is list of selected file names.
        """
        if payload is None:
            return {"files": [], "selected": []}
        return payload

    def postprocess(self, value):
        """
        Parameters:
            value: a list of strings ["file.wav", ...] or
                   a list of file dicts [{"name": str, "date": str}, ...] or
                   a dict with 'files' and optionally 'selected'.
        Returns:
            Dict with 'files' and 'selected' for the frontend.
        """
        if value is None:
            return {"files": [], "selected": []}
        if isinstance(value, list):
            # Normalize: accept list of strings or list of dicts
            normalized = []
            for item in value:
                if isinstance(item, str):
                    normalized.append({"name": item, "date": ""})
                elif isinstance(item, dict):
                    # Ensure 'date' key exists
                    if "date" not in item:
                        item = {**item, "date": ""}
                    normalized.append(item)
                else:
                    normalized.append({"name": str(item), "date": ""})
            return {"files": normalized, "selected": []}
        return value

    def example_payload(self):
        return {
            "files": [
                {"name": "example.wav", "date": "2025-01-15 10:30"},
                {"name": "test.mp3", "date": "2025-02-01 14:00"},
            ],
            "selected": [],
        }

    def example_value(self):
        return [
            {"name": "example.wav", "date": "2025-01-15 10:30"},
            {"name": "test.mp3", "date": "2025-02-01 14:00"},
        ]

    def api_info(self):
        return {
            "type": "object",
            "properties": {
                "files": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "date": {"type": "string"},
                        },
                    },
                },
                "selected": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
        }
