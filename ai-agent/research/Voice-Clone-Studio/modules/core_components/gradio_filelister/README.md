# gradio_filelister

A file explorer-style list component for Gradio. Displays files with sortable columns, selection, icons, and double-click support.

## Installation

```bash
pip install gradio_filelister
```

## Quick Start

```python
import gradio as gr
from gradio_filelister import FileLister

# Simple string list (date column auto-hidden)
lister = FileLister(value=["file1.wav", "file2.wav", "file3.wav"])

# With dates
lister = FileLister(value=[
    {"name": "recording.wav", "date": "2026-01-15 10:30"},
    {"name": "backup.mp3", "date": "2026-02-01 14:00"},
])

# With explicit types and all columns
lister = FileLister(
    value=[
        {"name": "vocals", "type": "folder"},
        {"name": "song.wav", "date": "2026-01-20 09:00", "type": "audio"},
        {"name": "notes.txt", "date": "2026-01-21 11:30", "type": "text"},
    ],
    show_type_column=True,
    show_icons=True,
)
```

## Input Formats

The `value` parameter accepts several formats:

| Format | Example | Date Column |
|---|---|---|
| List of strings | `["a.wav", "b.wav"]` | Auto-hidden |
| List of dicts (with dates) | `[{"name": "a.wav", "date": "2026-01-01"}]` | Shown |
| List of dicts (no dates) | `[{"name": "a.wav"}]` | Auto-hidden |
| Dict with files/selected | `{"files": [...], "selected": ["a.wav"]}` | Depends on data |

### File Dict Keys

| Key | Type | Required | Description |
|---|---|---|---|
| `name` | `str` | Yes | Filename or folder name displayed in the list |
| `date` | `str` | No | Date string for display (any format). Defaults to `""` |
| `type` | `str` | No | One of `"audio"`, `"video"`, `"text"`, `"folder"`, `"file"`. Auto-detected from extension if omitted |

## Component Value

The component value (returned by event handlers) is a dict:

```python
{
    "files": [{"name": "a.wav", "date": "..."}, ...],  # All files in the list
    "selected": ["a.wav"]                                # Currently selected file names
}
```

## Parameters

### Data & Selection

| Parameter | Type | Default | Description |
|---|---|---|---|
| `value` | `list \| dict \| None` | `None` | File data — strings, dicts, or full files/selected dict |
| `file_count` | `str` | `"multiple"` | `"single"` or `"multiple"` — how many files can be selected |
| `interactive` | `bool \| None` | `None` | If `True`, files can be selected by clicking |

### Column Visibility

| Parameter | Type | Default | Description |
|---|---|---|---|
| `show_date` | `bool` | `True` | Show the date column. When `True`, auto-hides if all dates are empty |
| `show_type_column` | `bool` | `False` | Show a sortable "Type" column |
| `show_icons` | `bool` | `True` | Show file type icons next to names |
| `show_footer` | `bool` | `True` | Show the "N files selected" footer bar |

### Column Labels

| Parameter | Type | Default | Description |
|---|---|---|---|
| `name_label` | `str` | `"Name"` | Header text for the name column |
| `date_label` | `str` | `"Date"` | Header text for the date column |
| `type_label` | `str` | `"Type"` | Header text for the type column |

### Sizing

| Parameter | Type | Default | Description |
|---|---|---|---|
| `height` | `int` | `400` | Height of the scrollable file list area in pixels |
| `date_width` | `int` | `180` | Width of the date column in pixels |
| `type_width` | `int` | `90` | Width of the type column in pixels |
| `row_padding` | `int` | `6` | Vertical padding for each row in pixels |
| `font_size` | `str \| None` | `None` | CSS font size for rows (e.g. `"14px"`, `"0.9rem"`). `None` uses theme default |
| `min_width` | `int` | `160` | Minimum pixel width of the component |
| `scale` | `int \| None` | `None` | Relative size compared to adjacent components |

### Appearance

| Parameter | Type | Default | Description |
|---|---|---|---|
| `selected_color` | `str \| None` | `None` | CSS color for selected row accent (e.g. `"#e040fb"`). `None` uses theme default |
| `striped` | `bool` | `False` | Alternate row backgrounds for readability |

### Standard Gradio

| Parameter | Type | Default | Description |
|---|---|---|---|
| `label` | `str \| None` | `None` | Component label text |
| `show_label` | `bool \| None` | `None` | Whether to display the label |
| `visible` | `bool` | `True` | If `False`, component is hidden |
| `elem_id` | `str \| None` | `None` | HTML DOM element id |
| `elem_classes` | `list \| None` | `None` | CSS class names |
| `every` | `Timer \| float \| None` | `None` | Continuously recalculate value on interval |
| `inputs` | `list \| None` | `None` | Components used as inputs when value is a function |
| `render` | `bool` | `True` | If `False`, component won't render initially |
| `key` | `str \| int \| None` | `None` | Key for `gr.render` re-render tracking |

## Events

| Event | Description |
|---|---|
| `.change()` | Fires when selection changes (click on a file) |
| `.input()` | Fires on user input |
| `.select()` | Fires when a file is selected |
| `.double_click()` | Fires on double-click — useful for playback or folder navigation |

### Double-Click Playback Example

```python
# Play audio on double-click using JS to click the WaveSurfer play button
lister = FileLister(value=files, elem_id="my-lister")
audio = gr.Audio(label="Preview", elem_id="my-audio")

lister.change(load_audio, inputs=[lister], outputs=[audio])
lister.double_click(
    fn=None,
    js="() => { setTimeout(() => { "
       "const btn = document.querySelector('#my-audio .play-pause-button'); "
       "if (btn) btn.click(); }, 150); }"
)
```

## Sorting

Click column headers to sort. Click again to reverse. Default sort is by name ascending with folders first.

## Selection

- **Click** a row to select it (and deselect others)
- **Ctrl+Click** to toggle individual files (multi-select mode)
- **Shift+Click** to select a range
- **Click+Drag** to select multiple consecutive files

## Building

**Prerequisites:** Node.js (for frontend compilation)

**Steps:**

```bash
# Navigate to the component directory
cd modules\core_components\gradio_filelister

# Set encoding (Windows PowerShell)
$env:PYTHONIOENCODING = "utf-8"

# Build the component (skips doc generation)
.\venv\Scripts\python.exe -m gradio cc build --no-generate-docs

# Install the built wheel
.\venv\Scripts\python.exe -m pip install dist\gradio_filelister-<version>-py3-none-any.whl --force-reinstall --no-deps
```

**Notes:**
- Always use the project's venv Python (`.\venv\Scripts\python.exe`), never system Python
- Use `--force-reinstall --no-deps` to avoid reinstalling all dependencies on each rebuild
- The built wheel can be found in `dist/`
- Bump the version in `pyproject.toml` before building a new release