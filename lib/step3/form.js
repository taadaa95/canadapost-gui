'use strict';

function isFinalSubmissionLabel(value) {
  return /(?:create\s+(?:service\s+)?ticket|submit\s+(?:claim|ticket|request|inquiry)|send\s+(?:claim|request|inquiry)|confirm(?:\s+(?:claim|ticket|request|submission|inquiry))?|complete(?:\s+(?:claim|ticket|request|submission|inquiry))?|finish(?:\s+(?:claim|ticket|request|submission|inquiry))?|open\s+(?:service\s+)?ticket|cr[ée]er\s+(?:un\s+)?(?:billet|demande)|soumettre\s+(?:la\s+)?(?:demande|r[ée]clamation))/i
    .test(String(value || '').replace(/\s+/g, ' ').trim());
}

module.exports = { isFinalSubmissionLabel };
