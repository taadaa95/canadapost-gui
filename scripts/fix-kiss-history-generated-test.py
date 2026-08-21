from pathlib import Path

p = Path(__file__).resolve().parents[1] / 'tests' / 'history-status-model-test.js'
text = p.read_text(encoding='utf-8')
text = text.replace("\\'use strict\\';", "'use strict';", 1)
text = text.replace("    const attention = db.beginClaimAttempt(dbPath, { trackingNumber: 'ATTENTION-1' });\n", "    db.beginClaimAttempt(dbPath, { trackingNumber: 'ATTENTION-1' });\n", 1)
text = text.replace("passed.\\\\n');", "passed.\\n');", 1)
text = text.replace("error.message}\\\\n`);", "error.message}\\n`);", 1)
p.write_text(text, encoding='utf-8')
