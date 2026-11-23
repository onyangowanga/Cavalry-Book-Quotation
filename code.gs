// Reads the 'security' sheet as a username/password table (col A = username, col B = password, row 1 = headers).
function getStaffCredentials(ss) {
  const securitySheet = ss.getSheetByName('security');
  if (!securitySheet) {
    throw new Error("Tab named 'security' not found.");
  }
  const rows = securitySheet.getDataRange().getDisplayValues();
  const credentials = [];
  for (let i = 1; i < rows.length; i++) {
    const username = String(rows[i][0] || '').trim();
    const password = String(rows[i][1] || '').trim();
    if (!username && !password) continue;
    credentials.push({ username, password });
  }
  return credentials;
}

// Any valid password from the security sheet grants access to shared admin-only routes.
function isValidStaffPassword(ss, password) {
  const supplied = String(password || '').trim();
  if (!supplied) return false;
  if (supplied.startsWith('SESSION-')) return Boolean(CacheService.getScriptCache().get(supplied));
  return getStaffCredentials(ss).some(entry => entry.password === supplied);
}

function verifyStaffCredentials(ss, username, password) {
  const suppliedUsername = String(username || '').trim().toLowerCase();
  const suppliedPassword = String(password || '').trim();
  if (!suppliedUsername || !suppliedPassword) return false;
  return getStaffCredentials(ss).some(entry => entry.username.toLowerCase() === suppliedUsername && entry.password === suppliedPassword);
}

function secureStringEquals(expected, supplied) {
  const left = String(expected || '');
  const right = String(supplied || '');
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

// Keeps a running directory of clients so staff aren't re-typing the same name/phone every time.
function getCustomersSheet(ss) {
  let sheet = ss.getSheetByName('customers');
  if (!sheet) {
    sheet = ss.insertSheet('customers');
    sheet.appendRow(['Client Name', 'Client Phone', 'Last Used']);
  }
  return sheet;
}

function upsertCustomer(ss, name, phone) {
  const trimmedName = String(name || '').trim();
  const trimmedPhone = String(phone || '').trim();
  if (!trimmedName && !trimmedPhone) return;
  const sheet = getCustomersSheet(ss);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const rowName = String(rows[i][0] || '').trim();
    const rowPhone = String(rows[i][1] || '').trim();
    const samePhone = trimmedPhone && rowPhone === trimmedPhone;
    const sameName = !trimmedPhone && !rowPhone && rowName.toLowerCase() === trimmedName.toLowerCase();
    if (samePhone || sameName) {
      sheet.getRange(i + 1, 1, 1, 3).setValues([[trimmedName || rowName, trimmedPhone || rowPhone, new Date()]]);
      return;
    }
  }
  sheet.appendRow([trimmedName, trimmedPhone, new Date()]);
}

function listCustomers(ss) {
  const sheet = ss.getSheetByName('customers');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getDataRange().getValues();
  const customers = [];
  for (let i = 1; i < rows.length; i++) {
    const name = String(rows[i][0] || '').trim();
    const phone = String(rows[i][1] || '').trim();
    if (!name && !phone) continue;
    customers.push({ name, phone });
  }
  return customers;
}

// Jenga HQ credentials/base URL live only in Script Properties (Project Settings > Script
// Properties in the Apps Script editor) - never in code.gs source or any client-side file.
function getJengaConfig() {
  const props = PropertiesService.getScriptProperties();
  const config = {
    baseUrl: props.getProperty('JENGA_BASE_URL'),
    merchantCode: props.getProperty('JENGA_MERCHANT_CODE'),
    apiKey: props.getProperty('JENGA_API_KEY'),
    consumerSecret: props.getProperty('JENGA_CONSUMER_SECRET'),
    callbackSecret: props.getProperty('JENGA_CALLBACK_SECRET')
  };
  const required = ['baseUrl', 'merchantCode', 'apiKey', 'consumerSecret'];
  const missing = required.filter(key => !config[key]);
  if (missing.length) throw new Error('Missing Jenga configuration: ' + missing.join(', ') + '. Set it under Project Settings > Script Properties.');
  return config;
}

/**
 * Reads parameters directly from the 'Parameters' tab and returns:
 * - rules: Object mapping SizeCode -> { label, bwRate, colorRate }
 * - fixedCost: Sum of BINDING_COST, COVER_COST, POSTING_COST, etc. from Columns F & G
 */
function getParametersFromSheet(ss) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('quotation_parameters_v1');
  if (cached) return JSON.parse(cached);

  const paramsSheet = ss.getSheetByName('Parameters') || ss.getSheetByName('parameters');
  if (!paramsSheet) {
    throw new Error("Tab named 'Parameters' not found in spreadsheet.");
  }

  const data = paramsSheet.getDataRange().getValues();

  // 1. Parse Fixed Costs from Columns F & G (Cost Key & Amount)
  let totalFixedCost = 0;
  for (let i = 1; i < data.length; i++) {
    const costKey = String(data[i][5] || '').trim(); // Column F
    const amount = parseFloat(data[i][6]) || 0;     // Column G
    if (costKey) {
      totalFixedCost += amount;
    }
  }

  // 2. Parse Size Rates from Columns A to D
  const rules = {};
  for (let i = 1; i < data.length; i++) {
    const rawCode = String(data[i][0] || '').trim(); // Column A: SizeCode
    if (!rawCode) continue;

    const code = rawCode.charAt(0); // Takes first digit e.g. "1" from "1 (A5)"
    const label = String(data[i][1] || '').trim();  // Column B: Label
    const bwRate = parseFloat(data[i][2]) || 0;     // Column C: BWRate
    const colorRate = parseFloat(data[i][3]) || 0;  // Column D: ColorRate

    rules[code] = {
      label: label,
      bwRate: bwRate,
      colorRate: colorRate
    };
  }

  const params = { rules, fixedCost: totalFixedCost };
  cache.put('quotation_parameters_v1', JSON.stringify(params), 300);
  return params;
}

/**
 * Computes exact unit cost using data fetched directly from the sheet
 */
function computeUnitCost(pages, colorPages, rawSizeCode, params) {
  const sizeCodeStr = String(rawSizeCode || '1').trim();
  const code = sizeCodeStr.length > 0 ? sizeCodeStr.charAt(0) : '1';

  const rule = params.rules[code] || { bwRate: 0, colorRate: 0, label: 'Unknown' };

  const totalPages = parseInt(pages, 10) || 0;
  const numColor = parseInt(colorPages, 10) || 0;
  const bwPages = Math.max(0, totalPages - numColor);

  const totalCost = (bwPages * rule.bwRate) + (numColor * rule.colorRate) + params.fixedCost;

  return Math.round(totalCost);
}

function getSpecialPriceColumn(booksSheet) {
  const headerRow = booksSheet.getRange(1, 1, 1, Math.max(booksSheet.getLastColumn(), 8)).getValues()[0];
  const existingIndex = headerRow.findIndex(header => /special\s*price|price\s*override/i.test(String(header || '').trim()));
  const column = existingIndex >= 0 ? existingIndex + 1 : 8;
  if (existingIndex < 0 && !booksSheet.getRange(1, column).getValue()) {
    booksSheet.getRange(1, column).setValue('SpecialPrice');
  }
  return column;
}

function parseSpecialPrice(value) {
  if (value === '' || value === null || value === undefined) return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function createDocumentReference(prefix) {
  return prefix + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
}

function getDocumentSheet(ss, name) {
  const headers = ['Timestamp', 'Reference', 'Parent Reference', 'Client Name', 'Client Phone', 'Items JSON', 'Subtotal (Kshs)', 'Discount (Kshs)', 'Total (Kshs)', 'Tax / Breakdown', 'Status', 'Payment Method', 'Payment Reference'];
  if (name === 'orders_log') headers.push('Public Tracking Token', 'Expected Delivery Date');
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  } else if (name === 'orders_log') {
    if (!sheet.getRange(1, 14).getValue()) sheet.getRange(1, 14).setValue(headers[13]);
    if (!sheet.getRange(1, 15).getValue()) sheet.getRange(1, 15).setValue(headers[14]);
  }
  return sheet;
}

function addWorkingDays(startDate, workingDays) {
  const date = new Date(startDate);
  let added = 0;
  while (added < workingDays) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() !== 0 && date.getDay() !== 6) added++;
  }
  return date;
}

function formatOrderDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function parseOrderDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Enter a valid expected delivery date.');
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error('Enter a valid expected delivery date.');
  }
  return date;
}

function getProductionStatus(productionItems, orderStatus) {
  if (String(orderStatus || '').toUpperCase() === 'COMPLETED'
    || (productionItems.length && productionItems.every(item => item.completed))) {
    return 'Ready for collection';
  }
  const activeStatuses = [...new Set(productionItems
    .filter(item => !item.completed)
    .map(item => item.status)
    .filter(status => status && status !== 'In production'))];
  return activeStatuses.length ? activeStatuses.join(' · ') : 'In production';
}

function ensureOrderExpectedDeliveryDate(orderRecord) {
  if (!orderRecord || !orderRecord.sheet || !orderRecord.rowNumber) throw new Error('Order record is required.');
  const existingDate = formatOrderDate(orderRecord.values[14]);
  if (existingDate) return existingDate;
  const productionStartedAt = orderRecord.values[0] instanceof Date
    ? orderRecord.values[0]
    : new Date(orderRecord.values[0] || new Date());
  const expectedDate = addWorkingDays(
    isNaN(productionStartedAt.getTime()) ? new Date() : productionStartedAt,
    3
  );
  orderRecord.sheet.getRange(orderRecord.rowNumber, 15).setValue(expectedDate);
  orderRecord.values[14] = expectedDate;
  return formatOrderDate(expectedDate);
}

