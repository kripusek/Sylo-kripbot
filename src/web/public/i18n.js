// Explicit translation calls for browser-generated dashboard UI. Never scan
// the DOM: server names, messages and values written by users must stay intact.
(() => {
  window.syloT = (text) =>
    window.syloTranslate ? window.syloTranslate(text, document.documentElement.lang) : String(text ?? '');
  // Changing locale requires a render in the selected language. Let the user
  // keep working if a form contains unsaved edits.
  const dirtyForms = new Set();
  const markDirty = (event) => {
    const form = event.target.closest('form');
    if (form && !event.target.matches('[type="search"]')) dirtyForms.add(form);
  };
  document.addEventListener('input', markDirty);
  document.addEventListener('change', markDirty);
  document.addEventListener('htmx:afterRequest', (event) => {
    if (event.detail.successful) {
      const form = event.detail.elt?.closest('form');
      if (form) dirtyForms.delete(form);
    }
  });
  document.addEventListener('click', (event) => {
    const link = event.target.closest('.language-switch a');
    if (
      link &&
      [...dirtyForms].some((form) => form.isConnected) &&
      !window.confirm(window.syloT('You have unsaved changes. Switch language and discard them?'))
    )
      event.preventDefault();
  });
})();
