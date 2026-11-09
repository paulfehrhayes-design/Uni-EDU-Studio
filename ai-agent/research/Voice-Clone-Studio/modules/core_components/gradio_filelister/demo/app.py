
import gradio as gr
from gradio_filelister import FileLister
import datetime


# Example file list
sample_files = [
    {"name": "recording_001.wav", "date": "2025-01-15 10:30"},
    {"name": "recording_002.wav", "date": "2025-01-16 14:22"},
    {"name": "voice_sample.mp3", "date": "2025-02-01 09:15"},
    {"name": "trained_model_v1.pt", "date": "2025-01-20 16:45"},
    {"name": "dataset_train.jsonl", "date": "2025-01-10 08:00"},
    {"name": "README.md", "date": "2025-02-03 11:30"},
    {"name": "config.json", "date": "2025-01-28 13:12"},
    {"name": "output_final.wav", "date": "2025-02-04 22:05"},
]


def show_selection(value):
    if not value or not value.get("selected"):
        return "No files selected"
    selected = value["selected"]
    return f"Selected {len(selected)} file(s):\n" + "\n".join(f"  - {f}" for f in selected)


with gr.Blocks() as demo:
    gr.Markdown("## FileLister Demo")
    gr.Markdown("Click to select, Ctrl+Click for multi-select, Shift+Click for range select.")

    file_list = FileLister(
        value=sample_files,
        label="Project Files",
        height=300,
        interactive=True,
    )

    output = gr.Textbox(label="Selection Info", lines=5)

    file_list.change(show_selection, inputs=file_list, outputs=output)

    with gr.Row():
        delete_btn = gr.Button("Delete Selected", variant="stop")
        refresh_btn = gr.Button("Refresh List")

    def delete_selected(value):
        if not value or not value.get("selected"):
            return value, "Nothing to delete"
        selected_set = set(value["selected"])
        remaining = [f for f in value["files"] if f["name"] not in selected_set]
        deleted_count = len(value["files"]) - len(remaining)
        return remaining, f"Deleted {deleted_count} file(s)"

    def refresh_files():
        return sample_files

    delete_btn.click(delete_selected, inputs=file_list, outputs=[file_list, output])
    refresh_btn.click(refresh_files, outputs=file_list)


if __name__ == "__main__":
    demo.launch()
