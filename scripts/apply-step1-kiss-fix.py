from pathlib import Path
import json
import re


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'missing {label}')
    return text.replace(old, new, 1)


# index.html: one visible Step 1 surface; old tracking panel removed.
path = Path('index.html')
text = path.read_text(encoding='utf-8')
if 'id="step1TrackingProgressCount"' not in text:
    text, n = re.subn(
        r'\n\s*<section id="step2".*?</section>\n\n(?=\s*<section id="step3")',
        '\n\n', text, count=1, flags=re.S,
    )
    if n != 1:
        raise SystemExit(f'expected one old Step 2 panel, found {n}')

    top = '''      <section id="step1" class="tab-panel step-panel" role="tabpanel" aria-labelledby="tabStep1">
        <div class="step-top step1-simple-top">
          <div class="step-title-row step1-title-row">
            <div class="step1-heading-copy">
              <h2 data-i18n="step1.title"></h2>
              <p class="step-description" data-i18n="step1.simpleDescription"></p>
            </div>
            <div class="step-actions step-execution-controls step1-primary-actions">
              <button id="importEstHistory" class="success step-execution-control" type="button" data-i18n="step1.start"></button>
              <button id="forceStopStep1" class="danger step-execution-control" type="button" data-force-stop="step1" data-i18n="step1.stop"></button>
            </div>
          </div>
          <input id="estWorkgroup" type="hidden" value="" />
          <input id="estMobo" type="hidden" value="-2" />
          <input id="estCategoryGroup" type="hidden" value="SHP" />
          <input id="estFileTypes" type="hidden" value="1,2" />
          <input id="historyCustomerNumber" type="hidden" />
          <input id="historyMobo" type="hidden" />
          <input id="historyAutoMobo" type="checkbox" checked hidden />
          <input id="historyIncludeNoManifest" type="checkbox" checked hidden />
        </div>'''
    text, n = re.subn(
        r'\s*<section id="step1" class="tab-panel step-panel" role="tabpanel" aria-labelledby="tabStep1">.*?(?=\n\s*<div class="step-workspace">)',
        '\n' + top, text, count=1, flags=re.S,
    )
    if n != 1:
        raise SystemExit(f'expected one Step 1 header, found {n}')

    status = '''        <div class="step-workspace step1-workspace">
          <div class="card step-status-card step1-status-card">
            <div class="row step1-status-heading">
              <h2 data-i18n="step1.statusTitle"></h2>
              <span id="step1RunStatus" class="pill" data-i18n="runStatus.idle"></span>
            </div>
            <div class="status-grid step1-status-grid">
              <div class="stat"><div id="step1Imported" class="num">0</div><div class="label" data-i18n="step1.shipmentsImported"></div></div>
              <div class="stat"><div id="step1TrackingProgressCount" class="num step1-ratio">0 / 0</div><div class="label" data-i18n="step1.checkedImported"></div></div>
              <div class="stat"><div id="late" class="num">0</div><div class="label" data-i18n="step2.lateClaims"></div></div>
              <div id="step1WarningsCard" class="stat stat-clickable" role="button" tabindex="0" data-i18n-aria-label="step1.warningsAria"><div id="step1Warnings" class="num">0</div><div class="label" data-i18n="step1.warningsInspect"></div></div>
            </div>
            <div class="step1-progress-stack">
              <div class="progress-wrap">
                <div class="progress-label"><span data-i18n="step1.importProgress"></span><span id="step1ImportProgressCount">0 / 0</span></div>
                <progress id="step1Progress" max="100" value="0"></progress>
              </div>
              <div class="progress-wrap">
                <div class="progress-label"><span data-i18n="step1.identifyProgress"></span><span id="trackingPct">0%</span></div>
                <progress id="trackingProgress" max="100" value="0"></progress>
              </div>
            </div>
            <div class="current-action" id="step1CurrentAction" data-i18n="status.waiting"></div>
          </div>
          <div class="card step-log-card">'''
    text, n = re.subn(
        r'\s*<div class="step-workspace">\s*<div class="card step-status-card">.*?<div class="card step-log-card">',
        '\n' + status, text, count=1, flags=re.S,
    )
    if n != 1:
        raise SystemExit(f'expected one Step 1 status card, found {n}')
    path.write_text(text, encoding='utf-8')


