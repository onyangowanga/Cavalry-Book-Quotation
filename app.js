const API_URL = "https://script.google.com/macros/s/AKfycbx9xaPSdNyEa51Lws0iEBobfHrh4ZqAw4R5QO5YJi680D1B-S1HlRdrTxMi5QdXTccXEA/exec";
const COMPANY_WHATSAPP = "254726953346"; // Replace with your primary business WhatsApp phone number

// drive.google.com/thumbnail links are blocked by CORS; googleusercontent.com serves the same image without that restriction.
function formatDriveUrl(url) {
  if (!url) return url;
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return `https://lh3.googleusercontent.com/d/${match[1]}=s1000`;
  }
  return url;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

// Labels are for display only; the backend remains authoritative for original prices.
const SIZE_LABELS = {
  "1": "A5 Size",
  "2": "A4 Size",
  "3": "A6 Size"
};

let rawCatalog = [];
let catalog = [];
let cart = [];
let catalogProgressTimer;
let catalogueView = 'grid';
const quotationNumber = `CAV-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
const MINIMUM_ORDER_AMOUNT = 500;

let isStaff = false;
let staffPassword = '';
let offsetHistory = [];
let activeAppTab = 'catalogue';
let checkoutReference = '';
let currentDocument = null;
let allDocuments = [];
let documentsFilter = 'all';

const OFFSET_PAPER_COSTS = {
  'Bond 70': 1100,
  'Bond 80': 1300,
  'Art 135': 2400,
  'Art 150': 2800,
  'Art 175': 2800
};
const OFFSET_PAPER_DIVISORS = { A3: 1, A4: 2, A5: 4, A6: 8 };
const OFFSET_MACHINE_COSTS = { 'GTO 46': 250, SM: 300 };
const OFFSET_SIDES = { 'Single sided': 1, 'Double sided': 2 };
const OFFSET_PLATE_COST = 250;
const MASS_PRODUCTION_THRESHOLD = 500;
const MASS_ART_CARD_COST = 5000;
const MASS_BOND_80_COST = 1300;
const MASS_GENERAL_OVERALL_PER_1000 = 1000;
const MASS_COVER_GENERAL_PER_COPY = { A5: 30, A4: 45, A6: 25 };
const CLIENT_PROFIT_MARKUP = 0.20;
const ADMIN_PROFIT_MARKUP = 0.20;

window.addEventListener('load', () => { loadCatalog(); updateStaffUI(); calculateClientMassQuote('booklet'); });

function loadCatalog() {
    showCatalogProgress(8, 'Connecting to the catalogue...');
    catalogProgressTimer = setInterval(() => {
      const progressBar = document.querySelector('.catalog-progress');
      if (!progressBar) return;
      const current = Number(progressBar.dataset.progress || 8);
      showCatalogProgress(Math.min(90, current + (current < 45 ? 7 : 3)), current < 35 ? 'Fetching catalogue data...' : 'Preparing book listings...');
    }, 350);
    // Cache-bust so a manual refresh always pulls the latest sheet data instead of a cached response.
    fetch(`${API_URL}?t=${Date.now()}`, { redirect: 'follow', cache: 'no-store' })
        .then(res => {
        if (!res.ok) throw new Error('Network response was not ok');
        return res.json();
    })
    .then(response => {
        if (response.status === 'success') { 
          showCatalogProgress(100, 'Catalogue ready');
            rawCatalog = sortCatalogue(response.data);
            catalog = rawCatalog;
            displayBooks(catalog); 
        } else {
            showCatalogError('The catalogue could not be loaded: ' + (response.message || 'Unknown error'));
        }
    })
    .catch(err => {
        console.error('Catalogue Load Error:', err);
        showCatalogError('Check your connection and try again.');
    })
    .finally(() => setRefreshButtonLoading(false));
}

function refreshCatalog() {
  setRefreshButtonLoading(true);
  loadCatalog();
}

function setRefreshButtonLoading(isLoading) {
  const button = document.getElementById('refreshCatalogButton');
  if (!button) return;
  button.disabled = isLoading;
  button.classList.toggle('is-loading', isLoading);
}

function openStaffLoginModal() {
  const modal = document.getElementById('staffLoginModal');
  modal.style.display = 'flex';
  const input = document.getElementById('staffPasswordInput');
  const checkbox = document.getElementById('showStaffPassword');
  input.value = '';
  input.type = 'password';
  checkbox.checked = false;
  input.focus();
}

function closeStaffLoginModal() { document.getElementById('staffLoginModal').style.display = 'none'; }

function toggleStaffPasswordVisibility() {
  const input = document.getElementById('staffPasswordInput');
  const checkbox = document.getElementById('showStaffPassword');
  input.type = checkbox.checked ? 'text' : 'password';
}

async function submitStaffLogin() {
  const input = document.getElementById('staffPasswordInput');
  const button = document.getElementById('staffLoginSubmitButton');
  const label = button.querySelector('.login-button-label');
  const password = input.value;
  if (!password) {
    alert('Please enter the staff password.');
    input.focus();
    return;
  }
  button.disabled = true;
  button.classList.add('is-loading');
  label.textContent = 'Signing in...';
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'login', password })
    });
    const result = await response.json();
    if (result.status !== 'success') throw new Error(result.message || 'Incorrect password.');
    staffPassword = password;
    isStaff = true;
    closeStaffLoginModal();
    updateStaffUI();
  } catch (error) {
    console.error('Staff login failed:', error);
    alert('Incorrect password or login service unavailable.');
    input.value = '';
    input.focus();
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
    label.textContent = 'Log in';
  }
}

function logoutStaff() {
  isStaff = false;
  staffPassword = '';
  updateStaffUI();
}

function updateStaffUI() {
  const loginButton = document.getElementById('staffLoginButton');
  const logoutButton = document.getElementById('staffLogoutButton');
  const offsetTabButton = document.getElementById('offsetTabButton');
  const documentsTabButton = document.getElementById('documentsTabButton');
  const discountRow = document.getElementById('discountRow');
  if (loginButton) loginButton.style.display = isStaff ? 'none' : 'inline-flex';
  if (logoutButton) logoutButton.style.display = isStaff ? 'inline-flex' : 'none';
  if (offsetTabButton) offsetTabButton.style.display = isStaff ? 'inline-flex' : 'none';
  if (documentsTabButton) documentsTabButton.style.display = isStaff ? 'inline-flex' : 'none';
  if (discountRow) discountRow.style.display = isStaff ? 'block' : 'none';
  if (!isStaff) document.getElementById('discountInput').value = 0;
  if (rawCatalog.length) {
    const query = document.getElementById('searchInput').value.toLowerCase().trim();
    displayBooks(query ? catalog.filter(b => `${b.title} ${b.author}`.toLowerCase().includes(query)) : catalog);
  }
  renderCart();
  if (!isStaff && (activeAppTab === 'offset' || activeAppTab === 'documents')) switchAppTab('mass');
}

function getDiscountValue() {
  if (!isStaff) return 0;
  return Math.max(0, parseFloat(document.getElementById('discountInput').value) || 0);
}

function switchAppTab(tabName) {
  const cataloguePanel = document.getElementById('catalogueTabPanel');
  const massPanel = document.getElementById('massTabPanel');
  const offsetPanel = document.getElementById('offsetTabPanel');
  const documentsPanel = document.getElementById('documentsTabPanel');
  const catalogueButton = document.getElementById('catalogueTabButton');
  const massButton = document.getElementById('massTabButton');
  const offsetButton = document.getElementById('offsetTabButton');
  const documentsButton = document.getElementById('documentsTabButton');
  const requestedTab = (tabName === 'offset' || tabName === 'documents') && !isStaff ? 'mass' : tabName;
  activeAppTab = requestedTab;
  const panelsByName = { catalogue: cataloguePanel, mass: massPanel, offset: offsetPanel, documents: documentsPanel };
  const activePanel = panelsByName[requestedTab] || cataloguePanel;
  [cataloguePanel, massPanel, offsetPanel, documentsPanel].forEach(panel => {
    const isActive = panel === activePanel;
    panel.hidden = !isActive;
    panel.classList.toggle('is-active', isActive);
  });
  [[catalogueButton, 'catalogue'], [massButton, 'mass'], [offsetButton, 'offset'], [documentsButton, 'documents']].forEach(([button, name]) => {
    const isActive = name === requestedTab;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });
  if (requestedTab === 'documents') loadDocumentsTracker();
}

function switchMassCalculator(calculatorName) {
  const panels = {
    booklet: document.getElementById('bookletCalculatorPanel'),
    poster: document.getElementById('posterCalculatorPanel'),
    'business-card': document.getElementById('businessCardCalculatorPanel')
  };
  const buttons = {
    booklet: document.getElementById('bookletCalculatorTab'),
    poster: document.getElementById('posterCalculatorTab'),
    'business-card': document.getElementById('businessCardCalculatorTab')
  };
  Object.entries(panels).forEach(([name, panel]) => {
    const isActive = name === calculatorName;
    panel.hidden = !isActive;
    panel.classList.toggle('is-active', isActive);
    buttons[name].classList.toggle('is-active', isActive);
    buttons[name].setAttribute('aria-selected', String(isActive));
  });
  calculateClientMassQuote(calculatorName);
}

function clientPaperCost(paperType) {
  return OFFSET_PAPER_COSTS[paperType] || 0;
}

function showSimpleQuoteResult(id, total, unitCost, note) {
  document.getElementById(id).innerHTML = `<div><span>Total cost</span><strong>Kshs. ${offsetMoney(total)}</strong></div><div><span>Unit price</span><strong>Kshs. ${offsetMoney(unitCost)}</strong></div>${note ? `<small>${note}</small>` : ''}`;
}

function calculateClientMassQuote(type) {
  if (type === 'booklet') {
    const pagesInput = document.getElementById('bookletPages');
    const pages = Math.max(1, Number(pagesInput.value || 0));
    const quantity = Math.max(0, Number(document.getElementById('bookletQuantity').value || 0));
    const roundedPages = Math.ceil(pages / 4) * 4;
    const paperSize = document.getElementById('bookletPaperSize').value;
    const colors = Number(document.getElementById('bookletColors').value);
    const paperType = document.getElementById('bookletPaperType').value;
    if (quantity < 100) {
      document.getElementById('bookletResult').innerHTML = '<small>Booklet mass production starts at a minimum of 100 copies.</small>';
      return;
    }
    if (!paperSize || !colors || !paperType) {
      document.getElementById('bookletResult').innerHTML = '<small>Complete the booklet specifications to calculate a quote.</small>';
      return;
    }
    const printJob = calculateMassOffsetJob({ pages: roundedPages, quantity, paperSize, colors, sides: 'Double sided', machine: 'SM', paperCost: clientPaperCost(paperType) });
    const lamination = document.getElementById('bookletLamination').checked ? 5 * quantity : 0;
    const binding = 4 * quantity;
    const collection = Math.ceil(roundedPages / 8) * 5 * quantity;
    const productionCost = printJob.total + lamination + binding + collection;
    const total = productionCost * (1 + CLIENT_PROFIT_MARKUP);
    showSimpleQuoteResult('bookletResult', total, total / quantity, `Billed pages: ${roundedPages}. Double-sided SM printing with binding and collection included.`);
    return;
  }

  if (type === 'poster') {
    const pagesInput = document.getElementById('posterPages');
    const pages = Math.min(2, Math.max(1, Number(pagesInput.value || 1)));
    pagesInput.value = pages;
    const quantity = Math.max(0, Number(document.getElementById('posterQuantity').value || 0));
    const paperSize = document.getElementById('posterPaperSize').value;
    const sides = document.getElementById('posterSides').value;
    const colors = Number(document.getElementById('posterColors').value);
    const paperType = document.getElementById('posterPaperType').value;
    if (!paperSize || !sides || !colors || !paperType) {
      document.getElementById('posterResult').innerHTML = '<small>Complete the poster or flyer specifications to calculate a quote.</small>';
      return;
    }
    const printJob = calculateMassOffsetJob({ pages, quantity, paperSize, colors, sides, machine: 'SM', paperCost: clientPaperCost(paperType) });
    const lamination = document.getElementById('posterLamination').checked ? 5 * quantity : 0;
    const productionCost = printJob.total + 1000 + lamination;
    const total = productionCost * (1 + CLIENT_PROFIT_MARKUP);
    showSimpleQuoteResult('posterResult', total, quantity ? total / quantity : 0, 'Includes the overall production cost and finishing where selected.');
    return;
  }

  const quantity = Math.max(0, Number(document.getElementById('businessCardQuantity').value || 0));
  const paperSize = document.getElementById('businessCardPaperSize').value;
  const sides = document.getElementById('businessCardSides').value;
  const colors = Number(document.getElementById('businessCardColors').value);
  const paperType = document.getElementById('businessCardPaperType').value;
  if (!paperSize || !sides || !colors || !paperType) {
    document.getElementById('businessCardResult').innerHTML = '<small>Complete the business card specifications to calculate a quote.</small>';
    return;
  }
  const printJob = calculateMassOffsetJob({ pages: 1, quantity, paperSize, colors, sides, machine: 'SM', paperCost: clientPaperCost(paperType) });
  const lamination = document.getElementById('businessCardLamination').checked ? 5 * quantity : 0;
  const productionCost = printJob.total + 1000 + lamination;
  const total = productionCost * (1 + CLIENT_PROFIT_MARKUP);
  showSimpleQuoteResult('businessCardResult', total, quantity ? total / quantity : 0, 'Includes the overall production cost and finishing where selected.');
}

function toggleOffsetPaperCost() {
  const paperType = document.getElementById('offsetPaperType').value;
  const paperCost = document.getElementById('offsetPaperCost');
  const isCustom = paperType === 'Others';
  paperCost.disabled = !isCustom;
  if (!isCustom) paperCost.value = '';
}

function offsetNumber(id) {
  return Number(document.getElementById(id).value || 0);
}

function offsetMoney(value) {
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function offsetInputState() {
  return {
    pages: offsetNumber('offsetPages'),
    quantity: offsetNumber('offsetQuantity'),
    paperSize: document.getElementById('offsetPaperSize').value,
    colors: offsetNumber('offsetColors'),
    sides: document.getElementById('offsetSides').value,
    machine: document.getElementById('offsetMachine').value,
    paperType: document.getElementById('offsetPaperType').value,
    paperCost: offsetNumber('offsetPaperCost'),
    cutting: offsetNumber('offsetCutting'),
    packaging: offsetNumber('offsetPackaging'),
    otherOverall: offsetNumber('offsetOtherOverall'),
    collection: offsetNumber('offsetCollection'),
    binding: offsetNumber('offsetBinding'),
    lamination: offsetNumber('offsetLamination'),
    cover: offsetNumber('offsetCover'),
    otherUnit: offsetNumber('offsetOtherUnit')
  };
}

function applyOffsetInputState(state) {
  const fields = {
    offsetPages: state.pages,
    offsetQuantity: state.quantity,
    offsetPaperSize: state.paperSize,
    offsetColors: state.colors,
    offsetSides: state.sides,
    offsetMachine: state.machine,
    offsetPaperType: state.paperType,
    offsetPaperCost: state.paperCost || '',
    offsetCutting: state.cutting || '',
    offsetPackaging: state.packaging || '',
    offsetOtherOverall: state.otherOverall || '',
    offsetCollection: state.collection || '',
    offsetBinding: state.binding || '',
    offsetLamination: state.lamination || '',
    offsetCover: state.cover || '',
    offsetOtherUnit: state.otherUnit || ''
  };
  Object.entries(fields).forEach(([id, value]) => { document.getElementById(id).value = value; });
  toggleOffsetPaperCost();
}

function calculateOffsetQuote() {
  const input = offsetInputState();
  if (input.pages <= 0 || input.quantity <= 0 || input.colors <= 0) {
    alert('Pages, quantity, and colours must be positive whole numbers.');
    return;
  }

  const rimCost = input.paperType === 'Others' ? input.paperCost : OFFSET_PAPER_COSTS[input.paperType];
  if (!Number.isFinite(rimCost) || rimCost < 0) {
    alert("Enter a valid rim cost when paper type is 'Others'.");
    return;
  }

  const printedSides = OFFSET_SIDES[input.sides];
  const paperDivisor = OFFSET_PAPER_DIVISORS[input.paperSize];
  const machineRunCost = OFFSET_MACHINE_COSTS[input.machine];
  const a3Sheets = input.quantity / paperDivisor;
  const a3EquivalentPages = input.pages / paperDivisor;
  const plates = Math.ceil(a3EquivalentPages) * input.colors;
  const plateCost = plates * OFFSET_PLATE_COST;
  const runCalculation = Math.ceil(a3Sheets / 1000) * input.colors * Math.ceil(a3EquivalentPages);
  const runs = input.pages === 1 ? runCalculation * printedSides : runCalculation;
  const runCost = runs * machineRunCost;
  const rimsNeeded = input.pages > 1
    ? ((a3Sheets / 500) / printedSides) * input.pages
    : a3Sheets / 500;
  const rimsCharged = Math.max(1, rimsNeeded);
  const materialCost = rimsCharged * rimCost;
  const coreTotal = plateCost + runCost + materialCost;
  const overallFixed = input.cutting + input.packaging + input.otherOverall;
  const variableFinishingPerCopy = input.collection + input.binding + input.lamination + input.cover + input.otherUnit;
  const variableFinishingTotal = variableFinishingPerCopy * input.quantity;
  const finishingCost = overallFixed + variableFinishingTotal;
  const preProfitCost = coreTotal + finishingCost;
  const totalProfit = preProfitCost * ADMIN_PROFIT_MARKUP;
  const totalCost = preProfitCost + totalProfit;
  const unitCost = totalCost / input.quantity;
  const result = { ...input, rimCost, plates, plateCost, runs, runCost, rimsCharged, materialCost, coreTotal, overallFixed, variableFinishingPerCopy, variableFinishingTotal, preProfitCost, totalProfit, totalCost, unitCost };

  const message = [
    '--- INPUTS ---',
    `Pages: ${input.pages}\t\t Quantity: ${input.quantity}`,
    `Paper Type: ${input.paperType} (Kshs. ${offsetMoney(rimCost)}/Rim)`,
    `Size/Colors: ${input.paperSize} / ${input.colors} Colors`,
    '',
    '--- CORE PRODUCTION BREAKDOWN ---',
    `Plates Count: ${plates}\t\t Plate Cost (@${offsetMoney(OFFSET_PLATE_COST)}/Plate): Kshs. ${offsetMoney(plateCost)}`,
    `Machine Runs: ${runs.toFixed(2)}\t\t Runs Cost (@${offsetMoney(machineRunCost)}/Run): Kshs. ${offsetMoney(runCost)}`,
    `Rims Charged: ${rimsCharged.toFixed(2)}\t\t Material Cost: Kshs. ${offsetMoney(materialCost)}`,
    `-> CORE TOTAL: Kshs. ${offsetMoney(coreTotal)}`,
    '',
    '--- FINISHING & PROFIT BREAKDOWN ---',
    `Total Overall Fixed Costs: Kshs. ${offsetMoney(overallFixed)}`,
    `Variable Fin. Cost Per Copy (Excl. Profit): Kshs. ${offsetMoney(variableFinishingPerCopy)}`,
    `Total Variable Fin. Cost: Kshs. ${offsetMoney(variableFinishingTotal)}`,
    `Profit Margin (20% of pre-profit cost): Kshs. ${offsetMoney(totalProfit)}`,
    '',
    '--- FINAL QUOTE ---',
    `TOTAL FINAL COST (Incl. Profit): Kshs. ${offsetMoney(totalCost)}`,
    `UNIT COST (Selling Price per Copy): Kshs. ${offsetMoney(unitCost)}`
  ].join('\n');

  document.getElementById('offsetResult').textContent = message;
  offsetHistory.unshift({ input, message, totalCost, quantity: input.quantity });
  offsetHistory = offsetHistory.slice(0, 5);
  updateOffsetHistory();
}

function updateOffsetHistory() {
  const select = document.getElementById('offsetHistory');
  const loadButton = document.getElementById('offsetLoadHistory');
  select.innerHTML = '';
  offsetHistory.forEach((record, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = `Quote #${index + 1} | Qty: ${record.quantity} | Total: Kshs. ${offsetMoney(record.totalCost)}`;
    select.appendChild(option);
  });
  select.disabled = offsetHistory.length === 0;
  loadButton.disabled = offsetHistory.length === 0;
}

