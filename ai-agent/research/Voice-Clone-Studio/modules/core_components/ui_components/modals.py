"""
Reusable confirmation modal for Gradio applications.
Provides a styled confirmation dialog that matches the Gradio theme.

Usage:
    1. Import CONFIRMATION_MODAL_CSS, CONFIRMATION_MODAL_HEAD, CONFIRMATION_MODAL_HTML
    2. Pass css and head to demo.launch(css=CONFIRMATION_MODAL_CSS, head=CONFIRMATION_MODAL_HEAD, ...)
    3. Add CONFIRMATION_MODAL_HTML via gr.HTML() in your UI
    4. Add a hidden confirm_trigger textbox with elem_id="confirm-trigger"
    5. Use show_confirmation_modal_js() for button click handlers
    6. In your callback, filter empty actions: if not action or not action.strip(): return gr.update(), gr.update()

Note: The callback will be triggered twice per button click (once with action, once with empty string).
      This is expected behavior. Simply filter out empty calls in your callback function.
"""


def show_confirmation_modal_js(title, message, confirm_button_text="Delete", context=""):
    """
    Generate JavaScript function to show the confirmation modal.

    Args:
        title: Modal title (e.g., "Delete Sample?")
        message: Modal message (e.g., "This will permanently delete the sample.")
        confirm_button_text: Text for the confirm button (default: "Delete")
        context: Context prefix for action (e.g., "sample_", "output_", "cache_")

    Returns:
        JavaScript function string to use in Gradio's .click(js=...) parameter
    """
    return f"""
    () => {{
        const overlay = document.getElementById('delete-modal-overlay');
        if (!overlay) return '';
        const titleEl = document.getElementById('confirm-modal-title');
        const messageEl = document.getElementById('confirm-modal-message');
        const actionBtn = document.getElementById('confirm-modal-action-btn');
        const cancelBtn = document.getElementById('confirm-modal-cancel-btn');

        if (titleEl) titleEl.textContent = {title!r};
        if (messageEl) messageEl.textContent = {message!r};
        if (actionBtn) {{
            actionBtn.textContent = {confirm_button_text!r};
            actionBtn.setAttribute('data-context', {context!r});
        }}
        if (cancelBtn) {{
            cancelBtn.setAttribute('data-context', {context!r});
        }}

        overlay.classList.add('show');
        return '';
    }}
    """


def create_confirmation_workflow(button, confirm_callback, cancel_callback=None,
                                 title="Confirm Action", message="Are you sure?",
                                 confirm_button_text="Confirm"):
    """
    Helper to set up a complete confirmation workflow with a button.

    Args:
        button: Gradio Button component
        confirm_callback: Function to call when user confirms (receives inputs)
        cancel_callback: Optional function to call when user cancels
        title: Modal title
        message: Modal message
        confirm_button_text: Text for confirm button

    Returns:
        tuple: (confirm_trigger component, js_function)
        You need to add confirm_trigger to your UI (can be hidden)
    """
    import gradio as gr

    # Create hidden trigger
    confirm_trigger = gr.Textbox(visible=False, elem_id="confirm-trigger")

    # JavaScript to show modal
    js_func = show_confirmation_modal_js(title, message, confirm_button_text)

    return confirm_trigger, js_func


def show_input_modal_js(title, message="", placeholder="Enter text...", default_value="", submit_button_text="Save", context="", validation_js=""):
    """
    Generate JavaScript function to show the input modal.

    Args:
        title: Modal title (e.g., "Enter Emotion Name")
        message: Optional message/instruction (e.g., "Enter a name for the preset:")
        placeholder: Placeholder text for input field
        default_value: Default value to pre-fill (can be Gradio variable)
        submit_button_text: Text for the submit button (default: "Save")
        context: Context prefix for the submitted value (e.g., "emotion_", "sample_")
        validation_js: Optional JavaScript validation function that takes a value and returns error message or null

    Returns:
        JavaScript function string to use in Gradio's .click(js=...) parameter
    """
    validation_setup = ""
    if validation_js:
        validation_setup = f"window.inputModalValidation = {validation_js};"

    return f"""
    (defaultVal) => {{
        const overlay = document.getElementById('input-modal-overlay');
        if (!overlay) return '';

        const titleEl = document.getElementById('input-modal-title');
        const messageEl = document.getElementById('input-modal-message');
        const inputField = document.getElementById('input-modal-field');
        const submitBtn = document.getElementById('input-modal-submit-btn');
        const cancelBtn = document.getElementById('input-modal-cancel-btn');
        const errorEl = document.getElementById('input-modal-error');

        if (titleEl) titleEl.textContent = {title!r};
        if (messageEl) {{
            messageEl.textContent = {message!r};
            messageEl.style.display = {message!r} ? 'block' : 'none';
        }}
        if (inputField) {{
            inputField.placeholder = {placeholder!r};
            inputField.value = defaultVal || '';
        }}
        if (submitBtn) {{
            submitBtn.textContent = {submit_button_text!r};
            submitBtn.setAttribute('data-context', {context!r});
        }}
        if (cancelBtn) {{
            cancelBtn.setAttribute('data-context', {context!r});
        }}
        if (errorEl) {{
            errorEl.classList.remove('show');
            errorEl.textContent = '';
        }}

        {validation_setup}

        overlay.classList.add('show');

        // Focus the input field after a brief delay
        setTimeout(() => {{
            if (inputField) {{
                inputField.focus();
                inputField.select();
            }}
        }}, 100);

        return '';
    }}
    """
