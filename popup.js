const { PDFDocument, rgb, StandardFonts } = PDFLib;

const statusLog = document.getElementById('statusLog');
const btnScan = document.getElementById('btnScan');
const btnMerge = document.getElementById('btnMerge');
const labelCountEl = document.getElementById('labelCount');
const profileNameInput = document.getElementById('profileName');
const savedMsg = document.getElementById('savedMsg');

function log(msg, type = '') {
  const div = document.createElement('div');
  div.className = 'status-line ' + type;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  statusLog.prepend(div);
}

chrome.storage.local.get(['profileName', 'collectedLabels'], (data) => {
  if (data.profileName) {
    profileNameInput.value = data.profileName;
  }
  updateLabelCount(data.collectedLabels);
});

profileNameInput.addEventListener('change', () => {
  chrome.storage.local.set({ profileName: profileNameInput.value });
  savedMsg.style.display = 'block';
  setTimeout(() => { savedMsg.style.display = 'none'; }, 2000);
});

function updateLabelCount(labels) {
  const today = new Date().toISOString().split('T')[0];
  const todayLabels = (labels || []).filter(l => l.date === today);
  labelCountEl.textContent = todayLabels.length;
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function extractSku(title) {
  if (!title) return null;
  const cleaned = title.trim();
  const parts = cleaned.split(/[\s\-_#]+/);
  const lastPart = parts[parts.length - 1];
  if (/^[A-Za-z]\d{1,3}$/.test(lastPart)) {
    return lastPart.toUpperCase();
  }
  const match = cleaned.match(/[#]?\s*([A-Za-z]\d{1,3})\s*$/);
  if (match) return match[1].toUpperCase();
  const lastChars = cleaned.slice(-4).trim();
  if (/^[A-Za-z]\d{1,3}$/.test(lastChars)) {
    return lastChars.toUpperCase();
  }
  return null;
}

async function fetchVintedApi(path) {
  const resp = await fetch(`https://www.vinted.pl/api/v2${path}`, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    }
  });
  if (!resp.ok) throw new Error(`API ${path} returned ${resp.status}`);
  return resp.json();
}

async function fetchCsrfToken() {
  try {
    const resp = await fetch('https://www.vinted.pl/api/v2/users/current', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    const csrfToken = resp.headers.get('x-csrf-token');
    return csrfToken;
  } catch {
    return null;
  }
}

async function addSkuToPdf(pdfBytes, skuCode) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();

  for (const page of pages) {
    const { width, height } = page.getSize();
    const fontSize = 14;
    const textWidth = font.widthOfTextAtSize(skuCode, fontSize);
    const margin = 10;

    page.drawRectangle({
      x: width - textWidth - margin - 6,
      y: margin - 2,
      width: textWidth + 12,
      height: fontSize + 8,
      color: rgb(1, 1, 1),
    });

    page.drawText(skuCode, {
      x: width - textWidth - margin,
      y: margin + 2,
      size: fontSize,
      font: font,
      color: rgb(0, 0, 0),
    });
  }

  return pdfDoc.save();
}

async function scanLabels() {
  btnScan.disabled = true;
  btnScan.textContent = 'Scanning...';
  log('Starting label scan...', 'info');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.includes('vinted.pl')) {
      log('Please open vinted.pl first, then try again.', 'error');
      btnScan.disabled = false;
      btnScan.textContent = 'Scan & Download Today\'s Labels';
      return;
    }

    log('Fetching your sold items from Vinted...', 'info');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fetchSoldItemsFromPage,
    });

    const orders = results[0]?.result;

    if (!orders || orders.length === 0) {
      log('No sold items with labels found for today.', 'info');
      btnScan.disabled = false;
      btnScan.textContent = 'Scan & Download Today\'s Labels';
      return;
    }

    log(`Found ${orders.length} order(s) to process.`, 'success');
    const today = getTodayStr();
    const profileName = profileNameInput.value || 'default';
    let processed = 0;

    const existingData = await chrome.storage.local.get('collectedLabels');
    const allLabels = existingData.collectedLabels || [];

    for (const order of orders) {
      try {
        const sku = extractSku(order.title);
        if (!sku) {
          log(`Could not extract SKU from: "${order.title}"`, 'error');
          continue;
        }

        log(`Processing: ${order.title} (SKU: ${sku})`, 'info');

        const labelResp = await fetch(order.labelUrl, { credentials: 'include' });
        if (!labelResp.ok) {
          log(`Failed to download label for ${sku}: HTTP ${labelResp.status}`, 'error');
          continue;
        }

        const pdfBytes = await labelResp.arrayBuffer();
        const modifiedPdf = await addSkuToPdf(new Uint8Array(pdfBytes), sku);

        const base64 = btoa(String.fromCharCode(...new Uint8Array(modifiedPdf)));

        allLabels.push({
          sku,
          title: order.title,
          profile: profileName,
          date: today,
          pdfBase64: base64,
          transactionId: order.transactionId,
          timestamp: Date.now()
        });

        const filename = `VintedLabels/${today}/${profileName}_${sku}_${order.transactionId}.pdf`;
        const blob = new Blob([modifiedPdf], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);

        await chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: false
        });

        processed++;
        log(`Label saved: ${sku} (${profileName})`, 'success');
      } catch (err) {
        log(`Error processing order: ${err.message}`, 'error');
      }
    }

    await chrome.storage.local.set({ collectedLabels: allLabels });
    updateLabelCount(allLabels);
    log(`Done! ${processed} label(s) processed and saved.`, 'success');

  } catch (err) {
    log(`Scan error: ${err.message}`, 'error');
  }

  btnScan.disabled = false;
  btnScan.textContent = 'Scan & Download Today\'s Labels';
}