# renderer.js: tracking is an internal phase of visible Step 1.
path = Path('renderer.js')
text = path.read_text(encoding='utf-8')
if "if (stage === 'tracking') return 'step1';" not in text:
    text, n = re.subn(
        r'function mergeTrackingIntoStep1\(\) \{.*?\n\}',
        "function mergeTrackingIntoStep1() {\n  // Tracking is an internal phase of Step 1. No second panel is mounted.\n}",
        text, count=1, flags=re.S,
    )
    if n != 1:
        raise SystemExit('could not simplify mergeTrackingIntoStep1')
    for old, new, label in [
        ("if (stage === 'tracking') return 'step2';", "if (stage === 'tracking') return 'step1';", 'tracking stage map'),
        ("if (stepId === 'step2') return 'step2Log';", "if (stepId === 'step2') return 'step1Log';", 'tracking log map'),
        ("if (stepId === 'step2') return 'step2RunStatus';", "if (stepId === 'step2') return 'step1RunStatus';", 'tracking status map'),
        ("if (stepId === 'step2') return 'step2CurrentAction';", "if (stepId === 'step2') return 'step1CurrentAction';", 'tracking action map'),
        ("async function startTrackingOnly() {\n  currentProcessStep = 'step2';", "async function startTrackingOnly() {\n  currentProcessStep = 'step1';", 'tracking current step'),
        ("  if (logEl) logEl.textContent = '';", "  if (logEl && step !== 'step2') logEl.textContent = '';", 'combined log preservation'),
    ]:
        text = replace_once(text, old, new, label)

    anchor = "  setText('step1Pct', `${Math.max(0, Math.min(100, step1Pct))}%`);\n"
    text = replace_once(
        text,
        anchor,
        anchor + "  const importProgressTotal = state.step1TotalRows || state.step1Imported || 0;\n  setText('step1ImportProgressCount', `${state.step1Imported} / ${importProgressTotal}`);\n",
        'import progress count anchor',
    )
    anchor = "  setText('trackingPct', `${trackingPct}%`);\n"
    text = replace_once(
        text,
        anchor,
        anchor + "  const trackingProgressTotal = state.trackingTotal || state.step1Imported || 0;\n  setText('step1TrackingProgressCount', `${state.checked} / ${trackingProgressTotal}`);\n",
        'tracking progress count anchor',
    )
    path.write_text(text, encoding='utf-8')


# CSS: natural flow, one button row, no fixed overlapping Step 2 layout.
path = Path('renderer/base.css')
text = path.read_text(encoding='utf-8')
marker = '/* Step 1 KISS two-phase layout */'
if marker not in text:
    text += '''

/* Step 1 KISS two-phase layout */
#step1.step-panel.active {
  display: grid !important;
  grid-template-rows: auto minmax(0, 1fr) !important;
  gap: 16px !important;
  min-height: 0 !important;
  overflow: hidden !important;
}
#step1 .step1-simple-top {
  display: block !important;
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow: visible !important;
}
#step1 .step1-title-row {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) auto !important;
  gap: 18px !important;
  align-items: center !important;
  min-height: 0 !important;
}
#step1 .step1-heading-copy { min-width: 0; }
#step1 .step1-heading-copy h2 { margin: 0 0 6px !important; }
#step1 .step-description {
  margin: 0 !important;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.45;
  max-width: 760px;
}
#step1 .step1-primary-actions {
  display: flex !important;
  grid-template-columns: none !important;
  flex-wrap: nowrap !important;
  gap: 10px !important;
  width: auto !important;
  height: auto !important;
  justify-content: flex-end !important;
  align-items: center !important;
  overflow: visible !important;
}
#step1 .step1-primary-actions .step-execution-control {
  flex: 0 0 auto !important;
  width: 132px !important;
  min-width: 132px !important;
  height: 48px !important;
  min-height: 48px !important;
  position: relative !important;
  z-index: 1 !important;
  pointer-events: auto !important;
}
#step1 .step1-workspace {
  display: grid !important;
  grid-template-columns: minmax(320px, 400px) minmax(0, 1fr) !important;
  gap: 14px !important;
  min-height: 0 !important;
  overflow: hidden !important;
}
#step1 .step1-status-card {
  display: grid !important;
  grid-template-rows: auto auto auto minmax(56px, auto) !important;
  gap: 12px !important;
  min-height: 0 !important;
  overflow: auto !important;
}
#step1 .step1-status-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
#step1 .step1-status-heading h2 { margin: 0 !important; }
#step1 .step1-status-grid {
  display: grid !important;
  grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  grid-template-rows: auto !important;
  gap: 10px !important;
  height: auto !important;
  margin: 0 !important;
}
#step1 .step1-status-grid .stat {
  min-height: 82px !important;
  height: auto !important;
}
#step1 .step1-ratio {
  font-size: 24px !important;
  white-space: nowrap;
}
#step1 .step1-progress-stack {
  display: grid;
  gap: 10px;
}
#step1 .step1-progress-stack .progress-wrap { margin: 0 !important; }
#step1 .step-log-card {
  min-width: 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
}
#step1 .step-log-card .log { min-height: 220px !important; }
@media (max-width: 1050px) {
  #step1.step-panel.active { overflow: auto !important; }
  #step1 .step1-title-row,
  #step1 .step1-workspace { grid-template-columns: minmax(0, 1fr) !important; }
  #step1 .step1-primary-actions { justify-content: flex-start !important; }
  #step1 .step1-workspace { overflow: visible !important; }
}
'''
    path.write_text(text, encoding='utf-8')