function loadOffsetHistory() {
  const index = Number(document.getElementById('offsetHistory').value);
  const record = offsetHistory[index];
  if (!record) return;
  applyOffsetInputState(record.input);
  document.getElementById('offsetResult').textContent = record.message;
}

function resetOffsetCalculator() {
  applyOffsetInputState({ pages: '', quantity: '', paperSize: '', colors: '', sides: '', machine: '', paperType: '', paperCost: '', cutting: '', packaging: '', otherOverall: '', collection: '', binding: '', lamination: '', cover: '', otherUnit: '' });
  document.getElementById('offsetResult').textContent = 'Enter your specifications and calculate an offset quote.';
  offsetHistory = [];
  updateOffsetHistory();
}

// Staff-only: saves the permanent catalogue price in the shared books sheet.
async function editSpecialPrice(bookId) {
  if (!isStaff) return;
  const book = catalog.find(b => b.id === bookId);
  if (!book) return;
  const promptValue = book.hasSpecialPrice ? Number(book.unitCost).toFixed(2) : '';
  const input = prompt(`Set a permanent special price (Kshs) for "${book.title}".\nLeave blank and press OK to clear the special price and use the standard catalogue price (Kshs. ${Number(book.calculatedUnitCost ?? book.unitCost).toFixed(2)}).`, promptValue);
  if (input === null) return;
  const trimmed = input.trim();
  const specialPrice = trimmed === '' ? null : parseFloat(trimmed);
  if (specialPrice !== null && (!Number.isFinite(specialPrice) || specialPrice < 0)) {
    alert('Please enter a valid, non-negative price.');
    return;
  }
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'set_special_price', bookId, specialPrice, staffPassword })
    });
    const result = await response.json();
    if (result.status !== 'success') throw new Error(result.message || 'The special price could not be saved.');
    await loadCatalog();
  } catch (error) {
    console.error('Special price update failed:', error);
    alert('The special price could not be saved. Please try again.');
  }
}