function getOrderExpectedDeliveryDate(orderRecord) {
  const savedDate = formatOrderDate(orderRecord.values[14]);
  if (savedDate) return savedDate;
  const productionStartedAt = orderRecord.values[0] instanceof Date
    ? orderRecord.values[0]
    : new Date(orderRecord.values[0] || new Date());
  return formatOrderDate(addWorkingDays(
    isNaN(productionStartedAt.getTime()) ? new Date() : productionStartedAt,
    3
  ));
}

function setOrderExpectedDeliveryDate(orderRecord, value) {
  if (!orderRecord || !orderRecord.sheet || !orderRecord.rowNumber) throw new Error('Order record is required.');
  const expectedDate = parseOrderDate(value);
  orderRecord.sheet.getRange(orderRecord.rowNumber, 15).setValue(expectedDate);
  orderRecord.values[14] = expectedDate;
  return formatOrderDate(expectedDate);
}

function getOrderTrackingUrl(token) {
  return `https://api.cavalrypublishers.co.ke/admin/order-status.html#${token}`;
}

function ensureOrderTrackingToken(orderRecord) {
  if (!orderRecord || !orderRecord.sheet || !orderRecord.rowNumber) throw new Error('Order record is required.');
  const existingToken = String(orderRecord.values[13] || '').trim();
  if (/^[a-f0-9]{64}$/.test(existingToken)) return existingToken;
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
  orderRecord.sheet.getRange(orderRecord.rowNumber, 14).setValue(token);
  orderRecord.values[13] = token;
  return token;
}

function getPublicOrderStatus(ss, trackingToken) {
  const token = String(trackingToken || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) return { status: 'error', message: 'This order link is invalid.' };
  const sheet = ss.getSheetByName('orders_log');
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 14) {
    return { status: 'error', message: 'This order could not be found.' };
  }
  const tokenCell = sheet.getRange(2, 14, sheet.getLastRow() - 1, 1)
    .createTextFinder(token).matchEntireCell(true).useRegularExpression(false).findNext();
  if (!tokenCell) return { status: 'error', message: 'This order could not be found.' };

  const orderRecord = findDocument(ss, 'orders_log', sheet.getRange(tokenCell.getRow(), 2).getValue());
  if (!orderRecord) return { status: 'error', message: 'This order could not be found.' };
  const order = documentResponse(orderRecord, 'order');
  if (String(order.status || '').toUpperCase() === 'ARCHIVED') {
    return { status: 'error', message: 'This order is no longer available. Contact Cavalry Publishers for an update.' };
  }
  const expectedDeliveryDate = getOrderExpectedDeliveryDate(orderRecord);
  let invoiceReference = String(order.parentReference || '').trim();
  let invoiceRecord = findDocument(ss, 'invoices_log', invoiceReference);
  if (!invoiceRecord) {
    const receipt = findDocument(ss, 'receipts_log', invoiceReference);
    invoiceReference = receipt ? String(receipt.values[2] || '').trim() : '';
    invoiceRecord = findDocument(ss, 'invoices_log', invoiceReference);
  }
  const invoice = invoiceRecord
    ? withInvoicePaymentTotals(ss, documentResponse(invoiceRecord, 'invoice'))
    : null;
  const productionItems = (order.items || []).filter(isProductionItem).map(item => {
    const stages = Array.isArray(item.productionStages) ? item.productionStages : [];
    const stageIndex = Number(item.productionStageIndex || 0);
    const stage = item.printed ? 'Completed' : stages[stageIndex] || 'In production';
    return {
      title: String(item.title || item.name || 'Order item'),
      quantity: Math.max(1, Number(item.quantity) || 1),
      mode: String(item.mode || ''),
      size: String(item.size || ''),
      status: stage,
      completed: item.printed === true
    };
  });
  const productionStatus = getProductionStatus(productionItems, order.status);
  const paymentTotal = invoice ? invoice.total : order.total;
  const amountPaid = invoice ? invoice.amountPaid : 0;
  const balance = invoice ? invoice.balance : paymentTotal;
  return {
    status: 'success',
    data: {
      orderReference: order.reference,
      createdAt: order.timestamp instanceof Date ? order.timestamp.toISOString() : String(order.timestamp || ''),
      orderStatus: String(order.status || 'IN_PRODUCTION'),
      productionStatus,
      expectedDeliveryDate,
      paymentStatus: invoice ? invoice.status : 'UNKNOWN',
      total: Number(paymentTotal || 0),
      amountPaid: Number(amountPaid || 0),
      balance: Number(balance || 0),
      items: productionItems
    }
  };
}

function documentRecord(postData, reference, parentReference, status, paymentMethod, paymentReference) {
  return [
    new Date(), reference, parentReference || '', postData.clientName || 'Valued Client', postData.clientPhone || '',
    JSON.stringify(postData.items || []), Number(postData.subtotal || 0), Number(postData.discount || 0),
    Number(postData.total || 0), postData.taxBreakdown || '', status, paymentMethod || '', paymentReference || ''
  ];
}

function addInvoiceRoundingAdjustment(items, rawTotal) {
  const total = Math.round(rawTotal);
  const adjustment = Number((total - rawTotal).toFixed(2));
  const adjustedItems = items.filter(item => item.isRoundingAdjustment !== true);
  if (adjustment !== 0) {
    adjustedItems.push({
      title: 'Rounding adjustment',
      quantity: 1,
      unitPrice: adjustment,
      total: adjustment,
      mode: '',
      size: '',
      isCharge: true,
      isRoundingAdjustment: true
    });
  }
  return { items: adjustedItems, total, adjustment };
}

function getPaymentSmsSheet(ss) {
  const headers = ['Message ID', 'Received At', 'SMS Message', 'Forwarder Time', 'Review Status', 'Reviewed At', 'Linked Invoice', 'Receipt Reference', 'Archived At', 'Archive Previous Status'];
  let sheet = ss.getSheetByName('payment_sms_inbox');
  if (!sheet) {
    sheet = ss.insertSheet('payment_sms_inbox');
    sheet.appendRow(headers);
  } else {
    headers.forEach((header, index) => {
      if (!sheet.getRange(1, index + 1).getValue()) sheet.getRange(1, index + 1).setValue(header);
    });
  }
  return sheet;
}

function receiveForwardedPaymentSms(ss, postData) {
  const expectedToken = PropertiesService.getScriptProperties().getProperty('SMS_FORWARDER_TOKEN');
  const suppliedToken = String(postData.token || postData.secret || '');
  if (!expectedToken || !suppliedToken || suppliedToken !== expectedToken) {
    return { status: 'error', message: 'SMS forwarding is not authorized.' };
  }

  const message = String(postData.message || postData.msg || postData.key || '').trim();
  const forwardedAt = String(postData.receivedAt || postData.time || '').trim();
  if (!message) return { status: 'error', message: 'SMS message is required.' };
  if (message.length > 3000) return { status: 'error', message: 'SMS message is too long.' };

  const messageId = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      message + '\n' + forwardedAt,
      Utilities.Charset.UTF_8
    )
  );
  const sheet = getPaymentSmsSheet(ss);
  const existingId = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(messageId).matchEntireCell(true).findNext()
    : null;
  if (existingId) {
    return { status: 'success', message: 'SMS already received.', duplicate: true };
  }

  sheet.appendRow([messageId, new Date(), message, forwardedAt, 'PENDING', '']);
  SpreadsheetApp.flush();
  return { status: 'success', message: 'SMS saved for staff review.', duplicate: false };
}

function parseMpesaPaymentSms(message) {
  const text = String(message || '');
  const transactionMatch = text.match(/(?:^|[^A-Z0-9])([A-Z0-9]{8,12})\s+Confirmed\b/i);
  const amountMatch = text.match(/KSHS?\s*([\d,]+(?:\.\d{1,2})?)\s*received\b/i);
  const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null;
  return {
    transactionCode: transactionMatch ? transactionMatch[1].toUpperCase() : '',
    amount: Number.isFinite(amount) && amount > 0 ? amount : null
  };
}

function listPaymentSms(ss) {
  const sheet = ss.getSheetByName('payment_sms_inbox');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const lastRow = sheet.getLastRow();
  const firstRow = Math.max(2, lastRow - 499);
  const rows = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, 10).getValues();
  return rows.map(row => {
    const message = String(row[2] || '');
    return {
      id: String(row[0] || ''),
      receivedAt: row[1] instanceof Date ? row[1].toISOString() : String(row[1] || ''),
      message,
      forwardedAt: String(row[3] || ''),
      status: String(row[4] || 'PENDING'),
      reviewedAt: row[5] instanceof Date ? row[5].toISOString() : String(row[5] || ''),
      linkedInvoice: String(row[6] || ''),
      receiptReference: String(row[7] || ''),
      archivedAt: row[8] instanceof Date ? row[8].toISOString() : String(row[8] || ''),
      parsedPayment: parseMpesaPaymentSms(message)
    };
  }).reverse();
}

