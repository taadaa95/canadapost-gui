'use strict';

(function publish(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UpdateProgress = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    return `${(bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  }

  function ensure(document, translate, cancel) {
    let overlay = document.getElementById('updateProgressOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'updateProgressOverlay';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'updateProgressTitle');
    const card = document.createElement('div');
    card.className = 'update-progress-card';
    card.innerHTML = '<div id="updateProgressTitle" class="update-progress-title"></div><div id="updateProgressStage" class="update-progress-stage"></div><div class="update-progress-track" aria-hidden="true"><div id="updateProgressFill" class="update-progress-fill"></div></div><div id="updateProgressPercent" class="update-progress-percent"></div><div id="updateProgressDetail" class="update-progress-detail"></div><button id="updateProgressCancel" type="button"></button>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.querySelector('#updateProgressTitle').textContent = translate('update.progress.title');
    overlay.querySelector('#updateProgressCancel').addEventListener('click', async () => {
      const button = overlay.querySelector('#updateProgressCancel');
      button.disabled = true;
      button.textContent = translate('update.progress.cancelling');
      await cancel();
    });
    return overlay;
  }

  function render(document, payload, translate, cancel) {
    const overlay = ensure(document, translate, cancel);
    if (payload.stage === 'hidden') { overlay.hidden = true; return; }
    overlay.hidden = false;
    const stage = overlay.querySelector('#updateProgressStage');
    const track = overlay.querySelector('.update-progress-track');
    const fill = overlay.querySelector('#updateProgressFill');
    const percent = overlay.querySelector('#updateProgressPercent');
    const detail = overlay.querySelector('#updateProgressDetail');
    const cancelButton = overlay.querySelector('#updateProgressCancel');
    stage.textContent = translate(`update.progress.stage.${payload.stage || 'processing'}`).replace('{version}', String(payload.version || ''));
    cancelButton.disabled = !payload.cancellable;
    cancelButton.hidden = !payload.cancellable;
    cancelButton.textContent = translate('update.progress.cancel');
    if (payload.stage === 'downloading' && Number.isFinite(payload.ratio)) {
      const value = Math.floor(Math.max(0, Math.min(Number(payload.ratio), 1)) * 100);
      track.classList.remove('indeterminate');
      fill.style.width = `${value}%`;
      percent.textContent = `${value}%`;
      detail.textContent = `${formatBytes(payload.received)} / ${formatBytes(payload.total)}`;
    } else if (payload.stage === 'ready') {
      track.classList.remove('indeterminate');
      fill.style.width = '100%';
      percent.textContent = '100%';
      detail.textContent = translate('update.progress.verified');
    } else {
      track.classList.add('indeterminate');
      fill.style.width = '';
      percent.textContent = '';
      detail.textContent = '';
    }
  }

  return { formatBytes, ensure, render };
});
