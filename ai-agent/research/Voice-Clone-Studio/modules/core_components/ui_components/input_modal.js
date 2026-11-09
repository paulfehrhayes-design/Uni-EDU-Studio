// Global validation function storage
window.inputModalValidation = null;
// Existing files list for overwrite detection (set before opening modal)
window.inputModalExistingFiles = null;

function _normalizeInputName(name) {
  // Match the Python cleaning: keep alphanumeric, dash, underscore, space; replace spaces with _
  return name.replace(/[^a-zA-Z0-9\-_ ]/g, '').trim().replace(/ /g, '_');
}

function _showConfirmBar() {
  const confirmBar = document.getElementById('input-modal-confirm-bar');
  const mainActions = document.getElementById('input-modal-main-actions');
  const inputField = document.getElementById('input-modal-field');
  if (confirmBar) confirmBar.classList.add('show');
  if (mainActions) mainActions.style.display = 'none';
  if (inputField) inputField.disabled = true;
}

function _hideConfirmBar() {
  const confirmBar = document.getElementById('input-modal-confirm-bar');
  const mainActions = document.getElementById('input-modal-main-actions');
  const inputField = document.getElementById('input-modal-field');
  if (confirmBar) confirmBar.classList.remove('show');
  if (mainActions) mainActions.style.display = '';
  if (inputField) {
    inputField.disabled = false;
    inputField.focus();
  }
}

function _forceSubmit() {
  // Skip overwrite check and submit directly
  const submitBtn = document.getElementById('input-modal-submit-btn');
  _hideConfirmBar();
  window.inputModalExistingFiles = null; // Clear so check is skipped
  submitInputModalValue('submit', submitBtn);
}

function submitInputModalValue(action, button) {
  const overlay = document.getElementById('input-modal-overlay');
  const inputField = document.getElementById('input-modal-field');
  const errorEl = document.getElementById('input-modal-error');

  if (!overlay || !inputField) return;

  let valueToSubmit = '';

  if (action === 'submit') {
    valueToSubmit = inputField.value.trim();

    // Run validation if provided
    if (window.inputModalValidation) {
      const error = window.inputModalValidation(valueToSubmit);
      if (error) {
        // Show error by replacing message text
        const messageEl = document.getElementById('input-modal-message');
        if (messageEl) {
          // Store original message if not already stored
          if (!messageEl.dataset.originalMessage) {
            messageEl.dataset.originalMessage = messageEl.textContent;
          }
          // Replace message with error
          messageEl.classList.remove('error');
          void messageEl.offsetWidth; // Force reflow
          messageEl.textContent = error;
          messageEl.classList.add('error');
        }
        return; // Stop here, don't close modal or trigger
      }
    }

    // Check for overwrite if existing files list is provided
    if (window.inputModalExistingFiles && Array.isArray(window.inputModalExistingFiles)) {
      const cleanName = _normalizeInputName(valueToSubmit).toLowerCase();
      if (cleanName && window.inputModalExistingFiles.some(f => f.toLowerCase() === cleanName)) {
        _showConfirmBar();
        return; // Don't submit yet, wait for overwrite confirmation
      }
    }
  } else {
    overlay.classList.remove('show');
    inputField.value = '';
    inputField.disabled = false;
    if (errorEl) {
      errorEl.classList.remove('show');
    }
    window.inputModalValidation = null;
    window.inputModalExistingFiles = null;
    _hideConfirmBar();
    return; // Exit without triggering anything
  }

  overlay.classList.remove('show');
  inputField.value = '';
  inputField.disabled = false;
  if (errorEl) {
    errorEl.classList.remove('show');
  }
  window.inputModalValidation = null;
  window.inputModalExistingFiles = null;
  _hideConfirmBar();

  // Get context from button's data attribute
  const context = button ? button.getAttribute('data-context') || '' : '';
  const prefixedValue = context + valueToSubmit;

  // Find the trigger element
  function findTrigger() {
    // Try various selectors for Gradio 5+ compatibility
    let trigger = document.querySelector('#input-trigger textarea');
    if (trigger) return trigger;

    trigger = document.querySelector('#input-trigger input[type="text"]');
    if (trigger) return trigger;

    trigger = document.querySelector('#input-trigger input');
    if (trigger) return trigger;

    const container = document.querySelector('[id="input-trigger"]');
    if (container) {
      trigger = container.querySelector('textarea, input');
      if (trigger) return trigger;
    }

    const allInputs = document.querySelectorAll('textarea, input[type="text"]');
    for (let input of allInputs) {
      const parent = input.closest('[id="input-trigger"]');
      if (parent) return input;
    }

    return null;
  }

  const trigger = findTrigger();

  if (trigger) {
    const newValue = prefixedValue + '_' + Date.now();
    trigger.value = newValue;

    trigger.dispatchEvent(new Event('input', { bubbles: true }));
    trigger.dispatchEvent(new Event('change', { bubbles: true }));
    const evt = new InputEvent('input', { bubbles: true, cancelable: true });
    trigger.dispatchEvent(evt);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('input-modal-overlay');
  if (!overlay) return;

  // Close on overlay click
  overlay.addEventListener('click', function(e) {
    if (e.target === this) {
      submitInputModalValue('cancel');
    }
  });

  // Handle Enter key in input field
  const inputField = document.getElementById('input-modal-field');
  if (inputField) {
    inputField.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const submitBtn = document.getElementById('input-modal-submit-btn');
        if (submitBtn) {
          submitInputModalValue('submit', submitBtn);
        }
      }
    });

    // Clear error on input
    inputField.addEventListener('input', function() {
      const messageEl = document.getElementById('input-modal-message');
      if (messageEl && messageEl.classList.contains('error')) {
        messageEl.classList.remove('error');
        if (messageEl.dataset.originalMessage) {
          messageEl.textContent = messageEl.dataset.originalMessage;
        }
      }
      // Hide confirm bar when user edits the name
      _hideConfirmBar();
    });
  }

});

// Close on Escape key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    const overlay = document.getElementById('input-modal-overlay');
    if (overlay && overlay.classList.contains('show')) {
      submitInputModalValue('cancel');
    }
  }
});
