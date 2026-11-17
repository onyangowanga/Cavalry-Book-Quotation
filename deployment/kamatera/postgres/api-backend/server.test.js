'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCatalogue } = require('./server');

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
