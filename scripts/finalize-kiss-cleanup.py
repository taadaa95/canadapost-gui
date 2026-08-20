from pathlib import Path


def replace_once(text, old, new, label):
    if old in text:
        return text.replace(old, new, 1)
    if new in text:
        return text
    raise SystemExit(f'{label} anchor missing')


p = Path('tests/localization-test.js')
s = p.read_text(encoding='utf-8')
old = "assert(localizedAttributes.length >= 200, 'major interface text and accessibility attributes must use declarative localization after removing obsolete controls');\n"
new = """const requiredLocalizedDomKeys = [
  'nav.settings.title', 'nav.step1.title', 'nav.step3.title', 'nav.history.title', 'nav.results.title',
  'settings.save', 'step1.title', 'step1.start', 'step1.stop', 'step1.shipmentsImported',
  'step1.checkedImported', 'step1.importProgress', 'step1.identifyProgress', 'step1.liveLog', 'step3.title'
];
assert(localizedAttributes.length > 0, 'interface must retain declarative localization attributes');
for (const key of requiredLocalizedDomKeys) {
  assert(localizedAttributes.includes(key), `major localized interface control is missing from the DOM: ${key}`);
}
"""
s = replace_once(s, old, new, 'localization')
p.write_text(s, encoding='utf-8')

p = Path('tests/product-ui-cleanup-test.js')
s = p.read_text(encoding='utf-8')
old = "  assert.match(html, /id=\"forceStopStep2\"[^>]*data-force-stop=\"step2\"/);\n"
new = """  assert.match(html, /id=\"forceStopStep1\"[^>]*data-force-stop=\"step1\"/, 'Step 1 must expose one stop control for both import and tracking');
  assert.doesNotMatch(html, /id=\"forceStopStep2\"/, 'The removed standalone tracking phase must not expose a second stop button');
"""
s = replace_once(s, old, new, 'product cleanup')
p.write_text(s, encoding='utf-8')

p = Path('tests/ui-contract-test.js')
s = p.read_text(encoding='utf-8')
for old, new in {
    "  'forceStopStep2', 'step1JumpLatest', 'step2JumpLatest', 'step3JumpLatest',\n": "  'forceStopStep1', 'step1JumpLatest', 'step3JumpLatest',\n",
    "assert.match(html, /id=\"forceStopStep2\"[^>]*data-force-stop=\"step2\"/);\n": "assert.match(html, /id=\"forceStopStep1\"[^>]*data-force-stop=\"step1\"/);\nassert.doesNotMatch(html, /id=\"forceStopStep2\"/);\n",
    "for (const id of ['importEstHistory', 'forceStopStep1', 'forceStopStep2', 'runSubmitOnly', 'stop', 'forceStopStep3']) {\n": "for (const id of ['importEstHistory', 'forceStopStep1', 'runSubmitOnly', 'stop', 'forceStopStep3']) {\n",
}.items():
    if old in s:
        s = s.replace(old, new, 1)
    elif new not in s:
        raise SystemExit(f'ui-contract anchor missing: {old}')
p.write_text(s, encoding='utf-8')

p = Path('tests/live-log-layout-test.js')
s = p.read_text(encoding='utf-8')
s = s.replace("window.activateTab('step2');\n      document.getElementById('step2Log').replaceChildren();", "window.activateTab('step1');\n      document.getElementById('step1Log').replaceChildren();")
s = s.replace("document.querySelectorAll('#step2Log .log-line')", "document.querySelectorAll('#step1Log .log-line')")
s = s.replace("document.getElementById('step2Log').replaceChildren();", "document.getElementById('step1Log').replaceChildren();")
if 'step2Log' in s:
    raise SystemExit('stale step2Log remains')
p.write_text(s, encoding='utf-8')

p = Path('renderer/base.css')
s = p.read_text(encoding='utf-8')
marker = '/* Step 1 KISS two-phase layout */'
if marker not in s:
    raise SystemExit('Step 1 CSS marker missing')
clean = r'''/* Step 1 KISS two-phase layout */
#step1.step-panel.active { gap: 16px !important; }

#step1 .step1-simple-top {
  display: block !important;
  height: auto;
  min-height: 0;
  max-height: none;
  overflow: visible;
}

#step1 .step1-title-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 18px;
  align-items: center;
  min-height: 0;
}

#step1 .step1-heading-copy { min-width: 0; }
#step1 .step1-heading-copy h2 { margin: 0 0 6px; }
#step1 .step-description { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; max-width: 760px; }

#step1 .step1-primary-actions {
  flex-wrap: nowrap !important;
  width: auto;
  overflow: visible;
}

#step1 .step1-primary-actions .step-execution-control {
  width: 132px !important;
  min-width: 132px !important;
  flex: 0 0 auto;
  position: relative;
  z-index: 1;
  pointer-events: auto;
}

#step1 .step1-workspace {
  grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
  gap: 14px !important;
}

#step1 .step1-status-card {
  grid-template-rows: auto auto auto minmax(56px, auto);
  overflow: auto !important;
}

#step1 .step1-status-heading { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
#step1 .step1-status-heading h2 { margin: 0; }
#step1 .step1-status-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: auto; gap: 10px; height: auto; margin: 0; }
#step1 .step1-status-grid .stat { min-height: 82px; height: auto; }
#step1 .step1-ratio { font-size: 24px; white-space: nowrap; }
#step1 .step1-progress-stack { display: grid; gap: 10px; }
#step1 .step1-progress-stack .progress-wrap { margin: 0; }

@media (max-width: 1050px) {
  #step1.step-panel.active { overflow: auto !important; }
  #step1 .step1-title-row,
  #step1 .step1-workspace { grid-template-columns: minmax(0, 1fr); }
  #step1 .step1-primary-actions { justify-content: flex-start !important; }
  #step1 .step1-workspace { overflow: visible !important; }
}
'''
p.write_text(s[:s.index(marker)] + clean, encoding='utf-8')