function getUnitPrice(item) {
  if (getProductionMode(item) === 'mass') {
    item.massCalculation = calculateMassProduction(item);
    item.massUnitCost = item.massCalculation.unitCost;
    return item.massUnitCost;
  }
  return Number(item.activeUnitCost);
}

function getProductionMode(item) {
  if (item.productionMode === 'mass') return 'mass';
  if (item.productionMode === 'sample') return 'sample';
  return item.quantity >= MASS_PRODUCTION_THRESHOLD ? 'mass' : 'sample';
}

function getSizeLabel(sizeCode) {
  return SIZE_LABELS[String(sizeCode)] || 'A5 Size';
}

function getBookSizeName(sizeCode) {
  return getSizeLabel(sizeCode).replace(/\s+Size$/i, '').trim();
}

function calculateMassOffsetJob({ pages, quantity, paperSize, colors, sides, machine, paperCost }) {
  if (pages <= 0) return { total: 0, plates: 0, runs: 0, material: 0 };
  const paperDivisor = OFFSET_PAPER_DIVISORS[paperSize];
  const printedSides = OFFSET_SIDES[sides];
  const machineRunCost = OFFSET_MACHINE_COSTS[machine];
  const a3Sheets = quantity / paperDivisor;
  const a3EquivalentPages = pages / paperDivisor;
  const plates = Math.ceil(a3EquivalentPages) * colors;
  const plateCost = plates * OFFSET_PLATE_COST;
  const runBase = Math.ceil(a3Sheets / 1000) * colors * Math.ceil(a3EquivalentPages);
  const runs = pages === 1 ? runBase * printedSides : runBase;
  const runCost = runs * machineRunCost;
  const rimsNeeded = pages > 1
    ? ((a3Sheets / 500) / printedSides) * pages
    : a3Sheets / 500;
  const rimsCharged = Math.max(1, rimsNeeded);
  const material = rimsCharged * paperCost;
  return { total: plateCost + runCost + material, plates, runs, material };
}

function calculateMassProduction(item) {
  const bookSize = getBookSizeName(item.selectedSizeCode);
  const coverPaperSize = { A6: 'A5', A5: 'A4', A4: 'A3' }[bookSize];
  const quantity = item.quantity;
  const overallCost = Math.ceil(quantity / 1000) * MASS_GENERAL_OVERALL_PER_1000;
  const coverJob = calculateMassOffsetJob({
    pages: 1,
    quantity,
    paperSize: coverPaperSize,
    colors: 4,
    sides: 'Single sided',
    machine: 'SM',
    paperCost: MASS_ART_CARD_COST
  });
  const blackPages = Math.max(0, Number(item.pages) - Number(item.colorPages || 0));
  const colourPages = Math.max(0, Number(item.colorPages || 0));
  const blackJob = calculateMassOffsetJob({
    pages: blackPages,
    quantity,
    paperSize: bookSize,
    colors: 1,
    sides: 'Double sided',
    machine: 'SM',
    paperCost: MASS_BOND_80_COST
  });
  const colourJob = calculateMassOffsetJob({
    pages: colourPages,
    quantity,
    paperSize: bookSize,
    colors: 4,
    sides: 'Double sided',
    machine: 'SM',
    paperCost: MASS_BOND_80_COST
  });
  const coverGeneral = MASS_COVER_GENERAL_PER_COPY[bookSize] || 0;
  const coverPreProfitTotal = coverJob.total + (coverGeneral * quantity) + overallCost;
  const insertsPreProfitTotal = blackJob.total + colourJob.total + overallCost;
  const preProfitTotal = coverPreProfitTotal + insertsPreProfitTotal;
  const total = preProfitTotal * (1 + CLIENT_PROFIT_MARKUP);
  return {
    total,
    unitCost: total / quantity,
    coverUnitCost: coverPreProfitTotal / quantity,
    insertsUnitCost: insertsPreProfitTotal / quantity,
    coverPaperSize,
    bookSize,
    blackPages,
    colourPages,
    overallCost
  };
}

function setProductionMode(bookId, mode) {
  const item = cart.find(entry => entry.id === bookId);
  if (!item) return;
  item.productionMode = mode;
  renderCart();
}

