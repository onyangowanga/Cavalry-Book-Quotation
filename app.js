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

window.addEventListener('load', () => { loadCatalog(); updateStaffUI(); });

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
  input.value = '';
  input.focus();
}

function closeStaffLoginModal() { document.getElementById('staffLoginModal').style.display = 'none'; }

async function submitStaffLogin() {
  const input = document.getElementById('staffPasswordInput');
  const password = input.value;
  if (!password) {
    alert('Please enter the staff password.');
    input.focus();
    return;
  }
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
  const discountRow = document.getElementById('discountRow');
  if (loginButton) loginButton.style.display = isStaff ? 'none' : 'inline-flex';
  if (logoutButton) logoutButton.style.display = isStaff ? 'inline-flex' : 'none';
  if (discountRow) discountRow.style.display = isStaff ? 'block' : 'none';
  if (!isStaff) document.getElementById('discountInput').value = 0;
  if (rawCatalog.length) {
    const query = document.getElementById('searchInput').value.toLowerCase().trim();
    displayBooks(query ? catalog.filter(b => `${b.title} ${b.author}`.toLowerCase().includes(query)) : catalog);
  }
  renderCart();
}

function getDiscountValue() {
  if (!isStaff) return 0;
  return Math.max(0, parseFloat(document.getElementById('discountInput').value) || 0);
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
  return Number(item.activeUnitCost);
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
    const unitPrice = getUnitPrice(item);
    const itemTotal = unitPrice * item.quantity;
    subtotal += itemTotal;

    const priceLabel = item.pricePending
      ? 'Calculating backend price...'
      : `@ Kshs. ${unitPrice.toFixed(2)}${item.hasSpecialPrice ? ' <span class="custom-price-tag">Special price</span>' : ''}`;

    html += `
      <div class="cart-item">
        <div>
          <div class="cart-item-title">${escapeHtml(item.title)}</div>
          <div class="price-row" style="color:var(--muted); font-size:.75rem;"><span>${priceLabel}</span></div>
          
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
document.getElementById('bookDetailModal').addEventListener('click', event => {
  if (event.target.id === 'bookDetailModal') closeBookDetails();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeCustomModal();
  if (event.key === 'Escape') closeStaffLoginModal();
  if (event.key === 'Escape') closeCart();
  if (event.key === 'Escape') closeBookDetails();
});

function handlePdfUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (!document.getElementById('customTitle').value) {
    document.getElementById('customTitle').value = file.name.replace('.pdf', '');
  }
  const reader = new FileReader();
  reader.onload = function() {
    const typedarray = new Uint8Array(this.result);
    pdfjsLib.getDocument(typedarray).promise.then(pdf => {
      document.getElementById('customPages').value = pdf.numPages;
    });
  };
  reader.readAsArrayBuffer(file);
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
