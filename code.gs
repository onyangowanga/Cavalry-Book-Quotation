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
  return {
    type, timestamp: values[0], reference: values[1], parentReference: values[2], clientName: values[3], clientPhone: values[4],
    items, subtotal: Number(values[6] || 0), discount: Number(values[7] || 0), total: Number(values[8] || 0),
    taxBreakdown: values[9] || '', status: values[10] || '', paymentMethod: values[11] || '', paymentReference: values[12] || ''
  };
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
    records.push(documentResponse({ sheet, rowNumber: index + 1, values, isLegacyQuote }, type));
  }
  return records;
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
        .map(charge => ({ title: charge.label || 'Additional charge', quantity: 1, unitPrice: Number(charge.amount), total: Number(charge.amount), mode: '', size: '' }));
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

      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', documentType: 'invoice', reference: invoiceReference, data: documentResponse(findDocument(ss, 'invoices_log', invoiceReference), 'invoice') }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Invoice -> Receipt (payment confirmation), which immediately opens a production Order.
    if (postData.action === 'confirm_invoice_payment') {
      const invoice = findDocument(ss, 'invoices_log', postData.invoiceReference);
      if (!invoice) throw new Error('Invoice not found: ' + postData.invoiceReference);
      const invoiceData = documentResponse(invoice, 'invoice');
      if (invoiceData.status === 'PAID') {
        throw new Error('This invoice has already been paid.');
      }
      if (findDocumentByParent(ss, 'receipts_log', invoiceData.reference)) {
        throw new Error('A receipt has already been recorded for this invoice.');
      }

      invoice.sheet.getRange(invoice.rowNumber, 11).setValue('PAID');
      invoice.sheet.getRange(invoice.rowNumber, 12).setValue(postData.paymentMethod || '');
      invoice.sheet.getRange(invoice.rowNumber, 13).setValue(postData.paymentReference || '');

      const receiptReference = createDocumentReference('RCT');
      const receiptSheet = getDocumentSheet(ss, 'receipts_log');
      receiptSheet.appendRow(documentRecord({ ...invoiceData, items: invoiceData.items }, receiptReference, invoiceData.reference, 'PAID', postData.paymentMethod, postData.paymentReference));

      // Receipt -> Order: production tracking starts automatically once payment is confirmed.
      const orderReference = createDocumentReference('ORD');
      const orderSheet = getDocumentSheet(ss, 'orders_log');
      orderSheet.appendRow(documentRecord({ ...invoiceData, items: invoiceData.items }, orderReference, receiptReference, 'IN_PRODUCTION', postData.paymentMethod, postData.paymentReference));

      return ContentService
        .createTextOutput(JSON.stringify({
          status: 'success', documentType: 'receipt', reference: receiptReference, orderReference: orderReference,
          data: documentResponse(findDocument(ss, 'receipts_log', receiptReference), 'receipt')
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Order -> Delivery note. Marks production complete and blocks duplicate delivery notes.
    if (postData.action === 'complete_order') {
      const order = findDocument(ss, 'orders_log', postData.orderReference);
      if (!order) throw new Error('Order not found: ' + postData.orderReference);
      const orderData = documentResponse(order, 'order');
      if (orderData.status === 'COMPLETED') {
        throw new Error('This order has already been completed.');
      }
      if (findDocumentByParent(ss, 'deliveries_log', orderData.reference)) {
        throw new Error('A delivery note has already been issued for this order.');
      }

      order.sheet.getRange(order.rowNumber, 11).setValue('COMPLETED');

      const deliveryReference = createDocumentReference('DN');
      const deliverySheet = getDocumentSheet(ss, 'deliveries_log');
      deliverySheet.appendRow(documentRecord({ ...orderData, items: orderData.items }, deliveryReference, orderData.reference, 'ISSUED', orderData.paymentMethod, orderData.paymentReference));

      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', documentType: 'delivery', reference: deliveryReference, data: documentResponse(findDocument(ss, 'deliveries_log', deliveryReference), 'delivery') }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (postData.action === 'get_document_data') {
      const reference = String(postData.reference || '').trim();
      const sources = [['quotes_log', 'quotation'], ['invoices_log', 'invoice'], ['receipts_log', 'receipt'], ['orders_log', 'order'], ['deliveries_log', 'delivery']];
      for (const source of sources) {
        const record = findDocument(ss, source[0], reference);
        if (record) {
          return ContentService
            .createTextOutput(JSON.stringify({ status: 'success', data: documentResponse(record, source[1]) }))
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
    lock.releaseLock();
  }
}