function recordInvoicePayment(ss, postData) {
  const invoice = findDocument(ss, 'invoices_log', postData.invoiceReference);
  if (!invoice) throw new Error('Invoice not found: ' + postData.invoiceReference);
  const invoiceData = withInvoicePaymentTotals(ss, documentResponse(invoice, 'invoice'));
  const paymentRequestId = String(postData.paymentRequestId || '').trim();
  const duplicateReceipt = findReceiptByPaymentRequest(ss, invoiceData.reference, paymentRequestId);
  if (duplicateReceipt) {
    const existingOrder = getInvoiceOrderRecord(ss, invoiceData.reference);
    const expectedDeliveryDate = existingOrder ? ensureOrderExpectedDeliveryDate(existingOrder) : '';
    return {
      status: 'success',
      documentType: 'receipt',
      reference: duplicateReceipt.values[1],
      orderReference: existingOrder ? String(existingOrder.values[1] || '') : '',
      trackingUrl: existingOrder ? getOrderTrackingUrl(ensureOrderTrackingToken(existingOrder)) : '',
      expectedDeliveryDate,
      data: documentResponse(duplicateReceipt, 'receipt'),
      invoice: invoiceData,
      idempotent: true
    };
  }
  if (invoiceData.balance <= 0) throw new Error('This invoice has already been fully paid.');
  const requestedAmount = postData.paymentAmount === undefined || String(postData.paymentAmount).trim() === ''
    ? invoiceData.balance
    : Number(postData.paymentAmount);
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) throw new Error('Payment amount must be greater than zero.');
  if (requestedAmount - invoiceData.balance > 0.005) throw new Error('Payment amount cannot exceed the outstanding balance.');
  const paymentAmount = Math.min(requestedAmount, invoiceData.balance);
  const cumulativePaid = Number(invoiceData.amountPaid || 0) + paymentAmount;
  const balance = Math.max(0, Number(invoiceData.total || 0) - cumulativePaid);
  const nextInvoiceStatus = balance <= 0.005 ? 'PAID' : 'PARTIALLY_PAID';
  invoice.sheet.getRange(invoice.rowNumber, 11).setValue(nextInvoiceStatus);
  invoice.sheet.getRange(invoice.rowNumber, 12).setValue(postData.paymentMethod || '');
  invoice.sheet.getRange(invoice.rowNumber, 13).setValue(postData.paymentReference || '');

  const previousOrderStatus = getInvoiceOrderStatus(ss, invoiceData.reference);
  const receiptReference = createDocumentReference('RCT');
  const receiptSheet = getDocumentSheet(ss, 'receipts_log');
  const productionItems = (invoiceData.items || []).filter(isProductionItem);
  const receiptMetadata = JSON.stringify({
    paymentAmount,
    cumulativePaid,
    balance,
    paymentRequestId,
    orderCompleted: previousOrderStatus === 'COMPLETED',
    requiresProduction: productionItems.length > 0
  });
  const receiptItems = [{
    title: `Payment toward invoice ${invoiceData.reference}`,
    quantity: 1,
    unitPrice: paymentAmount,
    total: paymentAmount,
    mode: '',
    size: ''
  }];
  receiptSheet.appendRow(documentRecord({
    ...invoiceData,
    items: receiptItems,
    subtotal: paymentAmount,
    discount: 0,
    total: paymentAmount,
    taxBreakdown: receiptMetadata
  }, receiptReference, invoiceData.reference, 'PAID', postData.paymentMethod, postData.paymentReference));

  let orderReference = '';
  let trackingUrl = '';
  let expectedDeliveryDate = '';
  if (productionItems.length && !previousOrderStatus) {
    orderReference = createDocumentReference('ORD');
    const orderSheet = getDocumentSheet(ss, 'orders_log');
    orderSheet.appendRow(documentRecord({ ...invoiceData, items: invoiceData.items }, orderReference, receiptReference, 'IN_PRODUCTION', postData.paymentMethod, postData.paymentReference));
    const orderRecord = findDocument(ss, 'orders_log', orderReference);
    trackingUrl = getOrderTrackingUrl(ensureOrderTrackingToken(orderRecord));
    expectedDeliveryDate = ensureOrderExpectedDeliveryDate(orderRecord);
  } else if (productionItems.length) {
    const existingOrder = getInvoiceOrderRecord(ss, invoiceData.reference);
    if (existingOrder) {
      orderReference = String(existingOrder.values[1] || '');
      trackingUrl = getOrderTrackingUrl(ensureOrderTrackingToken(existingOrder));
      expectedDeliveryDate = ensureOrderExpectedDeliveryDate(existingOrder);
    }
  }
  SpreadsheetApp.flush();

  return {
    status: 'success',
    documentType: 'receipt',
    reference: receiptReference,
    orderReference,
    trackingUrl,
    expectedDeliveryDate: expectedDeliveryDate || '',
    data: documentResponse(findDocument(ss, 'receipts_log', receiptReference), 'receipt'),
    invoice: withInvoicePaymentTotal(invoiceData, cumulativePaid)
  };
}

// Locates a document row by searching for its reference directly (via TextFinder) instead of
// guessing which column holds it from the row's width - this works reliably for both the new
// 13-column layout and legacy quotes_log rows (whose reference lives in column H, not B).
function findDocument(ss, sheetName, reference) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const trimmedReference = String(reference || '').trim();
  if (!trimmedReference) return null;
  const match = sheet.createTextFinder(trimmedReference).matchEntireCell(true).useRegularExpression(false).findNext();
  if (!match) return null;
  const rowNumber = match.getRow();
  const width = Math.max(sheet.getLastColumn(), sheetName === 'orders_log' ? 15 : 13);
  const values = sheet.getRange(rowNumber, 1, 1, width).getValues()[0];
  const isLegacyQuote = sheetName === 'quotes_log' && match.getColumn() !== 2;
  return { sheet, rowNumber, values, isLegacyQuote };
}

// Prevents duplicate conversions (e.g. two invoices from the same quotation).
function findDocumentByParent(ss, sheetName, parentReference) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const rows = sheet.getDataRange().getValues();
  for (let index = 1; index < rows.length; index++) {
    const values = rows[index];
    if (String(values[2] || '').trim() === String(parentReference).trim()) {
      return { sheet, rowNumber: index + 1, values };
    }
  }
  return null;
}

function documentResponse(record, type) {
  if (!record) return null;
  const values = record.values;
  if (type === 'quotation' && record.isLegacyQuote) {
    // Legacy quotes_log rows (pre-lifecycle-redesign) only ever had one state: quoted.
    return {
      type, timestamp: values[0], reference: values[7] || '', parentReference: '',
      clientName: values[1] || 'Valued Client', clientPhone: values[2] || '',
      items: [], itemsSummary: values[3] || '', subtotal: Number(values[4] || 0),
      discount: Number(values[5] || 0), total: Number(values[6] || 0),
      taxBreakdown: '', status: 'ACTIVE', paymentMethod: '', paymentReference: ''
    };
  }
  let items = [];
  try { items = JSON.parse(values[5] || '[]'); } catch (error) { items = []; }
  let paymentMetadata = {};
  if (type === 'receipt') {
    try { paymentMetadata = JSON.parse(values[9] || '{}'); } catch (error) { paymentMetadata = {}; }
  }
  return {
    type, timestamp: values[0], reference: values[1], parentReference: values[2], clientName: values[3], clientPhone: values[4],
    items, subtotal: Number(values[6] || 0), discount: Number(values[7] || 0), total: Number(values[8] || 0),
    taxBreakdown: values[9] || '', status: values[10] || '', paymentMethod: values[11] || '', paymentReference: values[12] || '',
    paymentAmount: Number(paymentMetadata.paymentAmount || (type === 'receipt' ? values[8] : 0)),
    cumulativePaid: Number(paymentMetadata.cumulativePaid || (type === 'receipt' ? values[8] : 0)),
    balance: Number(paymentMetadata.balance || 0),
    orderCompleted: Boolean(paymentMetadata.orderCompleted),
    requiresProduction: Boolean(paymentMetadata.requiresProduction),
    expectedDeliveryDate: type === 'order' ? formatOrderDate(values[14]) : '',
    voidedAt: type === 'receipt' ? String(values[14] || '') : '',
    voidReason: type === 'receipt' ? String(values[15] || '') : ''
  };
}

function ensureAdminRecordHeaders(sheet, headers) {
  headers.forEach((header, index) => {
    if (header && !sheet.getRange(1, index + 1).getValue()) sheet.getRange(1, index + 1).setValue(header);
  });
}

function isOrderLinkedToRecords(ss, orderRecord) {
  if (String(orderRecord.values[2] || '').trim()) return true;
  return ['receipts_log', 'deliveries_log'].some(sheetName =>
    Boolean(findDocumentByParent(ss, sheetName, String(orderRecord.values[1] || '').trim()))
  );
}

function withInvoicePaymentTotals(ss, invoiceData) {
  if (!invoiceData || invoiceData.type !== 'invoice') return invoiceData;
  const sheet = ss.getSheetByName('receipts_log');
  let amountPaid = 0;
  if (sheet && sheet.getLastRow() > 1) {
    const rows = sheet.getDataRange().getValues();
    for (let index = 1; index < rows.length; index++) {
      if (String(rows[index][2] || '').trim() === String(invoiceData.reference).trim() &&
          String(rows[index][10] || '').toUpperCase() !== 'VOID') {
        amountPaid += Number(rows[index][8] || 0);
      }
    }
  }
  const rawBalance = Number(invoiceData.total || 0) - amountPaid;
  const balance = rawBalance <= 0.005 ? 0 : rawBalance;
  return { ...invoiceData, amountPaid, balance, status: balance === 0 ? 'PAID' : amountPaid > 0 ? 'PARTIALLY_PAID' : 'PENDING' };
}

