function getStaffPassword(ss) {
  const securitySheet = ss.getSheetByName('security');
  if (!securitySheet) {
    throw new Error("Tab named 'security' not found.");
  }
  return String(securitySheet.getRange('A1').getDisplayValue() || '').trim();
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
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const postData = JSON.parse(e.postData.contents);

    if (postData.action === 'login') {
      const configuredPassword = getStaffPassword(ss);
      const suppliedPassword = String(postData.password || '').trim();
      return ContentService
        .createTextOutput(JSON.stringify({ status: suppliedPassword && suppliedPassword === configuredPassword ? 'success' : 'error', message: suppliedPassword && suppliedPassword === configuredPassword ? 'Login successful.' : 'Incorrect password.' }))
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

    // -------------------------------------------------------------
    // ROUTE 2: Log Quote into 'quotes_log'
    // -------------------------------------------------------------
    if (postData.action === 'log_quote') {
      let logSheet = ss.getSheetByName('quotes_log');
      if (!logSheet) {
        logSheet = ss.insertSheet('quotes_log');
        logSheet.appendRow(['Timestamp', 'Client Name', 'Phone', 'Items Ordered', 'Subtotal (Kshs)', 'Discount (Kshs)', 'Total (Kshs)']);
      }

      logSheet.appendRow([
        new Date(),
        postData.clientName || 'Anonymous Client',
        postData.clientPhone || 'N/A',
        postData.itemsSummary,
        postData.subtotal,
        postData.discount,
        postData.total
      ]);

      return ContentService
        .createTextOutput(JSON.stringify({ status: 'success', message: 'Quote logged successfully' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ROUTE 3: Save or clear a permanent special catalogue price in the books sheet
    if (postData.action === 'set_special_price') {
      if (String(postData.staffPassword || '').trim() !== getStaffPassword(ss)) {
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
  }
}