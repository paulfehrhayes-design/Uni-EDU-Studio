function confirmModalAction(action, button) {
  console.log('confirmModalAction called with:', action);

  const overlay = document.getElementById('delete-modal-overlay');
  if (overlay) {
    overlay.classList.remove('show');
  }

  // Cancel = just close the modal, no backend call needed
  if (action === 'cancel') {
    console.log('Modal cancelled, no trigger update');
    return;
  }

  // Get context from button's data attribute
  const context = button ? button.getAttribute('data-context') || '' : '';
  const prefixedAction = context + action;
  console.log('Prefixed action:', prefixedAction);

  // Try to find the trigger - Gradio 5+ has different DOM structure
  function findTrigger() {
    // Try various selectors
    let trigger = document.querySelector('#confirm-trigger textarea');
    if (trigger) return trigger;

    trigger = document.querySelector('#confirm-trigger input[type="text"]');
    if (trigger) return trigger;

    trigger = document.querySelector('#confirm-trigger input');
    if (trigger) return trigger;

    // Try finding by data attribute or class
    const container = document.querySelector('[id="confirm-trigger"]');
    if (container) {
      trigger = container.querySelector('textarea, input');
      if (trigger) return trigger;
    }

    // Try searching in all textboxes for one that's hidden
    const allInputs = document.querySelectorAll('textarea, input[type="text"]');
    for (let input of allInputs) {
      const parent = input.closest('[id="confirm-trigger"]');
      if (parent) return input;
    }

    return null;
  }

  const trigger = findTrigger();

  if (trigger) {
    const newValue = prefixedAction + '_' + Date.now();
    console.log('Setting trigger value to:', newValue);
    trigger.value = newValue;

    trigger.dispatchEvent(new Event('input', { bubbles: true }));
    trigger.dispatchEvent(new Event('change', { bubbles: true }));
    const evt = new InputEvent('input', { bubbles: true, cancelable: true });
    trigger.dispatchEvent(evt);

    console.log('Events dispatched, trigger value is now:', trigger.value);
  } else {
    console.error('Could not find confirm-trigger element');
    console.log('Available elements with confirm-trigger id:', document.querySelectorAll('[id*="confirm-trigger"]'));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('DOMContentLoaded - setting up modal listeners');
  const overlay = document.getElementById('delete-modal-overlay');
  if (!overlay) {
    console.error('Modal overlay not found!');
    return;
  }
  overlay.addEventListener('click', function(e) {
    if (e.target === this) {
      confirmModalAction('cancel');
    }
  });
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    const overlay = document.getElementById('delete-modal-overlay');
    if (overlay && overlay.classList.contains('show')) {
      confirmModalAction('cancel');
    }
  }
});