function withInvoicePaymentTotal(invoiceData, amountPaid) {
  const rawBalance = Number(invoiceData.total || 0) - Number(amountPaid || 0);
  const balance = rawBalance <= 0.005 ? 0 : rawBalance;
  return {
    ...invoiceData,
    amountPaid: Number(amountPaid || 0),
    balance,
    status: balance === 0 ? 'PAID' : amountPaid > 0 ? 'PARTIALLY_PAID' : 'PENDING'
  };
}

function buildDocumentListContext(ss) {
  const receiptsSheet = ss.getSheetByName('receipts_log');
  const receiptRows = receiptsSheet && receiptsSheet.getLastRow() > 1
    ? receiptsSheet.getDataRange().getValues()
    : [];
  const receipts = receiptRows.slice(1);
  const paidByInvoice = new Map();
  const invoiceByReceipt = new Map();
  receipts.forEach(row => {
    const receiptReference = String(row[1] || '').trim();
    const invoiceReference = String(row[2] || '').trim();
    if (receiptReference && invoiceReference) invoiceByReceipt.set(receiptReference, invoiceReference);
    if (!invoiceReference || String(row[10] || '').toUpperCase() === 'VOID') return;
    paidByInvoice.set(invoiceReference, (paidByInvoice.get(invoiceReference) || 0) + Number(row[8] || 0));
  });

  const ordersSheet = ss.getSheetByName('orders_log');
  const orderRows = ordersSheet && ordersSheet.getLastRow() > 1
    ? ordersSheet.getDataRange().getValues()
    : [];
  const orderByInvoice = new Map();
  for (let index = 1; index < orderRows.length; index++) {
    const values = orderRows[index];
    if (!values[0] && !values[1]) continue;
    const parentReference = String(values[2] || '').trim();
    const invoiceReference = invoiceByReceipt.get(parentReference) || parentReference;
    if (invoiceReference) {
      orderByInvoice.set(invoiceReference, {
        sheet: ordersSheet,
        rowNumber: index + 1,
        values
      });
    }
  }
  return { paidByInvoice, orderByInvoice, receiptRows, orderRows };
}

function getInvoiceOrderRecord(ss, invoiceReference) {
  const ordersSheet = ss.getSheetByName('orders_log');
  if (!ordersSheet || ordersSheet.getLastRow() < 2) return null;
  const receiptReferences = new Set();
  const receiptsSheet = ss.getSheetByName('receipts_log');
  if (receiptsSheet && receiptsSheet.getLastRow() > 1) {
    receiptsSheet.getDataRange().getValues().slice(1).forEach(row => {
      if (String(row[2] || '').trim() === String(invoiceReference).trim()) receiptReferences.add(String(row[1] || '').trim());
    });
  }
  const rows = ordersSheet.getDataRange().getValues();
  for (let index = 1; index < rows.length; index++) {
    const parentReference = String(rows[index][2] || '').trim();
    if (parentReference === String(invoiceReference).trim() || receiptReferences.has(parentReference)) {
      return { sheet: ordersSheet, rowNumber: index + 1, values: rows[index] };
    }
  }
  return null;
}

function getInvoiceOrderStatus(ss, invoiceReference) {
  const order = getInvoiceOrderRecord(ss, invoiceReference);
  return order ? String(order.values[10] || '') : '';
}

function hasDeliveryForOrder(ss, orderReference) {
  return Boolean(findDocumentByParent(ss, 'deliveries_log', orderReference));
}

function getReminderHistory(ss) {
  const sheet = ss.getSheetByName('reminders_log');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getDisplayValues().map(row => ({
    timestamp: row[0], invoiceReference: row[1], event: row[2], dueDate: row[3],
    promisedDate: row[4], snoozeUntil: row[5], message: row[6], requestId: row[7], staff: row[8]
  }));
}

function appendReminderEvent(ss, event) {
  let sheet = ss.getSheetByName('reminders_log');
  if (!sheet) {
    sheet = ss.insertSheet('reminders_log');
    sheet.appendRow(['Timestamp', 'Invoice Reference', 'Event', 'Due Date', 'Promised Date', 'Snooze Until', 'Message', 'Request ID', 'Staff']);
  }
  sheet.appendRow([new Date().toISOString(), event.invoiceReference, event.event, event.dueDate || '',
    event.promisedDate || '', event.snoozeUntil || '', event.message || '', event.requestId || '', event.staff || 'Staff']);
}

function reminderInvoice(ss, reference) {
  const invoice = findDocument(ss, 'invoices_log', reference);
  if (!invoice) throw new Error('Invoice not found.');
  const data = withInvoicePaymentTotals(ss, documentResponse(invoice, 'invoice'));
  if (data.balance <= 0) throw new Error('This invoice is fully paid. No payment reminder is needed.');
  return data;
}

function validateReminderDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parsed = new Date(text + 'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error('Enter a valid reminder date.');
  }
  return text;
}

function findReceiptByPaymentRequest(ss, invoiceReference, paymentRequestId) {
  if (!paymentRequestId) return null;
  const sheet = ss.getSheetByName('receipts_log');
  if (!sheet || sheet.getLastRow() < 2) return null;
  const rows = sheet.getDataRange().getValues();
  for (let index = 1; index < rows.length; index++) {
    if (String(rows[index][2] || '').trim() !== String(invoiceReference).trim()) continue;
    try {
      if (JSON.parse(rows[index][9] || '{}').paymentRequestId === paymentRequestId) {
        return { sheet, rowNumber: index + 1, values: rows[index] };
      }
    } catch (error) {}
  }
  return null;
}

// Reads every row of a document sheet into a flat list for the admin tracking tab.
function listDocumentsFromSheet(ss, sheetName, type, context) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = context && sheetName === 'orders_log' ? context.orderRows
    : context && sheetName === 'receipts_log' ? context.receiptRows
      : sheet.getDataRange().getValues();
  const records = [];
  for (let index = 1; index < rows.length; index++) {
    const values = rows[index];
    if (!values[0] && !values[1]) continue;
    // New-format rows always carry a QUO-prefixed reference in column B; anything else is a legacy row.
    const isLegacyQuote = sheetName === 'quotes_log' && !/^QUO-/i.test(String(values[1] || '').trim());
    const record = { sheet, rowNumber: index + 1, values, isLegacyQuote };
    const response = documentResponse(record, type);
    if (type === 'order') {
      const token = String(values[13] || '').trim();
      response.trackingUrl = /^[a-f0-9]{64}$/.test(token) ? getOrderTrackingUrl(token) : '';
      response.expectedDeliveryDate = getOrderExpectedDeliveryDate(record);
    } else if (type === 'invoice') {
      const invoice = context
        ? withInvoicePaymentTotal(response, context.paidByInvoice.get(String(response.reference || '').trim()) || 0)
        : withInvoicePaymentTotals(ss, response);
      const order = context
        ? context.orderByInvoice.get(String(invoice.reference || '').trim())
        : getInvoiceOrderRecord(ss, invoice.reference);
      if (order) {
        const token = String(order.values[13] || '').trim();
        invoice.trackingUrl = /^[a-f0-9]{64}$/.test(token) ? getOrderTrackingUrl(token) : '';
        invoice.expectedDeliveryDate = getOrderExpectedDeliveryDate(order);
      }
      records.push(invoice);
      continue;
    }
    records.push(response);
  }
  return records;
}

function isProductionItem(item) {
  if (!item || item.isCharge) return false;
  if (item.requiresProduction !== undefined) return item.requiresProduction === true;
  return Boolean(item.mode || item.pages || item.size);
}

function createDeliveryForOrder(ss, orderRecord, orderData) {
  if (findDocumentByParent(ss, 'deliveries_log', orderData.reference)) return null;
  orderRecord.sheet.getRange(orderRecord.rowNumber, 11).setValue('COMPLETED');
  const deliveryReference = createDocumentReference('DN');
  const deliverySheet = getDocumentSheet(ss, 'deliveries_log');
  deliverySheet.appendRow(documentRecord(orderData, deliveryReference, orderData.reference, 'ISSUED', orderData.paymentMethod, orderData.paymentReference));
  return deliveryReference;
}

function getExpensesSheet(ss) {
  let sheet = ss.getSheetByName('expenses_log');
  if (!sheet) {
    sheet = ss.insertSheet('expenses_log');
    sheet.appendRow(['Recorded At', 'Expense Date', 'Category', 'Description', 'Amount (Kshs)', 'Recorded By']);
  }
  return sheet;
}

function listExpenses(ss) {
  const sheet = ss.getSheetByName('expenses_log');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues().map(row => ({
    recordedAt: row[0], date: row[1], category: String(row[2] || ''),
    description: String(row[3] || ''), amount: Number(row[4] || 0), recordedBy: String(row[5] || '')
  }));
}

function getCatalogueCacheKey() {
  return 'quotation_catalogue_v1';
}

function clearCatalogueCache() {
  CacheService.getScriptCache().remove(getCatalogueCacheKey());
}

