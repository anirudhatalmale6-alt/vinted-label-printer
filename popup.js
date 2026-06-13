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
  const time = new Date().toLocaleTimeString();
  div.textContent = `[${time}] ${msg}`;
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

  // Try #CODE pattern first
  const hashMatch = cleaned.match(/#\s*([A-Za-z0-9]{2,4})\s*$/);
  if (hashMatch) return hashMatch[1].toUpperCase();

  // Split by spaces and get last token
  const parts = cleaned.split(/\s+/);
  const lastPart = parts[parts.length - 1];

  // Match letter(s) + digits pattern: A39, V19, M100, N94, U10
  if (/^[A-Za-z]{1,2}\d{1,3}$/.test(lastPart)) {
    return lastPart.toUpperCase();
  }

  // Try second-to-last if last didn't match (in case of trailing whitespace/chars)
  if (parts.length >= 2) {
    const secondLast = parts[parts.length - 2];
    if (/^[A-Za-z]{1,2}\d{1,3}$/.test(secondLast)) {
      return secondLast.toUpperCase();
    }
  }

  // Fallback: find any letter+digits pattern at end of string
  const fallback = cleaned.match(/([A-Za-z]{1,2}\d{1,3})\s*$/);
  if (fallback) return fallback[1].toUpperCase();

  return null;
}

async function getActiveVintedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.includes('vinted.pl')) {
    return tab;
  }
  // Try to find any vinted.pl tab in current window
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const vintedTab = tabs.find(t => t.url && t.url.includes('vinted.pl'));
  return vintedTab || null;
}

async function ensureContentScript(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => typeof getCsrfToken !== 'undefined'
    });
    if (results[0]?.result) return true;
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    return true;
  } catch (err) {
    log(`Cannot inject script: ${err.message}`, 'error');
    return false;
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

    // White background rectangle
    page.drawRectangle({
      x: width - textWidth - margin - 6,
      y: margin - 2,
      width: textWidth + 12,
      height: fontSize + 8,
      color: rgb(1, 1, 1),
    });

    // SKU text in bold black
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
    const tab = await getActiveVintedTab();
    if (!tab) {
      log('Please open vinted.pl in a tab first!', 'error');
      btnScan.disabled = false;
      btnScan.textContent = 'Scan & Download Today\'s Labels';
      return;
    }

    log(`Using tab: ${tab.url}`, 'info');

    const injected = await ensureContentScript(tab.id);
    if (!injected) {
      log('Could not inject content script. Try refreshing vinted.pl page.', 'error');
      btnScan.disabled = false;
      btnScan.textContent = 'Scan & Download Today\'s Labels';
      return;
    }

    // Use content script to fetch orders (runs in page context with cookies)
    log('Fetching sold orders from Vinted API...', 'info');

    const orderResult = await chrome.tabs.sendMessage(tab.id, { action: 'getSoldOrders' });

    if (!orderResult || orderResult.error) {
      log(`Error fetching orders: ${orderResult?.error || 'No response from content script'}`, 'error');
      log('Try the Diagnose button below to find the issue.', 'info');
      btnScan.disabled = false;
      btnScan.textContent = 'Scan & Download Today\'s Labels';
      return;
    }

    const orders = orderResult.orders || [];
    if (orders.length === 0) {
      log('No sold items found. Try the Diagnose button to check API access.', 'info');
      btnScan.disabled = false;
      btnScan.textContent = 'Scan & Download Today\'s Labels';
      return;
    }

    log(`Found ${orders.length} order(s). Processing labels...`, 'success');

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

        log(`Processing: "${order.title}" -> SKU: ${sku}`, 'info');

        // Download label via content script (uses page cookies)
        const labelResult = await chrome.tabs.sendMessage(tab.id, {
          action: 'downloadLabel',
          transactionId: order.transactionId
        });

        if (!labelResult || labelResult.error) {
          log(`Label download failed for ${sku}: ${labelResult?.error || 'unknown error'}`, 'error');
          continue;
        }

        // Decode base64 PDF
        const binaryStr = atob(labelResult.pdfBase64);
        const pdfBytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          pdfBytes[i] = binaryStr.charCodeAt(i);
        }

        // Add SKU to PDF
        const modifiedPdf = await addSkuToPdf(pdfBytes, sku);

        // Store in extension storage
        const base64Modified = btoa(String.fromCharCode(...new Uint8Array(modifiedPdf)));
        allLabels.push({
          sku,
          title: order.title,
          profile: profileName,
          date: today,
          pdfBase64: base64Modified,
          transactionId: order.transactionId,
          timestamp: Date.now()
        });

        // Also save as individual file
        const blob = new Blob([modifiedPdf], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const filename = `VintedLabels/${today}/${profileName}_${sku}_${order.transactionId}.pdf`;

        await chrome.downloads.download({ url, filename, saveAs: false });

        processed++;
        log(`Saved: ${sku} (${profileName})`, 'success');
      } catch (err) {
        log(`Error: ${err.message}`, 'error');
      }
    }

    await chrome.storage.local.set({ collectedLabels: allLabels });
    updateLabelCount(allLabels);
    log(`Done! ${processed}/${orders.length} labels processed.`, 'success');

  } catch (err) {
    log(`Scan error: ${err.message}`, 'error');
  }

  btnScan.disabled = false;
  btnScan.textContent = 'Scan & Download Today\'s Labels';
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

    await chrome.downloads.download({ url, filename, saveAs: false });

    log(`Merged PDF saved: ${filename}`, 'success');
    const profiles = [...new Set(todayLabels.map(l => l.profile))].join(', ');
    log(`Contains ${todayLabels.length} labels from: ${profiles}`, 'info');

  } catch (err) {
    log(`Merge error: ${err.message}`, 'error');
  }

  btnMerge.disabled = false;
  btnMerge.textContent = 'Merge All Labels into PDF';
}

