'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  adminReadCacheKey,
  getBearerToken,
  isValidOrderTrackingToken,
  validateCatalogue
} = require('./server');

test('accepts catalogue records from Apps Script', () => {
  const input = [{ id: 2, title: 'Book', unitCost: 500, author: 'Writer' }];
  const result = validateCatalogue(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 2);
  assert.equal(result[0].data.author, 'Writer');
});

test('rejects empty catalogue so a sync cannot erase the cache', () => {
  assert.throws(() => validateCatalogue([]), /returned no books/);
});

test('rejects duplicate IDs and invalid prices', () => {
  assert.throws(() => validateCatalogue([
    { id: 1, title: 'First', unitCost: 1 },
    { id: 1, title: 'Second', unitCost: 2 }
  ]), /duplicate book IDs/);
  assert.throws(() => validateCatalogue([{ id: 1, title: 'Bad price', unitCost: 'invalid' }]), /invalid required fields/);
});

test('allows only supported admin read actions and isolates document cache keys', () => {
  assert.equal(adminReadCacheKey('list_documents', {}), 'list_documents');
  assert.equal(adminReadCacheKey('get_document_data', { reference: 'INV-123' }), 'get_document_data:INV-123');
  assert.throws(() => adminReadCacheKey('confirm_invoice_payment', {}), /not supported/);
  assert.throws(() => adminReadCacheKey('get_document_data', { reference: ' ' }), /reference is required/);
});

test('accepts only opaque Apps Script staff session tokens for API authorization', () => {
  assert.equal(getBearerToken({ headers: { authorization: 'Bearer SESSION-abc-123' } }), 'SESSION-abc-123');
  assert.equal(getBearerToken({ headers: { authorization: 'Bearer staff-password' } }), '');
  assert.equal(getBearerToken({ headers: {} }), '');
});

test('accepts only 64-character lowercase hexadecimal order tracking tokens', () => {
  assert.equal(isValidOrderTrackingToken('a'.repeat(64)), true);
  assert.equal(isValidOrderTrackingToken('A'.repeat(64)), false);
  assert.equal(isValidOrderTrackingToken('a'.repeat(63)), false);
  assert.equal(isValidOrderTrackingToken('a'.repeat(64) + 'b'), false);
});
