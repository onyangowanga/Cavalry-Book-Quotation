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
  return getStaffCredentials(ss).some(entry => entry.password === supplied);
}

function verifyStaffCredentials(ss, username, password) {
  const suppliedUsername = String(username || '').trim().toLowerCase();
  const suppliedPassword = String(password || '').trim();
  if (!suppliedUsername || !suppliedPassword) return false;
  return getStaffCredentials(ss).some(entry => entry.username.toLowerCase() === suppliedUsername && entry.password === suppliedPassword);
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
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function documentRecord(postData, reference, parentReference, status, paymentMethod, paymentReference) {
  return [
    new Date(), reference, parentReference || '', postData.clientName || 'Valued Client', postData.clientPhone || '',
    JSON.stringify(postData.items || []), Number(postData.subtotal || 0), Number(postData.discount || 0),
    Number(postData.total || 0), postData.taxBreakdown || '', status, paymentMethod || '', paymentReference || ''
  ];
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
  const width = Math.max(sheet.getLastColumn(), 13);
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
    requiresProduction: Boolean(paymentMetadata.requiresProduction)
  };
}

function withInvoicePaymentTotals(ss, invoiceData) {
  if (!invoiceData || invoiceData.type !== 'invoice') return invoiceData;
  const sheet = ss.getSheetByName('receipts_log');
  let amountPaid = 0;
  if (sheet && sheet.getLastRow() > 1) {
    const rows = sheet.getDataRange().getValues();
    for (let index = 1; index < rows.length; index++) {
      if (String(rows[index][2] || '').trim() === String(invoiceData.reference).trim()) {
        amountPaid += Number(rows[index][8] || 0);
      }
    }
  }
  const rawBalance = Number(invoiceData.total || 0) - amountPaid;
  const balance = rawBalance <= 0.005 ? 0 : rawBalance;
  return { ...invoiceData, amountPaid, balance, status: balance === 0 ? 'PAID' : amountPaid > 0 ? 'PARTIALLY_PAID' : 'PENDING' };
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
function listDocumentsFromSheet(ss, sheetName, type) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getDataRange().getValues();
  const records = [];
  for (let index = 1; index < rows.length; index++) {
    const values = rows[index];
    if (!values[0] && !values[1]) continue;
    // New-format rows always carry a QUO-prefixed reference in column B; anything else is a legacy row.
    const isLegacyQuote = sheetName === 'quotes_log' && !/^QUO-/i.test(String(values[1] || '').trim());
    const record = { sheet, rowNumber: index + 1, values, isLegacyQuote };
    const response = documentResponse(record, type);
    records.push(type === 'invoice' ? withInvoicePaymentTotals(ss, response) : response);
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
  // Serializes concurrent requests so one execution's sheet writes are always fully committed
  // before another execution reads them (prevents "quotation not found" races on rapid double actions).
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const postData = JSON.parse(e.postData.contents);

    if (postData.action === 'login') {
      const isValid = verifyStaffCredentials(ss, postData.username, postData.password);
      return ContentService
        .createTextOutput(JSON.stringify({ status: isValid ? 'success' : 'error', message: isValid ? 'Login successful.' : 'Incorrect username or password.' }))
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
      const items = postData.items.map(item => {
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
      const total = subtotal - discount;
      if (existingInvoice && total <= existingInvoice.amountPaid) {
        throw new Error('The revised invoice total must remain greater than the amount already paid.');
      }
      const clientName = String(postData.clientName || '').trim();
      const clientPhone = String(postData.clientPhone || '').trim();
      if (!clientName) throw new Error('Client name is required.');

      if (isQuotation && record.isLegacyQuote) {
        record.sheet.getRange(record.rowNumber, 1, 1, 13).setValues([documentRecord({
          clientName, clientPhone, items, subtotal, discount, total, taxBreakdown: existing.taxBreakdown
        }, existing.reference, '', 'ACTIVE', '', '')]);
      } else {
        record.sheet.getRange(record.rowNumber, 4, 1, 6).setValues([
          [clientName, clientPhone, JSON.stringify(items), subtotal, discount, total]
        ]);
        record.sheet.getRange(record.rowNumber, 11).setValue(existingInvoice.amountPaid > 0 ? 'PARTIALLY_PAID' : 'PENDING');
        if (productionOrder) {
          const updatedProductionItems = items.map(item => ({ ...item, printed: false }));
          productionOrder.sheet.getRange(productionOrder.rowNumber, 4, 1, 6).setValues([
            [clientName, clientPhone, JSON.stringify(updatedProductionItems), subtotal, discount, total]
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
      const subtotal = Number(quoteData.subtotal || 0) + extraTotal;
      const total = Number(quoteData.total || 0) + extraTotal;

      const invoiceReference = createDocumentReference('INV');
      const invoiceSheet = getDocumentSheet(ss, 'invoices_log');
      invoiceSheet.appendRow(documentRecord({
        clientName: postData.clientName || quoteData.clientName,
        clientPhone: postData.clientPhone || quoteData.clientPhone,
        items, subtotal, discount: quoteData.discount || 0, total
      }, invoiceReference, quoteData.reference, 'PENDING', '', ''));

      // Mark the quotation as converted so it cannot be turned into a second invoice.
      quote.sheet.getRange(quote.rowNumber, quote.isLegacyQuote ? quote.values.length + 1 : 11).setValue('CONVERTED');

      let orderReference = '';
      if (postData.startProduction === true && items.some(isProductionItem)) {
        orderReference = createDocumentReference('ORD');
        const invoiceData = documentResponse(findDocument(ss, 'invoices_log', invoiceReference), 'invoice');
        getDocumentSheet(ss, 'orders_log').appendRow(documentRecord(invoiceData, orderReference, invoiceReference, 'IN_PRODUCTION', '', ''));
      }

      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', documentType: 'invoice', reference: invoiceReference, orderReference, data: withInvoicePaymentTotals(ss, documentResponse(findDocument(ss, 'invoices_log', invoiceReference), 'invoice')) }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Every confirmed payment creates its own receipt and updates the invoice balance.
    if (postData.action === 'confirm_invoice_payment') {
      const invoice = findDocument(ss, 'invoices_log', postData.invoiceReference);
      if (!invoice) throw new Error('Invoice not found: ' + postData.invoiceReference);
      const invoiceData = withInvoicePaymentTotals(ss, documentResponse(invoice, 'invoice'));
      const paymentRequestId = String(postData.paymentRequestId || '').trim();
      const duplicateReceipt = findReceiptByPaymentRequest(ss, invoiceData.reference, paymentRequestId);
      if (duplicateReceipt) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'success', documentType: 'receipt', reference: duplicateReceipt.values[1], orderReference: '', data: documentResponse(duplicateReceipt, 'receipt'), idempotent: true }))
          .setMimeType(ContentService.MimeType.JSON);
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
      if (productionItems.length && !previousOrderStatus) {
        orderReference = createDocumentReference('ORD');
        const orderSheet = getDocumentSheet(ss, 'orders_log');
        orderSheet.appendRow(documentRecord({ ...invoiceData, items: invoiceData.items }, orderReference, receiptReference, 'IN_PRODUCTION', postData.paymentMethod, postData.paymentReference));
      }
      SpreadsheetApp.flush();

      return ContentService
        .createTextOutput(JSON.stringify({
          status: 'success', documentType: 'receipt', reference: receiptReference, orderReference: orderReference,
          data: documentResponse(findDocument(ss, 'receipts_log', receiptReference), 'receipt'),
          invoice: withInvoicePaymentTotals(ss, documentResponse(findDocument(ss, 'invoices_log', invoiceData.reference), 'invoice'))
        }))
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
          .createTextOutput(JSON.stringify({ status: 'success', alreadyStarted: true, orderReference: existingOrder.values[1] }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const orderReference = createDocumentReference('ORD');
      getDocumentSheet(ss, 'orders_log').appendRow(documentRecord(invoiceData, orderReference, invoiceData.reference, 'IN_PRODUCTION', '', ''));
      SpreadsheetApp.flush();
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', orderReference, data: documentResponse(findDocument(ss, 'orders_log', orderReference), 'order') }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Mark an individual production line printed and finish its order when every book line is done.
    if (postData.action === 'mark_order_item_printed') {
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
      items[itemIndex].printed = true;
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
      const documents = [
        ...listDocumentsFromSheet(ss, 'quotes_log', 'quotation'),
        ...listDocumentsFromSheet(ss, 'invoices_log', 'invoice'),
        ...listDocumentsFromSheet(ss, 'receipts_log', 'receipt'),
        ...listDocumentsFromSheet(ss, 'orders_log', 'order'),
        ...listDocumentsFromSheet(ss, 'deliveries_log', 'delivery')
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
    const pages = parseInt(postData.pages, 10) || 0;
    const colorPages = parseInt(postData.colorPages, 10) || 0;
    const sizeCode = String(postData.sizeCode || '1').trim();

    // Check existing titles
    for (let i = 1; i < booksData.length; i++) {
      if (String(booksData[i][0]).trim().toLowerCase() === title.toLowerCase()) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'exists', message: 'Book already in catalogue' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    const pdfBase64 = String(postData.pdfBase64 || '');
    if (!pdfBase64) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: 'A PDF copy is required when saving a custom book to the catalogue.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (pdfBase64.length > 28 * 1024 * 1024) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: 'The PDF is too large to email. Maximum size is 20 MB.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const params = getParametersFromSheet(ss);
    const unitCost = computeUnitCost(pages, colorPages, sizeCode, params);
    booksSheet.appendRow([title, author, pages, colorPages, sizeCode, unitCost, '']);
    clearCatalogueCache();

    let emailSent = false;
    let emailError = '';
    try {
      const fileName = String(postData.pdfFileName || `${title}.pdf`).replace(/[\\/:*?"<>|]/g, '_');
      const attachment = Utilities.newBlob(Utilities.base64Decode(pdfBase64), 'application/pdf', fileName);
      MailApp.sendEmail({
        to: 'cavalrypublishers@gmail.com',
        subject: `New catalogue book: ${title}`,
        body: `A new book was added to the Cavalry Publishers catalogue.\n\nTitle: ${title}\nAuthor: ${author || 'Not provided'}\nPages: ${pages}\nSize code: ${sizeCode}\nCalculated price: Kshs. ${unitCost}\n\nThe uploaded PDF is attached.`,
        attachments: [attachment]
      });
      emailSent = true;
    } catch (error) {
      emailError = error.message || String(error);
      console.error('Catalogue PDF email failed:', emailError);
    }

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
        },
        emailSent: emailSent,
        emailError: emailError
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}