async function runDiagnostics() {
  const btnDiag = document.getElementById('btnDiagnose');
  btnDiag.disabled = true;
  btnDiag.textContent = 'Diagnosing...';
  log('Running diagnostics...', 'info');

  try {
    const tab = await getActiveVintedTab();
    if (!tab) {
      log('No vinted.pl tab found! Open vinted.pl first.', 'error');
      btnDiag.disabled = false;
      btnDiag.textContent = 'Diagnose Connection';
      return;
    }

    await ensureContentScript(tab.id);
    const results = await chrome.tabs.sendMessage(tab.id, { action: 'diagnose' });

    if (!results) {
      log('No response from content script. Try refreshing vinted.pl.', 'error');
      btnDiag.disabled = false;
      btnDiag.textContent = 'Diagnose Connection';
      return;
    }

    log('=== DIAGNOSTIC RESULTS ===', 'info');
    for (const r of results) {
      if (r.check === 'CSRF Token') {
        log(`CSRF Token: ${r.value}`, r.value === 'NOT FOUND' ? 'error' : 'success');
      } else if (r.check === 'Current URL') {
        log(`Page URL: ${r.value}`, 'info');
      } else if (r.check && r.check.startsWith('API:')) {
        const status = r.ok ? 'success' : 'error';
        let detail = `${r.check} -> HTTP ${r.status}`;
        if (r.ok && r.responseKeys) {
          detail += ` | Keys: ${r.responseKeys.join(', ')}`;
          for (const key of r.responseKeys) {
            if (r[`${key}_count`] !== undefined) {
              detail += ` | ${key}: ${r[`${key}_count`]} items`;
            }
            if (r[`${key}_first_keys`]) {
              detail += ` | Fields: ${r[`${key}_first_keys`].slice(0, 8).join(', ')}`;
            }
          }
        }
        if (r.error) detail += ` | Error: ${r.error}`;
        log(detail, status);
      } else if (r.check === 'Page scrape') {
        log(`Page links: ${r.orderLinksCount} order links, ${r.transactionLinksCount} shipment links`, 'info');
      }
    }
    log('=== END DIAGNOSTICS ===', 'info');
    log('Please screenshot this log and send it to me!', 'info');

  } catch (err) {
    log(`Diagnostic error: ${err.message}`, 'error');
  }

  btnDiag.disabled = false;
  btnDiag.textContent = 'Diagnose Connection';
}

btnScan.addEventListener('click', scanLabels);
btnMerge.addEventListener('click', mergeLabels);

document.getElementById('btnMergePage').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/merge.html') });
});

document.getElementById('btnDiagnose').addEventListener('click', runDiagnostics);