function computeOrderTotals(subtotal, discount) {
  const discounted = Math.max(0, subtotal - discount);
  const minimumApplied = cart.length > 0 && discounted < MINIMUM_ORDER_AMOUNT;
  const total = minimumApplied ? MINIMUM_ORDER_AMOUNT : discounted;
  return { subtotal, discount, total, minimumApplied };
}

function showCatalogProgress(progress, status) {
  const grid = document.getElementById('catalogGrid');
  let progressBar = grid.querySelector('.catalog-progress');
  if (!progressBar) {
    grid.innerHTML = '<div class="loading"><div class="catalog-progress"><div class="progress-heading"><span>Loading catalogue</span><span class="progress-percent">0%</span></div><div class="progress-track" role="progressbar" aria-label="Loading catalogue" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="progress-fill"></div></div><div class="progress-status"></div></div></div>';
    progressBar = grid.querySelector('.catalog-progress');
  }
  const safeProgress = Math.max(0, Math.min(100, Math.round(progress)));
  progressBar.dataset.progress = safeProgress;
  progressBar.querySelector('.progress-percent').textContent = `${safeProgress}%`;
  progressBar.querySelector('.progress-fill').style.width = `${safeProgress}%`;
  progressBar.querySelector('.progress-track').setAttribute('aria-valuenow', safeProgress);
  progressBar.querySelector('.progress-status').textContent = status;
  document.getElementById('catalogCount').textContent = `${safeProgress}% loading`;
  if (safeProgress >= 100) {
    clearInterval(catalogProgressTimer);
    catalogProgressTimer = null;
  }
}

function showCatalogError(message) {
  clearInterval(catalogProgressTimer);
  document.getElementById('catalogGrid').innerHTML = `<div class="loading">${message}</div>`;
  document.getElementById('catalogCount').textContent = 'Unavailable';
}

function displayBooks(books) {
  const grid = document.getElementById('catalogGrid');
  books = sortCatalogue(books);
  grid.classList.toggle('list-view', catalogueView === 'list');
  document.getElementById('catalogCount').textContent = `${books.length} title${books.length === 1 ? '' : 's'}`;
  if (!books.length) { grid.innerHTML = '<div class="loading">No books match your search.</div>'; return; }
  
  grid.innerHTML = books.map(book => `
    <article class="book-card" tabindex="0" role="button" onclick="openBookDetails(${book.id})" onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openBookDetails(${book.id}); }">
      <div>
        ${book.coverUrl 
          ? `<img src="${formatDriveUrl(book.coverUrl)}" class="cover-thumb" alt="${escapeHtml(book.title)} cover" onerror="this.replaceWith(createPlaceholder(this.alt.replace(/ cover$/, '')))">` 
          : createPlaceholderMarkup(book.title)}
        <div class="book-title">${escapeHtml(book.title)}</div>
        <div class="book-author">${escapeHtml(book.author)}</div>
        <div class="book-meta">
          <span>${book.pages} pgs</span>
          <span>${escapeHtml(SIZE_LABELS[String(book.sizeCode)] || book.sizeLabel)}</span>
        </div>
      </div>
      <div class="book-footer">
        <div class="price-row">
          <div class="book-price">Kshs. ${Number(book.unitCost).toFixed(2)}</div>
          ${book.hasSpecialPrice ? '<span class="custom-price-tag">Special price</span>' : ''}
        </div>
        ${isStaff ? `<button type="button" class="link-btn" onclick="event.stopPropagation(); editSpecialPrice(${book.id})">${book.hasSpecialPrice ? 'Edit special price' : 'Set special price'}</button>` : ''}
        <button class="add-btn" onclick="event.stopPropagation(); addToCart(${book.id})">Add to quote</button>
      </div>
    </article>
  `).join('');
}

function setCatalogueView(view) {
  catalogueView = view;
  document.getElementById('gridViewButton').classList.toggle('is-active', view === 'grid');
  document.getElementById('listViewButton').classList.toggle('is-active', view === 'list');
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  displayBooks(query ? catalog.filter(book => `${book.title} ${book.author}`.toLowerCase().includes(query)) : catalog);
}

function openBookDetails(bookId) {
  const book = catalog.find(entry => entry.id === bookId);
  if (!book) return;
  document.getElementById('bookDetailTitle').textContent = book.title;
  document.getElementById('bookDetailAuthor').textContent = book.author || 'Cavalry Publishers';
  document.getElementById('bookDetailPages').textContent = `${book.pages} pages`;
  document.getElementById('bookDetailColor').textContent = `${book.colorPages} colour pages`;
  document.getElementById('bookDetailSize').textContent = SIZE_LABELS[String(book.sizeCode)] || book.sizeLabel || 'Standard';
  document.getElementById('bookDetailPrice').innerHTML = `Kshs. ${Number(book.unitCost).toLocaleString('en-US', { minimumFractionDigits: 2 })}${book.hasSpecialPrice ? ' <span class="custom-price-tag">Special price</span>' : ''}`;
  const editPriceButton = document.getElementById('bookDetailEditPrice');
  editPriceButton.style.display = isStaff ? 'inline' : 'none';
  editPriceButton.onclick = () => editSpecialPrice(book.id);
  const cover = document.getElementById('bookDetailCover');
  cover.innerHTML = book.coverUrl ? `<img class="book-detail-cover" src="${formatDriveUrl(book.coverUrl)}" alt="${escapeHtml(book.title)} cover" onerror="this.replaceWith(createPlaceholder(this.alt.replace(/ cover$/, '')))" />` : createPlaceholderMarkup(book.title);
  const detailCover = cover.firstElementChild;
  if (detailCover && !detailCover.classList.contains('cover-placeholder')) detailCover.classList.add('book-detail-cover');
  document.getElementById('bookDetailAdd').onclick = () => { addToCart(book.id); closeBookDetails(); };
  document.getElementById('bookDetailModal').style.display = 'flex';
}

function closeBookDetails() { document.getElementById('bookDetailModal').style.display = 'none'; }

function sortCatalogue(books) {
  return [...books].sort((first, second) => String(first.title || '').localeCompare(String(second.title || ''), undefined, { sensitivity: 'base', numeric: true }));
}

function createPlaceholder(title) {
  const div = document.createElement('div');
  div.className = `cover-placeholder tone-${getCoverTone(title)}`;
  div.innerHTML = `<span class="cover-kicker">Cavalry Publishers</span><span class="cover-title">${escapeHtml(title)}</span><span class="cover-mark">Book printing edition</span>`;
  return div;
}

function getCoverTone(title) {
  return (Array.from(String(title)).reduce((total, character) => total + character.charCodeAt(0), 0) % 4) + 1;
}

function createPlaceholderMarkup(title) {
  return `<div class="cover-placeholder tone-${getCoverTone(title)}"><span class="cover-kicker">Cavalry Publishers</span><span class="cover-title">${escapeHtml(title)}</span><span class="cover-mark">Book printing edition</span></div>`;
}

function filterCatalog() {
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  displayBooks(catalog.filter(b => `${b.title} ${b.author}`.toLowerCase().includes(query)));
}

function addToCart(bookId) {
  const item = cart.find(i => i.id === bookId);
  if (item) { 
    item.quantity++; 
  } else { 
    const book = catalog.find(e => e.id === bookId); 
    if (book) {
      cart.push({ 
        ...book, 
        selectedSizeCode: String(book.sizeCode || "1"),
        activeUnitCost: book.unitCost,
        productionMode: 'auto',
        quantity: 1 
      }); 
    } 
  }
  renderCart();
}

async function updateSize(bookId, newSizeCode) {
  const item = cart.find(i => i.id === bookId);
  if (!item) return;

  const previousSizeCode = item.selectedSizeCode;
  item.selectedSizeCode = String(newSizeCode);

  if (String(newSizeCode) === String(item.sizeCode)) {
    item.activeUnitCost = item.unitCost;
    renderCart();
    return;
  }

  item.pricePending = true;
  renderCart();

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'calculate_cost',
        pages: item.pages,
        colorPages: item.colorPages,
        sizeCode: String(newSizeCode)
      })
    });
    const result = await response.json();
    const backendUnitCost = Number(result.unitCost ?? result.cost ?? result.data?.unitCost);
    if (result.status !== 'success' || !Number.isFinite(backendUnitCost)) {
      throw new Error(result.message || 'The backend did not return a valid price.');
    }
    item.activeUnitCost = backendUnitCost;
  } catch (error) {
    console.error('Backend price calculation failed:', error);
    item.selectedSizeCode = previousSizeCode;
    alert('The price for this size could not be calculated. Please try again.');
  }
  item.pricePending = false;
  renderCart();
}

function updateQty(bookId, qty) {
  const item = cart.find(i => i.id === bookId);
  if (item) item.quantity = Math.max(1, parseInt(qty, 10) || 1);
  renderCart();
}

function removeFromCart(bookId) {
  cart = cart.filter(i => i.id !== bookId);
  renderCart();
}