function fetchSoldItemsFromPage() {
  return new Promise(async (resolve) => {
    try {
      const orders = [];

      const resp = await fetch('https://www.vinted.pl/api/v2/my_orders/sold?page=1&per_page=50', {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });

      if (!resp.ok) {
        const altResp = await fetch('https://www.vinted.pl/api/v2/transactions?type=sold&page=1&per_page=50', {
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });
        if (!altResp.ok) {
          resolve([]);
          return;
        }
        const altData = await altResp.json();
        processTransactions(altData, orders);
        resolve(orders);
        return;
      }

      const data = await resp.json();
      processTransactions(data, orders);
      resolve(orders);
    } catch (err) {
      console.error('Vinted scan error:', err);
      resolve([]);
    }
  });

  function processTransactions(data, orders) {
    const today = new Date().toISOString().split('T')[0];
    const items = data.my_orders || data.transactions || data.items || [];

    for (const item of items) {
      const transaction = item.transaction || item;
      const createdAt = transaction.created_at || transaction.date || '';
      const status = (transaction.status || item.status || '').toLowerCase();

      const isRecent = createdAt.startsWith(today) ||
        ['sold', 'shipped', 'label_ready', 'shipping_label_ready', 'debit_processed'].some(s => status.includes(s));

      if (!isRecent) continue;

      const title = transaction.item?.title || item.item?.title || item.title || '';
      const transactionId = transaction.id || item.id || '';

      if (!title || !transactionId) continue;

      const labelUrl = `https://www.vinted.pl/api/v2/transactions/${transactionId}/shipment/label`;

      orders.push({
        title,
        transactionId: String(transactionId),
        labelUrl,
        status: status
      });
    }
  }
}

async function mergeLabels() {
  btnMerge.disabled = true;
  btnMerge.textContent = 'Merging...';
  log('Starting merge...', 'info');

  try {
    const data = await chrome.storage.local.get('collectedLabels');
    const today = getTodayStr();
    const todayLabels = (data.collectedLabels || []).filter(l => l.date === today);

    if (todayLabels.length === 0) {
      log('No labels collected today to merge.', 'error');
      btnMerge.disabled = false;
      btnMerge.textContent = 'Merge All Labels into PDF';
      return;
    }

    log(`Merging ${todayLabels.length} label(s)...`, 'info');

    const mergedPdf = await PDFDocument.create();

    for (const label of todayLabels) {
      try {
        const binaryStr = atob(label.pdfBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }

        const srcDoc = await PDFDocument.load(bytes);
        const pages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
      } catch (err) {
        log(`Error adding label ${label.sku}: ${err.message}`, 'error');
      }
    }

    const mergedBytes = await mergedPdf.save();
    const blob = new Blob([mergedBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    const filename = `VintedLabels/MERGED_${today}_${todayLabels.length}labels.pdf`;

    await chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false
    });

    log(`Merged PDF saved: ${filename}`, 'success');
    log(`Contains ${todayLabels.length} labels from profiles: ${[...new Set(todayLabels.map(l => l.profile))].join(', ')}`, 'info');

  } catch (err) {
    log(`Merge error: ${err.message}`, 'error');
  }

  btnMerge.disabled = false;
  btnMerge.textContent = 'Merge All Labels into PDF';
}

btnScan.addEventListener('click', scanLabels);
btnMerge.addEventListener('click', mergeLabels);

document.getElementById('btnMergePage').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/merge.html') });
});
