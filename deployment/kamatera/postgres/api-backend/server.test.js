'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  adminReadCacheKey,
  buildPaymentLinkUrl,
  buildMpesaStkPayload,
  getCallbackMetadata,
  getBearerToken,
  getMpesaPassword,
  getMpesaTimestamp,
  isValidOrderTrackingToken,
  isValidPaymentLinkToken,
  normalizeKenyanPhone,
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

test('normalizes only valid Kenyan M-Pesa phone numbers', () => {
  assert.equal(normalizeKenyanPhone('0712 345 678'), '254712345678');
  assert.equal(normalizeKenyanPhone('+254 112 345 678'), '254112345678');
  assert.equal(normalizeKenyanPhone('712345678'), '254712345678');
  assert.equal(normalizeKenyanPhone('254012345678'), '');
  assert.equal(normalizeKenyanPhone('0712'), '');
});

test('builds the STK timestamp in Nairobi time and the documented password value', () => {
  assert.equal(getMpesaTimestamp(new Date('2025-01-02T21:04:05.000Z')), '20250103000405');
  assert.equal(getMpesaPassword('174379', 'passkey', '20250103000405'),
    Buffer.from('174379passkey20250103000405').toString('base64'));
});

test('builds a Buy Goods STK request with the configured invoice amount and callback', () => {
  const payload = buildMpesaStkPayload({
    businessShortCode: '7637201',
    tillNumber: '5675635',
    passkey: 'test-passkey',
    callbackUrl: 'https://api.example.test/api/v1/mpesa/callback',
    phone: '254712345678',
    amount: 1250,
    requestId: '12345678-1234-1234-1234-123456789012',
    timestamp: '20250103000405'
  });
  assert.equal(payload.BusinessShortCode, '7637201');
  assert.equal(payload.TransactionType, 'CustomerBuyGoodsOnline');
  assert.equal(payload.PartyA, '254712345678');
  assert.equal(payload.PartyB, '5675635');
  assert.equal(payload.Amount, 1250);
  assert.equal(payload.CallBackURL, 'https://api.example.test/api/v1/mpesa/callback');
  assert.equal(payload.Password, Buffer.from('7637201test-passkey20250103000405').toString('base64'));
});

test('validates payment tokens and extracts callback metadata', () => {
  assert.equal(isValidPaymentLinkToken('b'.repeat(64)), true);
  assert.equal(isValidPaymentLinkToken('b'.repeat(63)), false);
  assert.equal(buildPaymentLinkUrl('https://api.example.test', 'b'.repeat(64)),
    `https://api.example.test/admin/payment.html#${'b'.repeat(64)}`);
  assert.deepEqual(getCallbackMetadata({
    CallbackMetadata: { Item: [
      { Name: 'Amount', Value: 500 },
      { Name: 'MpesaReceiptNumber', Value: 'QAB1234567' }
    ] }
  }), { Amount: 500, MpesaReceiptNumber: 'QAB1234567' });
});
