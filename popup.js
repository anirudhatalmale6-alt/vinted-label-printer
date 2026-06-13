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

  const hashMatch = cleaned.match(/#\s*([A-Za-z0-9]{2,4})\s*$/);
  if (hashMatch) return hashMatch[1].toUpperCase();

  const parts = cleaned.split(/\s+/);
  const lastPart = parts[parts.length - 1];

  if (/^[A-Za-z]{1,2}\d{1,3}$/.test(lastPart)) {
    return lastPart.toUpperCase();
  }

  if (parts.length >= 2) {
    const secondLast = parts[parts.length - 2];
    if (/^[A-Za-z]{1,2}\d{1,3}$/.test(secondLast)) {
      return secondLast.toUpperCase();
    }
  }

  const fallback = cleaned.match(/([A-Za-z]{1,2}\d{1,3})\s*$/);
  if (fallback) return fallback[1].toUpperCase();

  return null;
}

async function getActiveVintedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.includes('vinted.pl')) {
    return tab;
  }
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const vintedTab = tabs.find(t => t.url && t.url.includes('vinted.pl'));
  return vintedTab || null;
}

async function ensureContentScript(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => true
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

async function getLabelFromConversation(order) {
  const convUrl = `https://www.vinted.pl/inbox/${order.conversationId}`;

  return new Promise(async (resolve) => {
    let convTab = null;
    let resolved = false;

    const cleanup = () => {
      if (convTab) chrome.tabs.remove(convTab.id).catch(() => {});
    };

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      cleanup();
      resolve(result);
    };

    const timeout = setTimeout(() => done({ error: 'Timeout (45s)' }), 45000);

    try {
      convTab = await chrome.tabs.create({ url: convUrl, active: false });

      // Wait for tab to finish loading
      await new Promise((res) => {
        const listener = (tabId, changeInfo) => {
          if (tabId === convTab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            res();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      // Wait for page to fully render (RSC streaming)
      await new Promise(r => setTimeout(r, 5000));

      // Click the "Wydrukuj etykietę wysyłkową" button and capture the S3 URL
      const results = await chrome.scripting.executeScript({
        target: { tabId: convTab.id },
        func: () => {
          return new Promise((resolve) => {
            // Override window.open to capture URL without opening a new tab
            const origOpen = window.open;
            let capturedUrl = null;

            window.open = function(url) {
              capturedUrl = String(url || '');
              return null;
            };

            // Find the label button - "Wydrukuj etykietę wysyłkową"
            const allElements = document.querySelectorAll('button, a, [role="button"], span, div');
            let labelButton = null;

            const buttonTexts = [
              'wydrukuj etykiet',
              'etykiet',
              'print label',
              'shipping label',
              'download label',
              'pobierz etykiet'
            ];

            for (const el of allElements) {
              const text = (el.textContent || '').toLowerCase().trim();
              for (const bt of buttonTexts) {
                if (text.includes(bt) && el.tagName !== 'BODY' && el.tagName !== 'HTML' && el.tagName !== 'MAIN') {
                  // Prefer actual buttons/links
                  if (el.tagName === 'BUTTON' || el.tagName === 'A') {
                    labelButton = el;
                    break;
                  }
                  // Or clickable elements
                  if (!labelButton && (el.onclick || el.getAttribute('role') === 'button' ||
                      el.closest('button') || el.closest('a'))) {
                    labelButton = el.closest('button') || el.closest('a') || el;
                  }
                }
              }
              if (labelButton && (labelButton.tagName === 'BUTTON' || labelButton.tagName === 'A')) break;
            }

            if (!labelButton) {
              window.open = origOpen;
              // Return all button texts for debugging
              const btnTexts = [];
              document.querySelectorAll('button').forEach(b => {
                btnTexts.push(b.textContent.trim().substring(0, 80));
              });
              resolve({
                found: false,
                error: 'Button not found. Buttons on page: ' + btnTexts.join(' | ')
              });
              return;
            }

            // Click it
            labelButton.click();

            // Wait for window.open to fire
            let checks = 0;
            const interval = setInterval(() => {
              checks++;
              if (capturedUrl) {
                clearInterval(interval);
                window.open = origOpen;
                resolve({ found: true, url: capturedUrl });
              } else if (checks > 50) {
                clearInterval(interval);
                window.open = origOpen;
                resolve({
                  found: false,
                  error: 'Clicked button but no URL captured after 5s. Button text: "' +
                    labelButton.textContent.trim().substring(0, 50) + '"'
                });
              }
            }, 100);
          });
        }
      });

      const searchResult = results[0]?.result;

      if (searchResult && searchResult.found && searchResult.url) {
        log(`Captured S3 URL!`, 'success');

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
            done({ pdfBase64: base64 });
            return;
          }
        }
        done({ error: 'Got S3 URL but PDF download failed' });
      } else {
        done({ error: searchResult?.error || 'Could not extract label URL' });
      }
    } catch (err) {
      done({ error: `Tab error: ${err.message}` });
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
    await ensureContentScript(tab.id);

    log('Fetching sold orders from Vinted API...', 'info');
    const orderResult = await chrome.tabs.sendMessage(tab.id, { action: 'getSoldOrders' });

    if (!orderResult || orderResult.error) {
      log(`Error: ${orderResult?.error || 'No response'}`, 'error');
      btnScan.disabled = false;
      btnScan.textContent = 'Scan & Download Today\'s Labels';
      return;
    }

    const orders = orderResult.orders || [];
    if (orders.length === 0) {
      log('No sold items found.', 'info');
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
        log(`Opening conversation page for ${sku}...`, 'info');

        const labelResult = await getLabelFromConversation(order);

        if (!labelResult || labelResult.error) {
          log(`Label failed for ${sku}: ${labelResult?.error || 'unknown'}`, 'error');
          continue;
        }

        const binaryStr = atob(labelResult.pdfBase64);
        const pdfBytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          pdfBytes[i] = binaryStr.charCodeAt(i);
        }

        const modifiedPdf = await addSkuToPdf(pdfBytes, sku);

        const base64Modified = btoa(String.fromCharCode(...new Uint8Array(modifiedPdf)));
        allLabels.push({
          sku, title: order.title, profile: profileName,
          date: today, pdfBase64: base64Modified,
          transactionId: order.transactionId, timestamp: Date.now()
        });

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

btnScan.addEventListener('click', scanLabels);
btnMerge.addEventListener('click', mergeLabels);

document.getElementById('btnMergePage').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/merge.html') });
});

document.getElementById('btnDiagnose').addEventListener('click', async () => {
  log('Running diagnostics...', 'info');
  const tab = await getActiveVintedTab();
  if (!tab) { log('Open vinted.pl first!', 'error'); return; }
  await ensureContentScript(tab.id);
  try {
    const results = await chrome.tabs.sendMessage(tab.id, { action: 'diagnose' });
    if (results) {
      for (const r of results) log(r.msg, r.type || 'info');
    }
  } catch (err) {
    log(`Error: ${err.message}`, 'error');
  }
});

document.getElementById('btnShowCaptured').addEventListener('click', async () => {
  chrome.runtime.sendMessage({ action: 'getCapturedFromBg' }, (data) => {
    const requests = data?.capturedRequests || [];
    const foundUrl = data?.foundLabelUrl;

    if (foundUrl) log(`Found label URL: ${foundUrl}`, 'success');

    log(`=== CAPTURED (${requests.length}) ===`, 'info');
    for (const r of requests) {
      let d = `[${r.source}] `;
      if (r.source === 'window-open') d += `window.open("${r.url}")`;
      else if (r.source === 'blob-capture') d += `BLOB ${r.blobType} ${r.blobSize}b`;
      else if (r.source === 'download') d += `Download: ${r.url} (${r.mime})`;
      else d += `${r.method||'GET'} ${r.url} -> ${r.status} (${r.contentType||''})`;
      if (r.isPdf) d += ' [PDF!]';
      log(d, r.isPdf || r.source === 'window-open' ? 'success' : 'info');
    }
    log('=== END ===', 'info');
    log('Copy and send to me!', 'info');
  });
});

document.getElementById('btnClearCaptured').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'clearCaptured' }, () => {
    log('Cleared.', 'info');
  });
});

chrome.storage.local.get('foundLabelUrl', (data) => {
  if (data.foundLabelUrl) {
    log(`Previously found: ${data.foundLabelUrl}`, 'success');
  }
});
