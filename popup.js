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

async function getLabelFromConversation(order) {
  const convUrl = `https://www.vinted.pl/inbox/${order.conversationId}`;

  return new Promise(async (resolve) => {
    let convTab = null;
    let resolved = false;

    const cleanup = () => {
      if (convTab) {
        chrome.tabs.remove(convTab.id).catch(() => {});
      }
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({ error: 'Timeout loading conversation page' });
      }
    }, 30000);

    try {
      // Create tab in background
      convTab = await chrome.tabs.create({ url: convUrl, active: false });

      // Wait for tab to finish loading
      const waitForLoad = () => new Promise((res) => {
        const listener = (tabId, changeInfo) => {
          if (tabId === convTab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            res();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      await waitForLoad();

      // Wait extra time for RSC data to stream in
      await new Promise(r => setTimeout(r, 4000));

      // Search for S3 URL in the loaded page
      const results = await chrome.scripting.executeScript({
        target: { tabId: convTab.id },
        func: () => {
          const html = document.documentElement.outerHTML;
          const patterns = [
            /https?:\/\/svc-shipping-labels\.s3[^\s"'<>)}\]\\]+/g,
            /svc-shipping-labels\.s3\.eu-central-1\.amazonaws\.com\/[^\s"'<>)}\]\\]+/g,
          ];

          for (const pat of patterns) {
            const matches = html.match(pat);
            if (matches) {
              let url = matches[0];
              if (!url.startsWith('http')) url = 'https://' + url;
              // Decode various escape formats
              url = url.replace(/\\u0026/g, '&').replace(/\\u003d/g, '=')
                       .replace(/\\\//g, '/').replace(/&amp;/g, '&');
              return { found: true, url };
            }
          }

          // Search all script text content
          const scripts = document.querySelectorAll('script');
          for (const s of scripts) {
            const text = s.textContent || '';
            if (text.includes('svc-shipping-labels') || text.includes('shipping-labels.s3')) {
              // Extract with wider character class to get full URL including query params
              const match = text.match(/svc-shipping-labels\.s3[^"'\\})\]\s]+/);
              if (match) {
                let url = 'https://' + match[0];
                url = url.replace(/\\u0026/g, '&').replace(/\\u003d/g, '=')
                         .replace(/\\\//g, '/');
                return { found: true, url, source: 'script' };
              }
            }
          }

          return { found: false, length: html.length };
        }
      });

      const searchResult = results[0]?.result;

      if (searchResult && searchResult.found && searchResult.url) {
        log(`Found S3 URL for label!`, 'success');

        // Download the PDF from S3
        const pdfResp = await fetch(searchResult.url);
        if (pdfResp.ok) {
          const blob = await pdfResp.blob();
          if (blob.size > 100) {
            const reader = new FileReader();
            const base64 = await new Promise((res) => {
              reader.onload = () => res(reader.result.split(',')[1]);
              reader.readAsDataURL(blob);
            });

            clearTimeout(timeout);
            resolved = true;
            cleanup();
            resolve({ pdfBase64: base64 });
            return;
          }
        }
        clearTimeout(timeout);
        resolved = true;
        cleanup();
        resolve({ error: 'Found S3 URL but could not download PDF' });
      } else {
        clearTimeout(timeout);
        resolved = true;
        cleanup();
        resolve({ error: `S3 URL not found in conversation page (${searchResult?.length || 0} chars scanned)` });
      }
    } catch (err) {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({ error: `Tab error: ${err.message}` });
      }
    }
  });
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

        // Open the conversation page to extract S3 label URL
        log(`Opening conversation page for ${sku}...`, 'info');
        const labelResult = await getLabelFromConversation(order);

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
      log(r.msg, r.type || 'info');
    }
    log('=== END DIAGNOSTICS ===', 'info');
    log('Please copy ALL text from this log and send it to me!', 'info');

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

// Show captured requests from background service worker
document.getElementById('btnShowCaptured').addEventListener('click', async () => {
  log('Fetching captured requests from background monitor...', 'info');

  chrome.runtime.sendMessage({ action: 'getCapturedFromBg' }, (data) => {
    const requests = data?.capturedRequests || [];
    const foundUrl = data?.foundLabelUrl;
    const capturedLabels = data?.capturedLabels || [];

    if (capturedLabels.length > 0) {
      log(`CAPTURED ${capturedLabels.length} PDF BLOB(s)! Labels are ready!`, 'success');
      for (const cl of capturedLabels) {
        log(`  PDF: ${cl.blobType}, ${cl.blobSize} bytes, from ${cl.pageUrl}`, 'success');
      }
    }

    if (foundUrl) {
      log(`Found PDF URL: ${foundUrl}`, 'success');
    }

    log(`=== CAPTURED REQUESTS (${requests.length}) ===`, 'info');
    for (const r of requests) {
      let detail = `[${r.source}] `;

      if (r.source === 'blob-capture') {
        detail += `BLOB: ${r.blobType} (${r.blobSize} bytes) hasData=${r.hasData} from ${r.pageUrl}`;
        log(detail, 'success');
      } else if (r.source === 'window-open') {
        detail += `window.open("${r.url}") from ${r.pageUrl}`;
        log(detail, 'success');
      } else if (r.source === 'link-click') {
        detail += `link click: ${r.href} download="${r.download}"`;
        log(detail, 'success');
      } else if (r.source === 'tab-update') {
        detail += `Tab URL: ${r.url}`;
        log(detail, 'success');
      } else if (r.source === 'download') {
        detail += `Download: ${r.url} (${r.mime}) ${r.filename}`;
        log(detail, r.mime?.includes('pdf') ? 'success' : 'info');
      } else {
        detail += `${r.method || 'GET'} ${r.url} -> ${r.status} (${r.contentType || ''})`;
        if (r.isPdf) detail += ' [PDF!]';
        log(detail, r.isPdf ? 'success' : 'info');
      }
    }
    log('=== END CAPTURED ===', 'info');
    log('Copy this and send it to me!', 'info');
  });
});

document.getElementById('btnClearCaptured').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'clearCaptured' }, () => {
    log('Captured data cleared.', 'info');
  });
});

// Check if a PDF was already found
chrome.storage.local.get('foundLabelUrl', (data) => {
  if (data.foundLabelUrl) {
    log(`Previously found label URL: ${data.foundLabelUrl}`, 'success');
  }
});
