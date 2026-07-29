'use strict';

const fs = require('fs');
const path = require('path');

const SUPPORTED_LOCALES = Object.freeze(['en-CA', 'fr-CA']);

/** @typedef {{locale: string, messages: Record<string, string>}} LocaleBundle */

/** @param {unknown} locale @returns {'en-CA' | 'fr-CA'} */
function normalizeLocale(locale) {
  return String(locale || '').toLowerCase().startsWith('fr') ? 'fr-CA' : 'en-CA';
}

/** @param {unknown} locale @param {string} root @returns {LocaleBundle} */
function loadLocale(locale, root = path.resolve(__dirname, '..')) {
  const normalized = normalizeLocale(locale);
  const messages = JSON.parse(fs.readFileSync(path.join(root, 'locales', `${normalized}.json`), 'utf8'));
  return { locale: normalized, messages };
}

/** @param {LocaleBundle | undefined} bundle @param {string} key @param {string} fallback @returns {string} */
function translate(bundle, key, fallback = '') {
  return String(bundle?.messages?.[key] ?? (fallback || key));
}

/** @param {string} root @returns {string[]} */
function assertLocaleCompleteness(root = path.resolve(__dirname, '..')) {
  const bundles = SUPPORTED_LOCALES.map(locale => loadLocale(locale, root));
  const baseline = Object.keys(bundles[0].messages).sort();
  for (const bundle of bundles.slice(1)) {
    const keys = Object.keys(bundle.messages).sort();
    if (JSON.stringify(keys) !== JSON.stringify(baseline)) throw new Error(`Locale ${bundle.locale} has missing or extra translation keys.`);
    for (const key of keys) if (!String(bundle.messages[key]).trim()) throw new Error(`Locale ${bundle.locale} has an empty value for ${key}.`);
  }
  return baseline;
}

module.exports = { SUPPORTED_LOCALES, normalizeLocale, loadLocale, translate, assertLocaleCompleteness };