function openCart() {
  document.querySelector('.quote-panel').classList.add('is-open');
  document.getElementById('drawerBackdrop').classList.add('is-visible');
  document.getElementById('cartFab').setAttribute('aria-expanded', 'true');
}

function closeCart() {
  document.querySelector('.quote-panel').classList.remove('is-open');
  document.getElementById('drawerBackdrop').classList.remove('is-visible');
  document.getElementById('cartFab').setAttribute('aria-expanded', 'false');
}

function focusCheckout() {
  openCart();
  document.querySelector('.quote-panel').scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('clientName').focus();
}

function getCurrentOrderSnapshot() {
  const discount = getDiscountValue();
  const subtotal = cart.reduce((sum, item) => sum + (getUnitPrice(item) * item.quantity), 0);
  const totals = computeOrderTotals(subtotal, discount);
  return {
    clientName: document.getElementById('clientName').value.trim() || 'Valued Client',
    clientPhone: document.getElementById('clientPhone').value.trim(),
    items: cart.map(item => ({
      title: item.title,
      quantity: item.quantity,
      unitPrice: getUnitPrice(item),
      total: getUnitPrice(item) * item.quantity,
      mode: getProductionMode(item),
      size: SIZE_LABELS[String(item.selectedSizeCode)] || 'Standard',
      pages: item.pages
    })),
    ...totals
  };
}

function createCheckoutReference() {
  return `INV-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

function renderCheckoutSummary(order) {
  document.getElementById('checkoutReference').textContent = checkoutReference;
  document.getElementById('checkoutSummary').innerHTML = order.items.map(item => `
    <div class="checkout-summary-item">
      <div><strong>${escapeHtml(item.title)}</strong><small>${item.quantity} × Kshs. ${item.unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })} · ${item.mode === 'mass' ? 'Mass' : 'Sample'} · ${escapeHtml(item.size)} · ${item.pages} pages</small></div>
      <strong>Kshs. ${item.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
    </div>
  `).join('');
  document.getElementById('checkoutTotal').textContent = `Kshs. ${order.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

function openCheckoutModal() {
  if (!cart.length) {
    alert('Add at least one book to your quote first.');
    return;
  }
  checkoutReference = createCheckoutReference();
  renderCheckoutSummary(getCurrentOrderSnapshot());
  document.getElementById('checkoutStatus').textContent = '';
  document.getElementById('checkoutStatus').className = 'checkout-status';
  document.getElementById('checkoutModal').style.display = 'flex';
}

function closeCheckoutModal() { document.getElementById('checkoutModal').style.display = 'none'; }

function togglePaymentFields() {
  const method = document.querySelector('input[name="paymentMethod"]:checked').value;
  document.getElementById('mpesaFields').hidden = method !== 'mpesa';
  document.getElementById('paybillFields').hidden = method !== 'paybill';
}

function setCheckoutStatus(message, type) {
  const status = document.getElementById('checkoutStatus');
  status.textContent = message;
  status.className = `checkout-status${type ? ` is-${type}` : ''}`;
}

async function submitCheckoutPayment() {
  if (!cart.length) return;
  const method = document.querySelector('input[name="paymentMethod"]:checked').value;
  const phone = document.getElementById('checkoutMpesaPhone').value.trim();
  const transactionCode = document.getElementById('checkoutPaybillCode').value.trim().toUpperCase();
  if (method === 'mpesa' && phone.replace(/\D/g, '').length < 10) {
    setCheckoutStatus('Enter a valid M-Pesa phone number.', 'error');
    return;
  }
  if (method === 'paybill' && !transactionCode) {
    setCheckoutStatus('Enter the Equity transaction code after payment.', 'error');
    return;
  }
  const order = getCurrentOrderSnapshot();
  setCheckoutStatus('Submitting your order for payment verification...', '');
  try {
    const orderResponse = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'submit_order',
        quotationNumber: checkoutReference,
        paymentMethod: method,
        paymentPhone: method === 'mpesa' ? phone : '',
        transactionCode: method === 'paybill' ? transactionCode : '',
        clientName: order.clientName,
        clientPhone: order.clientPhone,
        items: order.items,
        itemsSummary: order.items.map(item => `${item.quantity}x ${item.title} (${item.mode})`).join('; '),
        subtotal: order.subtotal,
        discount: order.discount,
        total: order.total
      })
    });
    const orderResult = await orderResponse.json();
    if (orderResult.status !== 'success') throw new Error(orderResult.message || 'Order submission failed.');
    const invoiceResponse = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'convert_order_to_invoice', orderReference: orderResult.reference })
    });
    const invoiceResult = await invoiceResponse.json();
    if (invoiceResult.status !== 'success') throw new Error(invoiceResult.message || 'Invoice creation failed.');
    currentDocument = invoiceResult.data || { ...order, type: 'invoice', reference: invoiceResult.reference, status: 'PENDING' };
    currentDocument.type = 'invoice';
    currentDocument.reference = invoiceResult.reference;
    if (method === 'paybill') {
      const receiptResponse = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'confirm_invoice_payment', invoiceReference: invoiceResult.reference, paymentMethod: method, paymentReference: transactionCode })
      });
      const receiptResult = await receiptResponse.json();
      if (receiptResult.status === 'success') {
        currentDocument = receiptResult.data || currentDocument;
        currentDocument.type = 'receipt';
        currentDocument.reference = receiptResult.reference;
      }
    }
    document.getElementById('checkoutDocumentActions').hidden = false;
    setCheckoutStatus(method === 'mpesa' ? `Invoice ${invoiceResult.reference} created and awaiting payment verification.` : `Receipt ${currentDocument.reference} created and payment recorded.`, 'success');
    openDocumentPreview();
  } catch (error) {
    console.error('Checkout submission failed:', error);
    setCheckoutStatus('The order could not be submitted. Please try again or send it to WhatsApp.', 'error');
  }
}

const COMPANY_LOGO_URL = 'https://lh3.googleusercontent.com/d/1F2xjo6EPzhSGZMFRrP8IAaMWXe_o7xKG=s1000';

function renderDocumentHtml(documentData) {
  const status = String(documentData.status || 'PENDING').toUpperCase();
  const items = documentData.items || [];
  return `<img class="document-watermark-logo" src="${COMPANY_LOGO_URL}" alt="" crossorigin="anonymous" aria-hidden="true" onerror="this.style.display='none';">
    <header class="document-render-header">
      <div class="document-render-brand">
        <img class="document-brand-logo" src="${COMPANY_LOGO_URL}" alt="Cavalry Publishers" crossorigin="anonymous" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
        <div class="document-brand-fallback">CAVALRY<span>PUBLISHERS</span></div>
      </div>
      <div class="document-render-heading"><h1>${escapeHtml(documentData.type || 'invoice')}</h1><p>${escapeHtml(documentData.reference || '')}</p><p>${new Date().toLocaleDateString('en-GB')}</p></div>
    </header>
    <div class="document-render-meta"><div>Prepared for<strong>${escapeHtml(documentData.clientName || 'Valued Client')}</strong><span>${escapeHtml(documentData.clientPhone || 'Phone not provided')}</span></div><div>Payment status<strong>${escapeHtml(status)}</strong><span>${escapeHtml(documentData.paymentMethod || 'Payment pending')}</span></div></div>
    <table class="document-render-table"><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>${items.map(item => `<tr><td>${escapeHtml(item.title || item.name || '')}<br><small>${escapeHtml(item.mode || '')} ${escapeHtml(item.size || '')}</small></td><td>${item.quantity || 0}</td><td>Kshs. ${Number(item.unitPrice || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td>Kshs. ${Number(item.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>`).join('')}</tbody></table>
    <div class="document-render-total"><span>Total Kshs.</span><strong>${Number(documentData.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></div>
    <div class="document-status-stamp ${status === 'PAID' ? '' : 'pending'}">${escapeHtml(status)}</div>`;
}

function openDocumentPreview() {
  if (!currentDocument) return;
  document.getElementById('documentPreviewTitle').textContent = `${currentDocument.type || 'Document'} ${currentDocument.reference || ''}`;
  document.getElementById('documentRenderSurface').innerHTML = renderDocumentHtml(currentDocument);
  const confirmButton = document.getElementById('confirmDocumentPaymentButton');
  confirmButton.hidden = !(isStaff && currentDocument.type === 'invoice' && currentDocument.status !== 'PAID');
  document.getElementById('documentPreviewModal').style.display = 'flex';
}

function closeDocumentPreview() { document.getElementById('documentPreviewModal').style.display = 'none'; }

async function confirmCurrentInvoicePayment() {
  if (!currentDocument || currentDocument.type !== 'invoice' || !isStaff) return;
  const paymentMethod = prompt('Payment method (cash, mpesa, or paybill):', 'cash');
  if (!paymentMethod) return;
  const paymentReference = prompt('Payment reference or transaction code (optional):', '') || '';
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'confirm_invoice_payment', invoiceReference: currentDocument.reference, paymentMethod, paymentReference })
    });
    const result = await response.json();
    if (result.status !== 'success') throw new Error(result.message || 'Payment confirmation failed.');
    currentDocument = result.data;
    currentDocument.type = 'receipt';
    currentDocument.reference = result.reference;
    openDocumentPreview();
  } catch (error) {
    console.error('Invoice payment confirmation failed:', error);
    alert('The payment could not be confirmed. Please try again.');
  }
}