# Locale labels.
for filename, values in {
    'locales/en-CA.json': {
        'step1.start': 'Start',
        'step1.stop': 'Stop',
        'step1.simpleDescription': 'Import shipping history, then automatically identify late-delivery candidates.',
        'step1.checkedImported': 'Checked / imported',
        'step1.importProgress': 'Import progress',
        'step1.identifyProgress': 'Late-candidate progress',
    },
    'locales/fr-CA.json': {
        'step1.start': 'Démarrer',
        'step1.stop': 'Arrêter',
        'step1.simpleDescription': 'Importer l’historique des envois, puis identifier automatiquement les candidats livrés en retard.',
        'step1.checkedImported': 'Vérifiés / importés',
        'step1.importProgress': 'Progression de l’importation',
        'step1.identifyProgress': 'Progression des candidats en retard',
    },
}.items():
    path = Path(filename)
    data = json.loads(path.read_text(encoding='utf-8'))
    changed = False
    for key, value in values.items():
        if data.get(key) != value:
            data[key] = value
            changed = True
    if changed:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


# Headless visual regression test with a screenshot artifact.
test = Path('tests/step1-kiss-layout-test.js')
if not test.exists():
    test.write_text("""'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { loadLocale } = require('../lib/i18n');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`file://${path.resolve(__dirname, '../index.html')}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(messages => {
      document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = messages[element.dataset.i18n] || ''; });
      for (const attribute of ['placeholder', 'aria-label', 'title', 'alt']) {
        document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
          element.setAttribute(attribute, messages[element.getAttribute(`data-i18n-${attribute}`)] || '');
        });
      }
      window.initStepTabs();
      window.activateTab('step1');
    }, loadLocale('en-CA').messages);

    assert.strictEqual(await page.locator('#step2').count(), 0, 'old standalone tracking panel must not exist');
    assert.strictEqual(await page.locator('#step1 #importEstHistory:visible').count(), 1, 'Step 1 must have exactly one visible Start button');
    assert.strictEqual(await page.locator('#step1 #forceStopStep1:visible').count(), 1, 'Step 1 must have exactly one visible Stop button');
    assert.strictEqual(await page.locator('#step1 .step-execution-control:visible').count(), 2, 'Step 1 must expose only Start and Stop');

    for (const selector of ['#importEstHistory', '#forceStopStep1']) {
      const clickable = await page.locator(selector).evaluate(button => {
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        return rect.width > 0 && rect.height > 0 && getComputedStyle(button).pointerEvents !== 'none' && (top === button || button.contains(top));
      });
      assert.strictEqual(clickable, true, `${selector} must be unobstructed and clickable`);
    }

    for (const selector of ['#step1Imported', '#step1TrackingProgressCount', '#late', '#step1Progress', '#trackingProgress', '#step1CurrentAction']) {
      assert.strictEqual(await page.locator(selector).isVisible(), true, `${selector} must be visible`);
    }

    const layout = await page.evaluate(() => {
      const rect = selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        title: rect('#step1 .step1-heading-copy'),
        actions: rect('#step1 .step1-primary-actions'),
        workspace: rect('#step1 .step1-workspace'),
        status: rect('#step1 .step1-status-card'),
        log: rect('#step1 .step-log-card'),
      };
    });
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    assert.strictEqual(overlaps(layout.title, layout.actions), false, 'title/description must not overlap Start/Stop');
    assert.strictEqual(overlaps(layout.status, layout.log), false, 'status and live log must not overlap');
    assert(layout.workspace.top >= Math.min(layout.title.bottom, layout.actions.bottom), 'workspace must flow below header controls');

    const artifactDir = path.resolve(__dirname, '../dist/test-artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    await page.locator('#step1').screenshot({ path: path.join(artifactDir, 'step1-kiss-layout.png') });
  } finally {
    await browser.close();
  }
  process.stdout.write('Step 1 KISS layout and clickability tests passed.\\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
""", encoding='utf-8')
