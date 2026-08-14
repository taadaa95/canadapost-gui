'use strict';

const { XMLParser, XMLValidator, XMLBuilder } = require('fast-xml-parser');

const MAX_XML_BYTES = 10 * 1024 * 1024;

function rejectUnsafeXml(xml, label = 'XML') {
  const text = String(xml || '');
  if (Buffer.byteLength(text) > MAX_XML_BYTES) throw new Error(`${label} exceeds the 10 MiB XML limit.`);
  if (/<!DOCTYPE|<!ENTITY|SYSTEM\s+["']|PUBLIC\s+["']/i.test(text)) throw new Error(`${label} contains a prohibited DTD or entity declaration.`);
  const validation = XMLValidator.validate(text);
  if (validation !== true) throw new Error(`${label} is malformed XML.`);
  return text;
}

function parseXmlSecure(xml, label = 'XML') {
  const text = rejectUnsafeXml(xml, label);
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: false,
    htmlEntities: false,
    allowBooleanAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true
  }).parse(text);
}

function localKey(key) {
  return String(key || '').replace(/^.*:/, '').toLowerCase();
}

function findAll(node, wanted) {
  const target = String(wanted || '').toLowerCase();
  const found = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) {
      if (localKey(key) === target) found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
}

function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value).trim();
  if (Object.prototype.hasOwnProperty.call(value, '#text')) return String(value['#text'] || '').trim();
  return '';
}

function firstText(node, names) {
  for (const name of Array.isArray(names) ? names : [names]) {
    for (const value of findAll(node, name)) {
      const text = scalar(value);
      if (text) return text;
    }
  }
  return '';
}

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildXml(value) {
  return new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: false, suppressEmptyNode: false }).build(value);
}

module.exports = { MAX_XML_BYTES, rejectUnsafeXml, parseXmlSecure, findAll, firstText, scalar, escapeXml, buildXml };
