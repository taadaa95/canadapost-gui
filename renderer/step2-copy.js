'use strict';

(function publish(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Step2Copy = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function apply(document, translate) {
    const explanation = document.getElementById('step2CandidateExplanation');
    if (explanation) explanation.textContent = translate('step2.candidateExplanation');
    const note = document.getElementById('step3CanadaPostSupport');
    if (note) {
      note.textContent = translate('step3.supportGuidance');
      note.setAttribute('aria-label', translate('step3.supportAriaLabel'));
    }
  }

  return { apply };
});