function doGet(e) {
  try {
    const cache = CacheService.getScriptCache();
    const cachedCatalogue = cache.get(getCatalogueCacheKey());
    if (cachedCatalogue) {
      return ContentService
        .createTextOutput(cachedCatalogue)
        .setMimeType(ContentService.MimeType.JSON);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const booksSheet = ss.getSheetByName('books');
    
    if (!booksSheet) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: "Tab named 'books' not found." }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Read dynamic params from Parameters sheet
    const params = getParametersFromSheet(ss);

    // Read books catalogue
    const booksData = booksSheet.getDataRange().getValues();
    const specialPriceColumn = getSpecialPriceColumn(booksSheet);
    const books = [];

    for (let i = 1; i < booksData.length; i++) {
      const row = booksData[i];
      if (!row[0]) continue; // Skip blank titles

      const title = String(row[0]).trim();
      const author = String(row[1] || '').trim();
      const pages = parseInt(row[2], 10) || 0;
      const colorPages = parseInt(row[3], 10) || 0;
      const sizeCode = String(row[4] || '1').trim();
      const rawCoverUrl = String(row[6] || '').trim();

      let coverUrl = '';
      if (rawCoverUrl) {
        const driveIdMatch = rawCoverUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || rawCoverUrl.match(/id=([a-zA-Z0-9_-]+)/);
        if (driveIdMatch && driveIdMatch[1]) {
          // lh3.googleusercontent.com natively allows cross-origin requests
          coverUrl = 'https://lh3.googleusercontent.com/d/' + driveIdMatch[1] + '=s1000';
        } else {
          coverUrl = rawCoverUrl;
        }
      }

      const calculatedUnitCost = computeUnitCost(pages, colorPages, sizeCode, params);
      const specialPrice = parseSpecialPrice(row[specialPriceColumn - 1]);
      const unitCost = specialPrice === null ? calculatedUnitCost : specialPrice;
      const codeKey = sizeCode.charAt(0);
      const sizeLabel = (params.rules[codeKey] && params.rules[codeKey].label) 
        ? params.rules[codeKey].label 
        : `Size ${sizeCode}`;

      books.push({
        id: i,
        title: title,
        author: author,
        pages: pages,
        colorPages: colorPages,
        sizeCode: sizeCode,
        sizeLabel: sizeLabel,
        coverUrl: coverUrl,
        unitCost: unitCost,
        calculatedUnitCost: calculatedUnitCost,
        hasSpecialPrice: specialPrice !== null
      });
    }

    const response = JSON.stringify({ status: 'success', data: books });
    if (response.length < 95000) {
      cache.put(getCatalogueCacheKey(), response, 60);
    }
    return ContentService
      .createTextOutput(response)
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const contentType = String(e.postData && e.postData.type || '').toLowerCase();
    const postData = contentType.indexOf('application/x-www-form-urlencoded') >= 0
      ? (e.parameter || {})
      : JSON.parse(e.postData.contents);
    const readOnlyActions = new Set([
      'calculate_cost', 'get_document_data', 'list_customers', 'list_documents',
      'get_public_order_status', 'list_expenses', 'list_payment_sms',
      'login', 'restore_session', 'logout_session'
    ]);
    if (!readOnlyActions.has(String(postData.action || ''))) {
      lock.waitLock(15000);
      lockAcquired = true;
    }

    if (postData.action === 'receive_payment_sms') {
      return ContentService
        .createTextOutput(JSON.stringify(receiveForwardedPaymentSms(ss, postData)))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'login') {
      const isValid = verifyStaffCredentials(ss, postData.username, postData.password);
      const sessionToken = isValid ? 'SESSION-' + Utilities.getUuid() + Utilities.getUuid() : '';
      if (sessionToken) CacheService.getScriptCache().put(sessionToken, String(postData.username).trim(), 21600);
      return ContentService
        .createTextOutput(JSON.stringify({ status: isValid ? 'success' : 'error', sessionToken, expiresAt: Date.now() + 21600000, message: isValid ? 'Login successful.' : 'Incorrect username or password.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'restore_session' || postData.action === 'logout_session') {
      const token = String(postData.staffPassword || '');
      const username = token.startsWith('SESSION-') ? CacheService.getScriptCache().get(token) : null;
      if (postData.action === 'logout_session' && username) CacheService.getScriptCache().remove(token);
      return ContentService.createTextOutput(JSON.stringify({ status: username ? 'success' : 'error', username: username || '' })).setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'get_public_order_status') {
      return ContentService
        .createTextOutput(JSON.stringify(getPublicOrderStatus(ss, postData.trackingToken)))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // -------------------------------------------------------------
    // ROUTE 1: Dynamic cost calculation endpoint
    // -------------------------------------------------------------
    if (postData.action === 'calculate_cost') {
      const params = getParametersFromSheet(ss);
      const unitCost = computeUnitCost(postData.pages, postData.colorPages, postData.sizeCode, params);
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', unitCost: unitCost }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Admin-only: returns the saved client directory so staff can autofill repeat customers.
    if (postData.action === 'list_customers') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', data: listCustomers(ss) }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'list_payment_sms') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', data: listPaymentSms(ss) }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'update_payment_sms_status') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const messageId = String(postData.id || '').trim();
      const status = String(postData.reviewStatus || '').trim().toUpperCase();
      if (!messageId) throw new Error('SMS message ID is required.');
      if (!['VERIFIED', 'REVIEWED', 'IGNORED'].includes(status)) throw new Error('Choose a valid SMS review status.');
      const sheet = ss.getSheetByName('payment_sms_inbox');
      const idCell = sheet && sheet.getLastRow() > 1
        ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(messageId).matchEntireCell(true).findNext()
        : null;
      if (!idCell) throw new Error('SMS message not found.');
      const currentStatus = String(sheet.getRange(idCell.getRow(), 5).getValue() || '').toUpperCase();
      if (currentStatus === 'LINKED') throw new Error('A linked payment SMS cannot be changed.');
      if (currentStatus !== 'PENDING') throw new Error('Only pending SMS messages can be verified or ignored.');
      sheet.getRange(idCell.getRow(), 5, 1, 2).setValues([[status, new Date()]]);
      SpreadsheetApp.flush();
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', message: 'SMS review status updated.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // -------------------------------------------------------------
    // ROUTE 2: Log Quote into 'quotes_log' (Quotation stage)
    // -------------------------------------------------------------
    if (postData.action === 'log_quote') {
      const quoteReference = postData.quotationNumber || createDocumentReference('QUO');
      const quoteSheet = getDocumentSheet(ss, 'quotes_log');
      quoteSheet.appendRow(documentRecord(postData, quoteReference, '', 'ACTIVE', '', ''));
      SpreadsheetApp.flush();
      upsertCustomer(ss, postData.clientName, postData.clientPhone);
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', documentType: 'quotation', reference: quoteReference, message: 'Quote logged successfully.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'update_document') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const type = String(postData.documentType || '');
      const isQuotation = type === 'quotation';
      const sheetName = isQuotation ? 'quotes_log' : type === 'invoice' ? 'invoices_log' : '';
      if (!sheetName) throw new Error('Only quotations and invoices can be edited.');
      const record = findDocument(ss, sheetName, postData.reference);
      if (!record) throw new Error(`${type} not found: ${postData.reference}`);
      const existing = documentResponse(record, type);
      let existingInvoice = null;
      let productionOrder = null;
      if (isQuotation) {
        if (existing.status !== 'ACTIVE' || findDocumentByParent(ss, 'invoices_log', existing.reference)) {
          throw new Error('Only unconverted quotations can be edited.');
        }
      } else {
        existingInvoice = withInvoicePaymentTotals(ss, existing);
        if (!['PENDING', 'PARTIALLY_PAID'].includes(existingInvoice.status) || existingInvoice.balance <= 0) {
          throw new Error('Only invoices with an outstanding balance can be edited.');
        }
        productionOrder = getInvoiceOrderRecord(ss, existing.reference);
        if (productionOrder && (String(productionOrder.values[10]) === 'COMPLETED' || hasDeliveryForOrder(ss, productionOrder.values[1]))) {
          throw new Error('An invoice for a completed or delivered order cannot be edited.');
        }
      }

      if (!Array.isArray(postData.items) || !postData.items.length) throw new Error('Add at least one line item.');
      const items = postData.items.filter(item => item && item.isRoundingAdjustment !== true).map(item => {
        const title = String(item.title || '').trim();
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unitPrice);
        if (!title || !Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(unitPrice) || unitPrice < 0) {
          throw new Error('Each item needs a description, a positive whole-number quantity, and a valid unit price.');
        }
        return { ...item, title, quantity, unitPrice, total: quantity * unitPrice };
      });
      const subtotal = items.reduce((sum, item) => sum + item.total, 0);
      const discount = Math.max(0, Number(postData.discount || 0));
      if (!Number.isFinite(discount) || discount > subtotal) throw new Error('Discount cannot exceed the item subtotal.');
      let total = subtotal - discount;
      let savedSubtotal = subtotal;
      let savedItems = items;
      if (type === 'invoice') {
        const rounded = addInvoiceRoundingAdjustment(items, total);
        total = rounded.total;
        savedSubtotal += rounded.adjustment;
        savedItems = rounded.items;
      }
      if (existingInvoice && total <= existingInvoice.amountPaid) {
        throw new Error('The revised invoice total must remain greater than the amount already paid.');
      }
      const clientName = String(postData.clientName || '').trim();
      const clientPhone = String(postData.clientPhone || '').trim();
      if (!clientName) throw new Error('Client name is required.');

      if (isQuotation && record.isLegacyQuote) {
        record.sheet.getRange(record.rowNumber, 1, 1, 13).setValues([documentRecord({
          clientName, clientPhone, items: savedItems, subtotal: savedSubtotal, discount, total, taxBreakdown: existing.taxBreakdown
        }, existing.reference, '', 'ACTIVE', '', '')]);
      } else {
        record.sheet.getRange(record.rowNumber, 4, 1, 6).setValues([
          [clientName, clientPhone, JSON.stringify(savedItems), savedSubtotal, discount, total]
        ]);
        record.sheet.getRange(record.rowNumber, 11).setValue(existingInvoice.amountPaid > 0 ? 'PARTIALLY_PAID' : 'PENDING');
        if (productionOrder) {
          const updatedProductionItems = savedItems.map(item => ({ ...item, printed: false, productionStageIndex: 0 }));
          productionOrder.sheet.getRange(productionOrder.rowNumber, 4, 1, 6).setValues([
            [clientName, clientPhone, JSON.stringify(updatedProductionItems), savedSubtotal, discount, total]
          ]);
        }
      }
      upsertCustomer(ss, clientName, clientPhone);
      SpreadsheetApp.flush();
      let updatedDocument = documentResponse(findDocument(ss, sheetName, existing.reference), type);
      if (type === 'invoice') updatedDocument = withInvoicePaymentTotals(ss, updatedDocument);
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', data: updatedDocument }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'delete_quotation') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const quote = findDocument(ss, 'quotes_log', postData.reference);
      if (!quote) throw new Error('Quotation not found: ' + postData.reference);
      const quoteData = documentResponse(quote, 'quotation');
      if (quoteData.status !== 'ACTIVE' || findDocumentByParent(ss, 'invoices_log', quoteData.reference)) {
        throw new Error('Only unconverted quotations can be deleted.');
      }
      quote.sheet.deleteRow(quote.rowNumber);
      SpreadsheetApp.flush();
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', reference: quoteData.reference }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'manage_admin_record') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      const recordType = String(postData.recordType || '').trim().toLowerCase();
      const operation = String(postData.operation || '').trim().toLowerCase();
      if (!['archive', 'restore', 'delete'].includes(operation)) throw new Error('Choose a valid record action.');

      if (recordType === 'book') {
        if (operation !== 'delete') throw new Error('Catalogue books can only be permanently removed.');
        const booksSheet = ss.getSheetByName('books');
        const bookId = Number(postData.bookId);
        const expectedTitle = String(postData.title || '').trim();
        if (!booksSheet || !Number.isInteger(bookId) || bookId < 1 || bookId >= booksSheet.getLastRow()) {
          throw new Error('Catalogue book not found. Refresh the catalogue and try again.');
        }
        const bookRow = bookId + 1;
        const actualTitle = String(booksSheet.getRange(bookRow, 1).getValue() || '').trim();
        if (!actualTitle || actualTitle !== expectedTitle) {
          throw new Error('The catalogue changed. Refresh the catalogue and try again.');
        }
        booksSheet.deleteRow(bookRow);
        clearCatalogueCache();
        SpreadsheetApp.flush();
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'success', recordType, title: actualTitle }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      if (recordType === 'payment_sms') {
        const messageId = String(postData.reference || '').trim();
        const sheet = getPaymentSmsSheet(ss);
        const idCell = messageId && sheet.getLastRow() > 1
          ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
            .createTextFinder(messageId).matchEntireCell(true).useRegularExpression(false).findNext()
          : null;
        if (!idCell) throw new Error('Payment SMS record not found.');
        const row = idCell.getRow();
        const values = sheet.getRange(row, 1, 1, 10).getValues()[0];
        if (operation === 'delete') {
          if (values[6] || values[7]) throw new Error('A linked payment SMS is retained with its receipt and cannot be permanently deleted.');
          sheet.deleteRow(row);
        } else if (operation === 'archive') {
          if (String(values[4] || '').toUpperCase() === 'ARCHIVED') throw new Error('This payment SMS is already archived.');
          sheet.getRange(row, 9, 1, 2).setValues([[new Date(), String(values[4] || 'PENDING')]]);
          sheet.getRange(row, 5).setValue('ARCHIVED');
        } else {
          if (String(values[4] || '').toUpperCase() !== 'ARCHIVED') throw new Error('This payment SMS is not archived.');
          sheet.getRange(row, 5).setValue(String(values[9] || 'PENDING'));
          sheet.getRange(row, 9, 1, 2).clearContent();
        }
        SpreadsheetApp.flush();
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'success', recordType, operation, reference: messageId }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      const documentSheets = {
        order: 'orders_log',
        receipt: 'receipts_log'
      };
      const sheetName = documentSheets[recordType];
      if (!sheetName) throw new Error('This record type cannot be changed here.');
      const record = findDocument(ss, sheetName, postData.reference);
      if (!record) throw new Error(`${recordType === 'order' ? 'Order' : 'Receipt'} not found.`);

      if (recordType === 'order') {
        ensureAdminRecordHeaders(record.sheet, ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Archive Previous Status', 'Archived At']);
        if (operation === 'delete') {
          if (isOrderLinkedToRecords(ss, record)) {
            throw new Error('This order is linked to an invoice, receipt, or delivery record. Archive it instead to preserve history.');
          }
          record.sheet.deleteRow(record.rowNumber);
        } else if (operation === 'archive') {
          if (String(record.values[10] || '').toUpperCase() === 'ARCHIVED') throw new Error('This order is already archived.');
          record.sheet.getRange(record.rowNumber, 16, 1, 2)
            .setValues([[String(record.values[10] || 'IN_PRODUCTION'), new Date()]]);
          record.sheet.getRange(record.rowNumber, 11).setValue('ARCHIVED');
        } else {
          if (String(record.values[10] || '').toUpperCase() !== 'ARCHIVED') throw new Error('This order is not archived.');
          record.sheet.getRange(record.rowNumber, 11).setValue(String(record.values[15] || 'IN_PRODUCTION'));
          record.sheet.getRange(record.rowNumber, 16, 1, 2).clearContent();
        }
      } else {
        ensureAdminRecordHeaders(record.sheet, ['', '', '', '', '', '', '', '', '', '', '', '', '', 'Void Previous Status', 'Voided At', 'Void Reason']);
        if (operation === 'delete') {
          throw new Error('Receipts are linked to invoice balances and retained for financial audit. Void the receipt to correct it.');
        }
        if (operation === 'archive') {
          if (String(record.values[10] || '').toUpperCase() === 'VOID') throw new Error('This receipt is already void.');
          const reason = String(postData.reason || '').trim();
          if (!reason) throw new Error('Enter a reason for voiding this receipt.');
          record.sheet.getRange(record.rowNumber, 14, 1, 3)
            .setValues([[String(record.values[10] || ''), new Date(), reason]]);
          record.sheet.getRange(record.rowNumber, 11).setValue('VOID');
        } else {
          if (String(record.values[10] || '').toUpperCase() !== 'VOID') throw new Error('This receipt is not void.');
          record.sheet.getRange(record.rowNumber, 11).setValue(String(record.values[13] || ''));
          record.sheet.getRange(record.rowNumber, 14, 1, 3).clearContent();
        }
      }
      SpreadsheetApp.flush();
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', recordType, operation, reference: String(record.values[1] || '') }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Quotation -> Invoice. Adds optional extra charges (e.g. delivery) and blocks duplicate conversion.
    if (postData.action === 'convert_quote_to_invoice') {
      const quote = findDocument(ss, 'quotes_log', postData.quotationReference);
      if (!quote) throw new Error('Quotation not found: ' + postData.quotationReference);
      const quoteData = documentResponse(quote, 'quotation');
      if (quoteData.status && quoteData.status !== 'ACTIVE') {
        throw new Error('This quotation has already been converted to an invoice.');
      }
      if (findDocumentByParent(ss, 'invoices_log', quoteData.reference)) {
        throw new Error('An invoice already exists for this quotation.');
      }
      upsertCustomer(ss, postData.clientName, postData.clientPhone);

      const extraCharges = Array.isArray(postData.extraCharges) ? postData.extraCharges : [];
      const extraItems = extraCharges
        .filter(charge => charge && Number(charge.amount) > 0)
        .map(charge => ({ title: charge.label || 'Additional charge', quantity: 1, unitPrice: Number(charge.amount), total: Number(charge.amount), mode: '', size: '', isCharge: true }));
      const items = [...(quoteData.items || []), ...extraItems];
      const extraTotal = extraItems.reduce((sum, item) => sum + item.total, 0);
      const rawSubtotal = Number(quoteData.subtotal || 0) + extraTotal;
      const rawTotal = Number(quoteData.total || 0) + extraTotal;
      const rounded = addInvoiceRoundingAdjustment(items, rawTotal);
      const subtotal = rawSubtotal + rounded.adjustment;
      const total = rounded.total;

      const invoiceReference = createDocumentReference('INV');
      const invoiceSheet = getDocumentSheet(ss, 'invoices_log');
      invoiceSheet.appendRow(documentRecord({
        clientName: postData.clientName || quoteData.clientName,
        clientPhone: postData.clientPhone || quoteData.clientPhone,
        items: rounded.items, subtotal, discount: quoteData.discount || 0, total
      }, invoiceReference, quoteData.reference, 'PENDING', '', ''));

      // Mark the quotation as converted so it cannot be turned into a second invoice.
      quote.sheet.getRange(quote.rowNumber, quote.isLegacyQuote ? quote.values.length + 1 : 11).setValue('CONVERTED');

      let orderReference = '';
      let trackingUrl = '';
      let expectedDeliveryDate = '';
      if (postData.startProduction === true && items.some(isProductionItem)) {
        orderReference = createDocumentReference('ORD');
        const invoiceData = documentResponse(findDocument(ss, 'invoices_log', invoiceReference), 'invoice');
        const orderSheet = getDocumentSheet(ss, 'orders_log');
        orderSheet.appendRow(documentRecord(invoiceData, orderReference, invoiceReference, 'IN_PRODUCTION', '', ''));
        const orderRecord = findDocument(ss, 'orders_log', orderReference);
        trackingUrl = getOrderTrackingUrl(ensureOrderTrackingToken(orderRecord));
        expectedDeliveryDate = ensureOrderExpectedDeliveryDate(orderRecord);
      }

      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', documentType: 'invoice', reference: invoiceReference, orderReference, trackingUrl, expectedDeliveryDate, data: withInvoicePaymentTotals(ss, documentResponse(findDocument(ss, 'invoices_log', invoiceReference), 'invoice')) }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'link_payment_sms_to_invoice') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const smsId = String(postData.smsId || '').trim();
      const invoiceReference = String(postData.invoiceReference || '').trim();
      const transactionCode = String(postData.transactionCode || '').trim();
      if (!smsId) throw new Error('Forwarded SMS ID is required.');
      const smsSheet = ss.getSheetByName('payment_sms_inbox');
      const idCell = smsSheet && smsSheet.getLastRow() > 1
        ? smsSheet.getRange(2, 1, smsSheet.getLastRow() - 1, 1).createTextFinder(smsId).matchEntireCell(true).findNext()
        : null;
      if (!idCell) throw new Error('Forwarded SMS was not found.');
      const smsRow = idCell.getRow();
      const smsValues = smsSheet.getRange(smsRow, 1, 1, 8).getValues()[0];
      if (!['VERIFIED', 'REVIEWED'].includes(String(smsValues[4] || '').toUpperCase())) {
        throw new Error('Verify the SMS before linking it to an invoice.');
      }
      if (smsValues[6] || smsValues[7]) throw new Error('This SMS is already linked to a payment.');
      const parsedPayment = parseMpesaPaymentSms(smsValues[2]);
      const submittedCode = transactionCode.toUpperCase();
      const submittedAmount = Number(postData.paymentAmount);
      if (!/^[A-Z0-9]{8,12}$/.test(submittedCode) || !String(smsValues[2] || '').toUpperCase().includes(submittedCode)) {
        throw new Error('Enter the transaction code exactly as it appears in the SMS.');
      }
      if (parsedPayment.transactionCode && submittedCode !== parsedPayment.transactionCode) {
        throw new Error('The transaction code does not match the SMS.');
      }
      if (!Number.isFinite(submittedAmount) || submittedAmount <= 0) {
        throw new Error('Enter a valid payment amount.');
      }
      if (parsedPayment.amount && Math.abs(submittedAmount - parsedPayment.amount) > 0.005) {
        throw new Error('The amount does not match the amount detected in the SMS.');
      }
      if (!invoiceReference) throw new Error('Choose an invoice.');

      const payment = recordInvoicePayment(ss, {
        invoiceReference,
        paymentAmount: submittedAmount,
        paymentRequestId: 'SMS-' + smsId,
        paymentMethod: 'mpesa',
        paymentReference: submittedCode
      });
      smsSheet.getRange(smsRow, 5, 1, 4).setValues([[
        'LINKED', new Date(), invoiceReference, payment.reference
      ]]);
      SpreadsheetApp.flush();
      payment.smsId = smsId;
      payment.invoiceReference = invoiceReference;
      return ContentService
        .createTextOutput(JSON.stringify(payment))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'record_verified_mpesa_payment') {
      const expectedSecret = PropertiesService.getScriptProperties().getProperty('MPESA_PAYMENT_API_SECRET');
      if (!expectedSecret || !secureStringEquals(expectedSecret, postData.serverSecret)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Payment service authorization failed.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const paymentAmount = Number(postData.paymentAmount);
      const paymentRequestId = String(postData.paymentRequestId || '').trim();
      const paymentReference = String(postData.paymentReference || '').trim().toUpperCase();
      if (!Number.isInteger(paymentAmount) || paymentAmount <= 0 ||
          !paymentRequestId || !/^[A-Z0-9]{8,12}$/.test(paymentReference)) {
        throw new Error('Verified M-Pesa payment details are invalid.');
      }
      const payment = recordInvoicePayment(ss, {
        invoiceReference: postData.invoiceReference,
        paymentAmount,
        paymentRequestId,
        paymentMethod: 'mpesa',
        paymentReference
      });
      return ContentService
        .createTextOutput(JSON.stringify(payment))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Staff-entered receipts are restricted to authenticated staff; customer payments use the
    // separately verified M-Pesa callback route above.
    if (postData.action === 'confirm_invoice_payment') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const payment = recordInvoicePayment(ss, postData);
      return ContentService
        .createTextOutput(JSON.stringify(payment))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'start_invoice_production') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const invoice = findDocument(ss, 'invoices_log', postData.invoiceReference);
      if (!invoice) throw new Error('Invoice not found: ' + postData.invoiceReference);
      const invoiceData = withInvoicePaymentTotals(ss, documentResponse(invoice, 'invoice'));
      if (invoiceData.balance <= 0) throw new Error('This invoice is already fully paid; its production should have started when payment was recorded.');
      if (!(invoiceData.items || []).some(isProductionItem)) throw new Error('This invoice has no items requiring production.');
      const existingOrder = getInvoiceOrderRecord(ss, invoiceData.reference);
      if (existingOrder) {
        if (String(existingOrder.values[10] || '') === 'COMPLETED') throw new Error('This order is already completed.');
        return ContentService
          .createTextOutput(JSON.stringify({
            status: 'success',
            alreadyStarted: true,
            orderReference: existingOrder.values[1],
            trackingUrl: getOrderTrackingUrl(ensureOrderTrackingToken(existingOrder)),
            expectedDeliveryDate: ensureOrderExpectedDeliveryDate(existingOrder)
          }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const orderReference = createDocumentReference('ORD');
      getDocumentSheet(ss, 'orders_log').appendRow(documentRecord(invoiceData, orderReference, invoiceData.reference, 'IN_PRODUCTION', '', ''));
      const orderRecord = findDocument(ss, 'orders_log', orderReference);
      const trackingUrl = getOrderTrackingUrl(ensureOrderTrackingToken(orderRecord));
      const expectedDeliveryDate = ensureOrderExpectedDeliveryDate(orderRecord);
      SpreadsheetApp.flush();
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', orderReference, trackingUrl, expectedDeliveryDate, data: documentResponse(findDocument(ss, 'orders_log', orderReference), 'order') }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'update_order_delivery_date') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const order = findDocument(ss, 'orders_log', postData.orderReference);
      if (!order) throw new Error('Order not found.');
      const expectedDeliveryDate = setOrderExpectedDeliveryDate(order, postData.expectedDeliveryDate);
      SpreadsheetApp.flush();
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', orderReference: order.values[1], expectedDeliveryDate }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Mark an individual production line printed and finish its order when every book line is done.
    if (['mark_order_item_printed', 'set_production_stages', 'advance_production_stage'].includes(postData.action)) {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const order = findDocument(ss, 'orders_log', postData.orderReference);
      if (!order) throw new Error('Order not found: ' + postData.orderReference);
      const orderData = documentResponse(order, 'order');
      if (orderData.status === 'COMPLETED') throw new Error('This order is already completed.');
      const items = Array.isArray(orderData.items) ? orderData.items : [];
      const itemIndex = Number(postData.itemIndex);
      if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= items.length || !isProductionItem(items[itemIndex])) {
        throw new Error('Invalid production item.');
      }
      const item = items[itemIndex];
      const stages = Array.isArray(item.productionStages) ? item.productionStages : [];
      const stageIndex = Number(item.productionStageIndex || 0);
      if (postData.action === 'set_production_stages') {
        if (item.printed || stageIndex > 0) throw new Error('Stages cannot be changed after production progress has been recorded.');
        if (!Array.isArray(postData.stages) || postData.stages.length > 12) throw new Error('Specify at most 12 stages.');
        const newStages = postData.stages.map(stage => String(stage).trim());
        if (newStages.some(stage => !stage || stage.length > 60)) throw new Error('Stage names must contain 1 to 60 characters.');
        item.productionStages = newStages;
        item.productionStageIndex = 0;
      } else if (postData.action === 'advance_production_stage') {
        if (!stages.length) throw new Error('This production item has no configured stages.');
        if (item.printed || Number(postData.expectedStageIndex) !== stageIndex) throw new Error('Production progress changed. Refresh the queue before continuing.');
        item.productionStageIndex = stageIndex + 1;
        item.printed = item.productionStageIndex >= stages.length;
      } else {
        if (stages.length) throw new Error('Complete the configured stages in order.');
        item.printed = true;
      }
      order.sheet.getRange(order.rowNumber, 6).setValue(JSON.stringify(items));
      const productionItems = items.filter(isProductionItem);
      let deliveryReference = '';
      if (productionItems.length && productionItems.every(item => item.printed === true)) {
        orderData.items = items;
        deliveryReference = createDeliveryForOrder(ss, order, orderData) || '';
      }
      SpreadsheetApp.flush();
      return ContentService
        .createTextOutput(JSON.stringify({
          status: 'success',
          completed: orderData.status !== 'COMPLETED' && Boolean(deliveryReference),
          deliveryReference,
          data: documentResponse(findDocument(ss, 'orders_log', orderData.reference), 'order')
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Order -> Delivery note. Manual completion is allowed only after every book line is printed.
    if (postData.action === 'complete_order') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const order = findDocument(ss, 'orders_log', postData.orderReference);
      if (!order) throw new Error('Order not found: ' + postData.orderReference);
      const orderData = documentResponse(order, 'order');
      if (orderData.status === 'COMPLETED') {
        throw new Error('This order has already been completed.');
      }
      if (findDocumentByParent(ss, 'deliveries_log', orderData.reference)) {
        throw new Error('A delivery note has already been issued for this order.');
      }
      const productionItems = (orderData.items || []).filter(isProductionItem);
      if (!productionItems.length || !productionItems.every(item => item.printed === true)) {
        throw new Error('Mark every production item as printed before completing this order.');
      }
      const deliveryReference = createDeliveryForOrder(ss, order, orderData);
      SpreadsheetApp.flush();

      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', documentType: 'delivery', reference: deliveryReference, data: documentResponse(findDocument(ss, 'deliveries_log', deliveryReference), 'delivery') }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (['list_reminders', 'schedule_reminder', 'prepare_reminder', 'confirm_reminder_sent'].includes(postData.action)) {
      if (!isValidStaffPassword(ss, postData.staffPassword)) throw new Error('Staff authorization required.');
      const authValue = String(postData.staffPassword || '');
      const staff = authValue.startsWith('SESSION-') ? CacheService.getScriptCache().get(authValue) : 'Staff';
      const history = getReminderHistory(ss);
      if (postData.action === 'list_reminders') {
        const schedules = new Map();
        history.filter(entry => entry.event === 'SCHEDULE').forEach(entry => schedules.set(entry.invoiceReference, entry));
        const invoices = listDocumentsFromSheet(ss, 'invoices_log', 'invoice').filter(invoice => invoice.balance > 0).map(invoice => {
          const order = getInvoiceOrderRecord(ss, invoice.reference);
          const completed = Boolean(order && (String(order.values[10]) === 'COMPLETED' || hasDeliveryForOrder(ss, order.values[1])));
          const sent = history.filter(entry => entry.invoiceReference === invoice.reference && entry.event === 'SENT');
          return { ...invoice, orderCompleted: completed, reminderSchedule: schedules.get(invoice.reference) || {},
            lastReminderAt: sent.length ? sent[sent.length - 1].timestamp : '', reminderCount: sent.length };
        });
        invoices.sort((first, second) => Number(second.orderCompleted) - Number(first.orderCompleted) || new Date(first.timestamp) - new Date(second.timestamp));
        return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: invoices, history })).setMimeType(ContentService.MimeType.JSON);
      }
      if (postData.action === 'confirm_reminder_sent') {
        const requestId = String(postData.requestId || '');
        const existing = history.find(entry => entry.event === 'SENT' && entry.requestId === requestId);
        if (existing) return ContentService.createTextOutput(JSON.stringify({ status: 'success', alreadyRecorded: true })).setMimeType(ContentService.MimeType.JSON);
        const cached = CacheService.getScriptCache().get('reminder-' + requestId);
        if (!cached) throw new Error('This reminder preview expired. Prepare a fresh reminder.');
        const draft = JSON.parse(cached);
        if (draft.authValue !== authValue) throw new Error('This reminder belongs to another staff session.');
        appendReminderEvent(ss, { ...draft, event: 'SENT', staff });
        SpreadsheetApp.flush();
        return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
      }
      const invoice = reminderInvoice(ss, postData.invoiceReference);
      if (postData.action === 'schedule_reminder') {
        appendReminderEvent(ss, { invoiceReference: invoice.reference, event: 'SCHEDULE',
          dueDate: validateReminderDate(postData.dueDate), promisedDate: validateReminderDate(postData.promisedDate),
          snoozeUntil: validateReminderDate(postData.snoozeUntil), staff });
        SpreadsheetApp.flush();
        return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
      }
      const schedule = history.filter(entry => entry.event === 'SCHEDULE' && entry.invoiceReference === invoice.reference).pop() || {};
      const money = amount => 'Kshs. ' + Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const message = `Hello ${invoice.clientName}, a friendly reminder that invoice ${invoice.reference} has an outstanding balance of ${money(invoice.balance)}.\nInvoice total: ${money(invoice.total)}\nPayments received: ${money(invoice.amountPaid)}${schedule.dueDate ? '\nPayment due: ' + schedule.dueDate : ''}${schedule.promisedDate ? '\nAgreed payment date: ' + schedule.promisedDate : ''}\nKindly pay the balance to Till No. 7637201, quoting your invoice reference. If you have already paid, please share the transaction reference for reconciliation. Thank you for your business.`;
      const requestId = Utilities.getUuid();
      CacheService.getScriptCache().put('reminder-' + requestId, JSON.stringify({ invoiceReference: invoice.reference, message, requestId, authValue }), 1800);
      return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: invoice, message, requestId })).setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'list_expenses') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', data: listExpenses(ss) }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'add_expense') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const expenseDate = String(postData.date || '').trim();
      const category = String(postData.category || '').trim();
      const description = String(postData.description || '').trim();
      const amount = Number(postData.amount);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate) || !category || !Number.isFinite(amount) || amount <= 0) {
        throw new Error('Enter a valid expense date, category, and amount greater than zero.');
      }
      getExpensesSheet(ss).appendRow([new Date(), expenseDate, category, description, amount, String(postData.staffUsername || 'Staff').trim()]);
      SpreadsheetApp.flush();
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', data: listExpenses(ss) }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'get_document_data') {
      const reference = String(postData.reference || '').trim();
      const sources = [['quotes_log', 'quotation'], ['invoices_log', 'invoice'], ['receipts_log', 'receipt'], ['orders_log', 'order'], ['deliveries_log', 'delivery']];
      for (const source of sources) {
        const record = findDocument(ss, source[0], reference);
        if (record) {
          let data = documentResponse(record, source[1]);
          if (source[1] === 'invoice') data = withInvoicePaymentTotals(ss, data);
          return ContentService
            .createTextOutput(JSON.stringify({ status: 'success', data }))
            .setMimeType(ContentService.MimeType.JSON);
        }
      }
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: 'Document not found.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Admin-only: returns every quote/order/invoice/receipt for the tracking & accounting tab.
    if (postData.action === 'list_documents') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const context = buildDocumentListContext(ss);
      const documents = [
        ...listDocumentsFromSheet(ss, 'quotes_log', 'quotation', context),
        ...listDocumentsFromSheet(ss, 'orders_log', 'order', context),
        ...listDocumentsFromSheet(ss, 'invoices_log', 'invoice', context),
        ...listDocumentsFromSheet(ss, 'receipts_log', 'receipt', context),
        ...listDocumentsFromSheet(ss, 'deliveries_log', 'delivery', context)
      ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', data: documents }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ROUTE 3: Save or clear a permanent special catalogue price in the books sheet
    if (postData.action === 'set_special_price') {
      if (!isValidStaffPassword(ss, postData.staffPassword)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Staff authorization required.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      const booksSheet = ss.getSheetByName('books');
      if (!booksSheet) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: "Tab 'books' not found." }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      const bookId = parseInt(postData.bookId, 10);
      if (!Number.isInteger(bookId) || bookId < 1 || bookId >= booksSheet.getLastRow()) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'Invalid book ID.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      const specialPriceColumn = getSpecialPriceColumn(booksSheet);
      const specialPrice = parseSpecialPrice(postData.specialPrice);
      booksSheet.getRange(bookId + 1, specialPriceColumn).setValue(specialPrice === null ? '' : specialPrice);
      clearCatalogueCache();

      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', specialPrice: specialPrice }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // -------------------------------------------------------------
    // ROUTE 3: Add Custom Book to 'books' tab
    // -------------------------------------------------------------
    const booksSheet = ss.getSheetByName('books');
    if (!booksSheet) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: "Tab 'books' not found." }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const booksData = booksSheet.getDataRange().getValues();
    const title = String(postData.title || '').trim();
    const author = String(postData.author || '').trim();
    const pages = Number(postData.pages);
    const colorPages = parseInt(postData.colorPages, 10) || 0;
    const sizeCode = String(postData.sizeCode || '1').trim();
    if (!title || !Number.isInteger(pages) || pages < 1 || colorPages < 0 || colorPages > pages) {
      throw new Error('Enter a title, a valid page count, and colour pages no greater than total pages.');
    }

    // Check existing titles
    for (let i = 1; i < booksData.length; i++) {
      if (String(booksData[i][0]).trim().toLowerCase() === title.toLowerCase()) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'exists', message: 'Book already in catalogue' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    const params = getParametersFromSheet(ss);
    const unitCost = computeUnitCost(pages, colorPages, sizeCode, params);
    booksSheet.appendRow([title, author, pages, colorPages, sizeCode, unitCost, '']);
    clearCatalogueCache();

    const codeKey = sizeCode.charAt(0);
    const sizeLabel = (params.rules[codeKey] && params.rules[codeKey].label) 
      ? params.rules[codeKey].label 
      : `Size ${sizeCode}`;

    return ContentService
      .createTextOutput(JSON.stringify({
        status: 'success',
        book: {
          id: booksData.length,
          title: title,
          author: author,
          pages: pages,
          colorPages: colorPages,
          sizeCode: sizeCode,
          sizeLabel: sizeLabel,
          coverUrl: '',
          unitCost: unitCost
        }
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    if (lockAcquired) lock.releaseLock();
  }
}