// Admin-only: loads every quote/order/invoice/receipt for the tracking & accounting tab.
async function loadDocumentsTracker() {
  if (!isStaff) return;
  const tableBody = document.getElementById('documentsTableBody');
  tableBody.innerHTML = '<tr><td colspan="7" class="documents-empty">Loading documents...</td></tr>';
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'list_documents', staffPassword })
    });
    const result = await response.json();
    if (result.status !== 'success') throw new Error(result.message || 'Documents could not be loaded.');
    allDocuments = result.data || [];
    renderAccountingSummary();
    renderDocumentsTable();
  } catch (error) {
    console.error('Loading documents failed:', error);
    tableBody.innerHTML = '<tr><td colspan="7" class="documents-empty">Documents could not be loaded. Please refresh.</td></tr>';
  }
}

function formatKshs(value) {
  return `Kshs. ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

// Basic accounting: quoted/ordered volume, outstanding invoices, and collected receipts.
function renderAccountingSummary() {
  const quotesTotal = allDocuments.filter(doc => doc.type === 'quotation').reduce((sum, doc) => sum + doc.total, 0);
  const ordersTotal = allDocuments.filter(doc => doc.type === 'order').reduce((sum, doc) => sum + doc.total, 0);
  const invoices = allDocuments.filter(doc => doc.type === 'invoice');
  const outstandingInvoices = invoices.filter(doc => doc.status !== 'PAID');
  const outstandingTotal = outstandingInvoices.reduce((sum, doc) => sum + doc.total, 0);
  const receipts = allDocuments.filter(doc => doc.type === 'receipt');
  const collectedTotal = receipts.reduce((sum, doc) => sum + doc.total, 0);

  const cards = [
    { label: 'Quotes issued', value: `${allDocuments.filter(d => d.type === 'quotation').length} · ${formatKshs(quotesTotal)}` },
    { label: 'Active orders', value: `${allDocuments.filter(d => d.type === 'order').length} · ${formatKshs(ordersTotal)}` },
    { label: 'Outstanding invoices', value: `${outstandingInvoices.length} · ${formatKshs(outstandingTotal)}`, highlight: true },
    { label: 'Revenue collected', value: `${receipts.length} · ${formatKshs(collectedTotal)}` }
  ];
  document.getElementById('accountingSummary').innerHTML = cards.map(card => `<div${card.highlight ? ' class="accounting-highlight"' : ''}><span>${escapeHtml(card.label)}</span><strong>${card.value}</strong></div>`).join('');
}

function setDocumentsFilter(filter) {
  documentsFilter = filter;
  document.querySelectorAll('.documents-filter-button').forEach(button => {
    button.classList.toggle('is-active', button.dataset.docFilter === filter);
  });
  renderDocumentsTable();
}

function documentStatusClass(status) {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'PAID') return 'is-paid';
  if (normalized === 'ACTIVE') return 'is-active';
  if (normalized === 'QUOTED') return 'is-quoted';
  return 'is-pending';
}

function renderDocumentsTable() {
  const query = document.getElementById('documentsSearchInput').value.toLowerCase().trim();
  const tableBody = document.getElementById('documentsTableBody');
  const filtered = allDocuments.filter(doc => {
    const matchesFilter = documentsFilter === 'all' || doc.type === documentsFilter;
    const matchesQuery = !query || `${doc.reference} ${doc.clientName}`.toLowerCase().includes(query);
    return matchesFilter && matchesQuery;
  });

  if (!filtered.length) {
    tableBody.innerHTML = '<tr><td colspan="7" class="documents-empty">No documents match this view.</td></tr>';
    return;
  }

  tableBody.innerHTML = filtered.map(doc => {
    const actions = [`<button type="button" onclick="viewDocumentFromList('${doc.type}', '${escapeHtml(doc.reference)}')">View</button>`];
    if (doc.type === 'order') actions.push(`<button type="button" onclick="convertOrderToInvoiceFromList('${escapeHtml(doc.reference)}')">To invoice</button>`);
    if (doc.type === 'invoice' && doc.status !== 'PAID') actions.push(`<button type="button" onclick="confirmInvoicePaymentFromList('${escapeHtml(doc.reference)}')">Confirm payment</button>`);
    return `<tr>
      <td>${doc.timestamp ? new Date(doc.timestamp).toLocaleDateString('en-GB') : ''}</td>
      <td><span class="document-type-tag">${escapeHtml(doc.type)}</span></td>
      <td>${escapeHtml(doc.reference)}</td>
      <td>${escapeHtml(doc.clientName || 'Valued Client')}</td>
      <td>${formatKshs(doc.total)}</td>
      <td><span class="document-status-tag ${documentStatusClass(doc.status)}">${escapeHtml(doc.status || '')}</span></td>
      <td><div class="documents-row-actions">${actions.join('')}</div></td>
    </tr>`;
  }).join('');
}

function viewDocumentFromList(type, reference) {
  const doc = allDocuments.find(entry => entry.type === type && entry.reference === reference);
  if (!doc) return;
  currentDocument = doc;
  openDocumentPreview();
}

async function convertOrderToInvoiceFromList(orderReference) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'convert_order_to_invoice', orderReference })
    });
    const result = await response.json();
    if (result.status !== 'success') throw new Error(result.message || 'Invoice creation failed.');
    await loadDocumentsTracker();
  } catch (error) {
    console.error('Order to invoice conversion failed:', error);
    alert('The order could not be converted to an invoice. Please try again.');
  }
}

async function confirmInvoicePaymentFromList(invoiceReference) {
  const paymentMethod = prompt('Payment method (cash, mpesa, or paybill):', 'cash');
  if (!paymentMethod) return;
  const paymentReference = prompt('Payment reference or transaction code (optional):', '') || '';
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'confirm_invoice_payment', invoiceReference, paymentMethod, paymentReference })
    });
    const result = await response.json();
    if (result.status !== 'success') throw new Error(result.message || 'Payment confirmation failed.');
    await loadDocumentsTracker();
  } catch (error) {
    console.error('Invoice payment confirmation failed:', error);
    alert('The payment could not be confirmed. Please try again.');
  }
}

async function generatePDF(docType, docRef) {
  if (!currentDocument || currentDocument.reference !== docRef) return;
  try {
    const surface = document.getElementById('documentRenderSurface');
    const canvas = await html2canvas(surface, { backgroundColor: '#ffffff', scale: 2, useCORS: true });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const width = 180;
    const height = canvas.height * width / canvas.width;
    pdf.addImage(canvas.toDataURL('image/jpeg', .95), 'JPEG', 15, 15, width, height);
    pdf.save(`Cavalry-${docType}-${docRef}.pdf`);
  } catch (error) {
    console.error('Document PDF generation failed:', error);
    alert('The document PDF could not be generated. Please try again.');
  }
}

async function generateJPEG(docType, docRef) {
  if (!currentDocument || currentDocument.reference !== docRef) return;
  try {
    const canvas = await html2canvas(document.getElementById('documentRenderSurface'), { backgroundColor: '#ffffff', scale: 2, useCORS: true });
    const link = document.createElement('a');
    link.download = `Cavalry-${docType}-${docRef}.jpg`;
    link.href = canvas.toDataURL('image/jpeg', .95);
    link.click();
  } catch (error) {
    console.error('Document JPEG generation failed:', error);
    alert('The document JPEG could not be generated. Please try again.');
  }
}

async function shareDocumentViaWhatsApp() {
  if (!currentDocument) return;
  await generateJPEG(currentDocument.type, currentDocument.reference);
  const items = (currentDocument.items || []).map((item, index) => `${index + 1}. ${item.quantity} x ${item.title} - Kshs. ${Number(item.total || 0).toFixed(2)}`).join('\n');
  const message = `*CAVALRY PUBLISHERS ${String(currentDocument.type || 'DOCUMENT').toUpperCase()}*\nReference: ${currentDocument.reference}\nStatus: ${currentDocument.status || 'PENDING'}\nClient: ${currentDocument.clientName || 'Valued Client'}\n\n${items}\n\n*TOTAL: Kshs. ${Number(currentDocument.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}*\n\nDocument image/PDF has been generated for download.`;
  window.open(`https://wa.me/${COMPANY_WHATSAPP}?text=${encodeURIComponent(message)}`, '_blank');
}

function buildCheckoutWhatsAppMessage(order) {
  const itemLines = order.items.map((item, index) => `${index + 1}. ${item.quantity} × ${item.title}\n   ${item.mode === 'mass' ? 'Mass' : 'Sample'} | ${item.size} | ${item.pages} pages | Kshs. ${item.unitPrice.toFixed(2)} each\n   Amount: Kshs. ${item.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  return `*CAVALRY PUBLISHERS ORDER*\nReference: ${checkoutReference}\nClient: ${order.clientName}\nPhone: ${order.clientPhone || 'Not provided'}\n\n${itemLines.join('\n\n')}\n\nSubtotal: Kshs. ${order.subtotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}\nDiscount: Kshs. ${order.discount.toLocaleString('en-US', { minimumFractionDigits: 2 })}\n*TOTAL: Kshs. ${order.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}*\n\nPlease confirm payment instructions and production details.`;
}

function sendCheckoutToWhatsApp() {
  if (!cart.length) return;
  if (!checkoutReference) checkoutReference = createCheckoutReference();
  const order = getCurrentOrderSnapshot();
  window.open(`https://wa.me/${COMPANY_WHATSAPP}?text=${encodeURIComponent(buildCheckoutWhatsAppMessage(order))}`, '_blank');
}

function updateCartFab() {
  const itemCount = cart.reduce((total, item) => total + item.quantity, 0);
  const fab = document.getElementById('cartFab');
  fab.classList.toggle('is-empty', itemCount === 0);
  document.getElementById('cartBadge').textContent = itemCount;
  document.getElementById('cartFabLabel').textContent = itemCount === 0 ? 'Cart empty' : `${itemCount} ${itemCount === 1 ? 'item' : 'items'}`;
  fab.setAttribute('aria-label', itemCount === 0 ? 'Open empty quotation cart' : `Open quotation cart with ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`);
}

function renderCart() {
  const container = document.getElementById('cartItems');
  if (cart.length === 0) { 
    container.innerHTML = '<div class="empty-state">Add a book to begin your quote.</div>'; 
    document.getElementById('cartSubtotal').innerText = 'Kshs 0.00'; 
    document.getElementById('cartTotal').innerText = 'Kshs 0.00'; 
    document.getElementById('minimumOrderNote').style.display = 'none';
    updateCartFab();
    return; 
  }

  let html = '';
  let subtotal = 0;

  cart.forEach(item => {
    const productionMode = getProductionMode(item);
    const unitPrice = getUnitPrice(item);
    const itemTotal = unitPrice * item.quantity;
    subtotal += itemTotal;

    const priceLabel = item.pricePending
      ? 'Calculating backend price...'
      : `${productionMode === 'mass' ? 'Mass production @' : 'Sample production @'} Kshs. ${unitPrice.toFixed(2)}${item.hasSpecialPrice && productionMode === 'sample' ? ' <span class="custom-price-tag">Special price</span>' : ''}`;
    const massBreakdown = productionMode === 'mass' && item.massCalculation
      ? `<div style="color:var(--muted); font-size:.7rem; margin-top:3px;">Cover Kshs. ${item.massCalculation.coverUnitCost.toFixed(2)} + inserts Kshs. ${item.massCalculation.insertsUnitCost.toFixed(2)} / copy</div>`
      : '';

    html += `
      <div class="cart-item">
        <div>
          <div class="cart-item-title">${escapeHtml(item.title)}</div>
          <div class="price-row" style="color:var(--muted); font-size:.75rem;"><span>${priceLabel}</span></div>
          ${massBreakdown}
          <div class="production-mode" role="group" aria-label="Production mode for ${escapeHtml(item.title)}">
            <button type="button" class="production-mode-button ${productionMode === 'mass' ? 'is-active' : ''}" onclick="setProductionMode(${item.id}, 'mass')">Mass</button>
            <button type="button" class="production-mode-button ${productionMode === 'sample' ? 'is-active' : ''}" onclick="setProductionMode(${item.id}, 'sample')">Sample</button>
          </div>
          
          <select class="size-select" onchange="updateSize(${item.id}, this.value)">
            <option value="1" ${item.selectedSizeCode === "1" ? "selected" : ""}>A5 Size</option>
            <option value="2" ${item.selectedSizeCode === "2" ? "selected" : ""}>A4 Size</option>
            <option value="3" ${item.selectedSizeCode === "3" ? "selected" : ""}>A6 Size</option>
          </select>
        </div>
        <div style="text-align:right;">
          <div class="cart-controls">
            <input type="number" class="qty-input" min="1" value="${item.quantity}" onchange="updateQty(${item.id}, this.value)">
            <button class="remove-btn" onclick="removeFromCart(${item.id})">&times;</button>
          </div>
          <div style="font-weight:700; font-size:.82rem; margin-top:6px;">Kshs. ${itemTotal.toLocaleString('en-US', {minimumFractionDigits:2})}</div>
        </div>
      </div>
    `;
  });

  const discount = getDiscountValue();
  const { total, minimumApplied } = computeOrderTotals(subtotal, discount);

  container.innerHTML = html;
  document.getElementById('cartSubtotal').innerText = 'Kshs ' + subtotal.toLocaleString('en-US', {minimumFractionDigits: 2});
  document.getElementById('cartTotal').innerText = 'Kshs ' + total.toLocaleString('en-US', {minimumFractionDigits: 2});
  const minimumNote = document.getElementById('minimumOrderNote');
  minimumNote.style.display = minimumApplied ? 'block' : 'none';
  minimumNote.textContent = minimumApplied ? `Minimum order amount of Kshs ${MINIMUM_ORDER_AMOUNT.toFixed(2)} applies to this quote.` : '';
  updateCartFab();
}

function printQuotation() {
  if (!cart.length) { alert('Add at least one book to your quote first.'); return; }

  const client = document.getElementById('clientName').value.trim() || 'Valued Client';
  const phone = document.getElementById('clientPhone').value.trim();
  const discount = getDiscountValue();
  const subtotal = cart.reduce((sum, item) => sum + (getUnitPrice(item) * item.quantity), 0);
  const { total, minimumApplied } = computeOrderTotals(subtotal, discount);

  document.getElementById('printQuoteSerial').textContent = `Quote ${quotationNumber}`;
  document.getElementById('printQuoteDate').textContent = `Issued ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  document.getElementById('printQuoteNumber').textContent = quotationNumber;
  document.getElementById('printClientName').textContent = client;
  document.getElementById('printClientPhone').textContent = phone || 'Phone not provided';
  document.getElementById('printQuoteItems').innerHTML = cart.map((item, index) => {
    const unitPrice = getUnitPrice(item);
    const itemTotal = unitPrice * item.quantity;
    const sizeLabel = SIZE_LABELS[String(item.selectedSizeCode)] || 'Standard';
    return `<tr><td>${index + 1}</td><td><div class="print-item-title">${escapeHtml(item.title)}</div><div class="print-item-detail">${sizeLabel} · ${item.pages} pages${item.author ? ` · ${escapeHtml(item.author)}` : ''}</div></td><td>${item.quantity}</td><td>Kshs. ${unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td>Kshs. ${itemTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>`;
  }).join('');
  document.getElementById('printSubtotal').textContent = `Kshs. ${subtotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  document.getElementById('printDiscount').textContent = `Kshs. ${discount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  document.getElementById('printTotal').textContent = `Kshs. ${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  document.getElementById('printMinimumNote').style.display = minimumApplied ? 'flex' : 'none';
  window.print();
}

async function downloadQuotation(format) {
  if (!cart.length) { alert('Add at least one book to your quote first.'); return; }
  printQuotationContent();
  const quote = document.getElementById('printQuote');
  const previousDisplay = quote.style.display;
  const previousPosition = quote.style.position;
  const previousLeft = quote.style.left;
  quote.style.display = 'block';
  quote.style.position = 'absolute';
  quote.style.left = '-10000px';
  quote.classList.add('export-surface');
  try {
    const canvas = await html2canvas(quote, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      onclone: clonedDocument => {
        const clonedLogo = clonedDocument.querySelector('.print-quote-logo');
        const clonedFallback = clonedDocument.querySelector('.print-logo-fallback');
        if (clonedLogo && clonedFallback && (!clonedLogo.complete || !clonedLogo.naturalWidth)) {
          clonedLogo.style.display = 'none';
          clonedFallback.style.display = 'block';
        }
      }
    });
    const safeName = `Cavalry-Quotation-${quotationNumber}`;
    const outputWidth = 794;
    const outputHeight = 1123;
    const horizontalMargin = 48;
    const verticalMargin = 96;
    const innerWidth = outputWidth - (horizontalMargin * 2);
    const innerHeight = outputHeight - (verticalMargin * 2);
    const scale = Math.min(innerWidth / canvas.width, innerHeight / canvas.height);
    const renderedWidth = canvas.width * scale;
    const renderedHeight = canvas.height * scale;
    if (format === 'jpeg') {
      const output = document.createElement('canvas');
      output.width = outputWidth;
      output.height = outputHeight;
      const context = output.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, outputWidth, outputHeight);
      context.drawImage(canvas, horizontalMargin + ((innerWidth - renderedWidth) / 2), verticalMargin, renderedWidth, renderedHeight);
      const link = document.createElement('a');
      link.download = `${safeName}.jpg`;
      link.href = output.toDataURL('image/jpeg', .94);
      link.click();
    } else {
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const horizontalMarginMm = 12.7;
      const verticalMarginMm = 25.4;
      const innerWidthMm = 184.6;
      const innerHeightMm = 246.2;
      const imageWidthMm = Math.min(innerWidthMm, (canvas.width * innerHeightMm) / canvas.height);
      const imageHeightMm = (canvas.height * imageWidthMm) / canvas.width;
      const imageX = horizontalMarginMm + ((innerWidthMm - imageWidthMm) / 2);
      pdf.addImage(canvas.toDataURL('image/jpeg', .95), 'JPEG', imageX, verticalMarginMm, imageWidthMm, imageHeightMm);
      pdf.save(`${safeName}.pdf`);
    }
  } catch (error) {
    console.error('Quotation download failed:', error);
    alert('The quotation could not be downloaded. Please try again.');
  } finally {
    quote.style.display = previousDisplay;
    quote.style.position = previousPosition;
    quote.style.left = previousLeft;
    quote.classList.remove('export-surface');
  }
}

function printQuotationContent() {
  const client = document.getElementById('clientName').value.trim() || 'Valued Client';
  const phone = document.getElementById('clientPhone').value.trim();
  const discount = getDiscountValue();
  const subtotal = cart.reduce((sum, item) => sum + (getUnitPrice(item) * item.quantity), 0);
  const { total, minimumApplied } = computeOrderTotals(subtotal, discount);
  document.getElementById('printQuoteSerial').textContent = `Quote ${quotationNumber}`;
  document.getElementById('printQuoteDate').textContent = `Issued ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  document.getElementById('printQuoteNumber').textContent = quotationNumber;
  document.getElementById('printClientName').textContent = client;
  document.getElementById('printClientPhone').textContent = phone || 'Phone not provided';
  document.getElementById('printQuoteItems').innerHTML = cart.map((item, index) => {
    const unitPrice = getUnitPrice(item);
    const itemTotal = unitPrice * item.quantity;
    const sizeLabel = SIZE_LABELS[String(item.selectedSizeCode)] || 'Standard';
    return `<tr><td>${index + 1}</td><td><div class="print-item-title">${escapeHtml(item.title)}</div><div class="print-item-detail">${sizeLabel} · ${item.pages} pages${item.author ? ` · ${escapeHtml(item.author)}` : ''}</div></td><td>${item.quantity}</td><td>Kshs. ${unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td>Kshs. ${itemTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>`;
  }).join('');
  document.getElementById('printSubtotal').textContent = `Kshs. ${subtotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  document.getElementById('printDiscount').textContent = `Kshs. ${discount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  document.getElementById('printTotal').textContent = `Kshs. ${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  document.getElementById('printMinimumNote').style.display = minimumApplied ? 'flex' : 'none';
}

function shareOnWhatsApp() {
  if (!cart.length) { alert('Add at least one book to your quote first.'); return; }
  
  const client = document.getElementById('clientName').value.trim() || 'Valued Client';
  const phoneInput = document.getElementById('clientPhone').value.trim();
  const discount = getDiscountValue();
  
  const subtotal = cart.reduce((sum, item) => sum + (getUnitPrice(item) * item.quantity), 0);
  const { total: finalTotal, minimumApplied } = computeOrderTotals(subtotal, discount);

  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  // Format book list
  const itemBlocks = cart.map((item, index) => {
    const sizeLabel = SIZE_LABELS[String(item.selectedSizeCode)] || "Standard";
    const unitPrice = getUnitPrice(item);
    const lineTotal = unitPrice * item.quantity;
    return `(${index + 1}). ${item.quantity} copies of "${item.title}"\n` +
           `     ${sizeLabel} | @ Kshs. ${unitPrice.toFixed(2)}\n` +
           `     Total: Kshs. ${lineTotal.toLocaleString('en-US', {minimumFractionDigits: 2})}`;
  });

  // Short summary for Google Sheet logging
  const itemsSummary = cart.map(i => `${i.quantity}x ${i.title} (${SIZE_LABELS[String(i.selectedSizeCode)] || 'Standard'})`).join('; ');

  // 1. Silent Background Call to Apps Script to save in 'quotes_log'
  fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "log_quote",
      clientName: client,
      clientPhone: phoneInput,
      itemsSummary: itemsSummary,
      subtotal: subtotal,
      discount: discount,
      total: finalTotal,
      quotationNumber: quotationNumber
    })
  });

  // 2. Open WhatsApp link
  const message = 
`*CAVALRY PUBLISHERS*
Quotation: ${quotationNumber}
Date: ${today}

Hello ${client}, Thank you for your enquiry.
Find your quotation below:

${itemBlocks.join('\n\n')}

----------------------------------
Subtotal: Kshs. ${subtotal.toLocaleString('en-US', {minimumFractionDigits: 2})}
Discount: Kshs. ${discount.toLocaleString('en-US', {minimumFractionDigits: 2})}${minimumApplied ? `\nMinimum order amount of Kshs. ${MINIMUM_ORDER_AMOUNT.toFixed(2)} applied` : ''}
*TOTAL QUOTATION: Kshs. ${finalTotal.toLocaleString('en-US', {minimumFractionDigits: 2})}*
----------------------------------

*NOTE:*
- PRODUCTION BEGINS AFTER RECEIPT OF PAYMENT
- DELIVERY WITHIN 2 WORKING DAYS

*Payment Till No: 5675635*`;

  let targetPhone = COMPANY_WHATSAPP;
  if (phoneInput) {
    let digits = phoneInput.replace(/\D/g, '');
    if (digits.startsWith('0')) digits = '254' + digits.substring(1);
    if (digits.length >= 10) targetPhone = digits;
  }

  window.open(`https://wa.me/${targetPhone}?text=${encodeURIComponent(message)}`, '_blank');
}

function openCustomModal() {
  const modal = document.getElementById('customModal');
  modal.style.display = 'flex';
  document.getElementById('customTitle').focus();
}

function closeCustomModal() { document.getElementById('customModal').style.display = 'none'; }

document.getElementById('customModal').addEventListener('click', event => {
  if (event.target.id === 'customModal') closeCustomModal();
});
document.getElementById('staffLoginModal').addEventListener('click', event => {
  if (event.target.id === 'staffLoginModal') closeStaffLoginModal();
});
document.getElementById('checkoutModal').addEventListener('click', event => {
  if (event.target.id === 'checkoutModal') closeCheckoutModal();
});
document.getElementById('documentPreviewModal').addEventListener('click', event => {
  if (event.target.id === 'documentPreviewModal') closeDocumentPreview();
});
document.getElementById('bookDetailModal').addEventListener('click', event => {
  if (event.target.id === 'bookDetailModal') closeBookDetails();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeCustomModal();
  if (event.key === 'Escape') closeStaffLoginModal();
  if (event.key === 'Escape') closeCheckoutModal();
  if (event.key === 'Escape') closeDocumentPreview();
  if (event.key === 'Escape') closeCart();
  if (event.key === 'Escape') closeBookDetails();
});

async function handlePdfUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (!document.getElementById('customTitle').value) {
    document.getElementById('customTitle').value = file.name.replace(/\.pdf$/i, '');
  }
  const pagesField = document.getElementById('customPages');
  pagesField.value = '';
  pagesField.placeholder = 'Reading PDF...';
  try {
    if (!window.pdfjsLib) throw new Error('PDF reader library is unavailable.');
    const fileData = new Uint8Array(await file.arrayBuffer());
    const loadingTask = pdfjsLib.getDocument({ data: fileData });
    const pdf = await loadingTask.promise;
    pagesField.value = pdf.numPages;
    pagesField.placeholder = '';
  } catch (error) {
    console.error('PDF page detection failed:', error);
    pagesField.placeholder = 'Enter pages manually';
    alert('The PDF pages could not be detected. Please enter the total pages manually.');
  }
}

function submitCustomBook() {
  const payload = {
    title: document.getElementById('customTitle').value.trim(),
    author: document.getElementById('customAuthor').value.trim(),
    pages: parseInt(document.getElementById('customPages').value, 10),
    colorPages: parseInt(document.getElementById('customColorPages').value, 10) || 0,
    sizeCode: document.getElementById('customSize').value
  };

  if (!payload.title || !payload.pages) {
    alert("Please enter both Title and Total Pages.");
    return;
  }

  fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .then(res => {
    if (res.status === "success") {
      catalog.push(res.book);
      displayBooks(catalog);
      addToCart(res.book.id);
      closeCustomModal();
    } else if (res.status === "exists") {
      alert("This book is already in your catalogue! Adding existing title to your quote.");
      const existing = catalog.find(b => b.title.toLowerCase() === payload.title.toLowerCase());
      if (existing) addToCart(existing.id);
      closeCustomModal();
    }
  });
}

function escapeHtml(str) { return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      console.log('SW registered:', reg.scope);
    } catch (error) {
      console.warn('Service worker registration failed:', error);
    }
  });
}
