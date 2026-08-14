'use strict';

const PROTECTED_OPERATIONS = Object.freeze([
  'step1_import',
  'step2_diagnostic',
  'step2_structure_export',
  'step2_bulk_run',
  'step3_dry_run',
  'step3_live_run',
  'setup_assistant',
  'backup_creation',
  'backup_restore',
  'database_migration',
  'database_recovery',
  'privacy_deletion',
  'authoritative_data_mutation'
]);

class OperationActiveError extends Error {
  constructor(operation) {
    super(`Protected operation is active: ${operation}.`);
    this.name = 'OperationActiveError';
    this.code = 'PROTECTED_OPERATION_ACTIVE';
    this.operation = operation;
  }
}

class OperationCoordinator {
  constructor() {
    this.active = new Map();
    this.sequence = 0;
    this.updateLocked = false;
  }

  begin(operation, details = {}) {
    if (this.updateLocked) {
      const error = new Error('Update installation is preparing; new protected operations are blocked.');
      error.code = 'UPDATE_INSTALL_IN_PROGRESS';
      throw error;
    }
    const name = String(operation || '');
    if (!PROTECTED_OPERATIONS.includes(name)) throw new Error(`Unsupported protected operation: ${name || 'empty'}.`);
    const blocking = this.blockingOperation();
    if ((name === 'setup_assistant' && blocking) || (name !== 'setup_assistant' && this.hasActive('setup_assistant'))) {
      throw new OperationActiveError(blocking || 'setup_assistant');
    }
    const token = `${process.pid}-${++this.sequence}`;
    this.active.set(token, Object.freeze({
      token,
      operation: name,
      startedAt: new Date().toISOString(),
      details: Object.freeze({ code: String(details.code || '').slice(0, 80) })
    }));
    return token;
  }

  end(token) {
    return this.active.delete(String(token || ''));
  }

  current() {
    return [...this.active.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  blockingOperation() {
    return this.current()[0]?.operation || '';
  }

  isActive() {
    return this.active.size > 0;
  }

  hasActive(operation) {
    const name = String(operation || '');
    return this.current().some(entry => entry.operation === name);
  }

  assertInactive() {
    const operation = this.blockingOperation();
    if (operation) throw new OperationActiveError(operation);
    return true;
  }

  lockForUpdate() {
    this.assertInactive();
    this.updateLocked = true;
  }

  unlockForUpdate() {
    this.updateLocked = false;
  }

  async run(operation, callback, details = {}) {
    const token = this.begin(operation, details);
    try {
      return await callback();
    } finally {
      this.end(token);
    }
  }

  resetForTests() {
    this.active.clear();
    this.updateLocked = false;
  }
}

const coordinator = new OperationCoordinator();

module.exports = {
  PROTECTED_OPERATIONS,
  OperationActiveError,
  OperationCoordinator,
  coordinator
};
