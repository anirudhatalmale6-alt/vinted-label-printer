// Monitor web requests for PDFs
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const url = details.url;
    if (url.match(/\.(jpeg|jpg|png|gif|svg|css|woff|woff2|ttf|ico)(\?|$)/i)) return;
    if (url.includes('images1.vinted.net')) return;
    if (url.includes('google') || url.includes('facebook') || url.includes('analytics')) return;

    const ct = (details.responseHeaders || []).find(h => h.name.toLowerCase() === 'content-type');
    const contentType = ct ? ct.value : '';
    const isPdf = contentType.includes('pdf') || contentType.includes('octet-stream');
    const isVinted = url.includes('vinted');

    if (isVinted || isPdf) {
      addCapturedEntry({
        source: 'webRequest',
        url, method: details.method, status: details.statusCode,
        contentType, isPdf, time: Date.now(),
      });

      if (isPdf) {
        chrome.storage.local.set({ foundLabelUrl: url, foundLabelTime: Date.now() });
        chrome.action.setBadgeText({ text: 'PDF!' });
        chrome.action.setBadgeBackgroundColor({ color: '#27ae60' });
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Monitor downloads
chrome.downloads.onCreated.addListener((item) => {
  addCapturedEntry({
    source: 'download',
    url: item.url || '', finalUrl: item.finalUrl || '',
    filename: item.filename || '', mime: item.mime || '',
    fileSize: item.fileSize, time: Date.now(),
  });
});

// Monitor new tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && (changeInfo.url.includes('blob:') || changeInfo.url.includes('.pdf') ||
      changeInfo.url.includes('label') || changeInfo.url.includes('shipment'))) {
    addCapturedEntry({
      source: 'tab-update',
      url: changeInfo.url, tabId, time: Date.now(),
    });
  }
});

function addCapturedEntry(entry) {
  chrome.storage.local.get('capturedRequests', (data) => {
    const requests = data.capturedRequests || [];
    requests.push(entry);
    if (requests.length > 200) requests.splice(0, requests.length - 200);
    chrome.storage.local.set({ capturedRequests: requests });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Blob captured from page-level interceptor
  if (msg.action === 'blobCaptured') {
    console.log('[Vinted Label] BLOB CAPTURED!', msg.blobType, msg.blobSize, 'bytes');

    addCapturedEntry({
      source: 'blob-capture',
      blobType: msg.blobType,
      blobSize: msg.blobSize,
      blobUrl: msg.blobUrl,
      pageUrl: msg.url,
      hasData: !!msg.dataUrl,
      time: Date.now(),
    });

    // Store the actual PDF data
    if (msg.dataUrl && (msg.blobType === 'application/pdf' || msg.blobSize > 1000)) {
      const base64 = msg.dataUrl.includes(',') ? msg.dataUrl.split(',')[1] : msg.dataUrl;
      chrome.storage.local.get('capturedLabels', (data) => {
        const labels = data.capturedLabels || [];
        labels.push({
          pdfBase64: base64,
          blobType: msg.blobType,
          blobSize: msg.blobSize,
          pageUrl: msg.url,
          time: Date.now(),
        });
        chrome.storage.local.set({ capturedLabels: labels });
      });

      chrome.action.setBadgeText({ text: 'PDF!' });
      chrome.action.setBadgeBackgroundColor({ color: '#27ae60' });
    }
  }

  // Window.open captured
  if (msg.action === 'windowOpenCaptured') {
    console.log('[Vinted Label] window.open:', msg.url);
    addCapturedEntry({
      source: 'window-open',
      url: msg.url,
      pageUrl: msg.pageUrl,
      time: Date.now(),
    });
  }

  // Link click captured
  if (msg.action === 'linkClickCaptured') {
    console.log('[Vinted Label] link click:', msg.href);
    addCapturedEntry({
      source: 'link-click',
      href: msg.href,
      download: msg.download,
      pageUrl: msg.pageUrl,
      time: Date.now(),
    });
  }

  if (msg.action === 'getCapturedFromBg') {
    chrome.storage.local.get(['capturedRequests', 'foundLabelUrl', 'capturedLabels'], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (msg.action === 'clearCaptured') {
    chrome.storage.local.set({ capturedRequests: [], foundLabelUrl: null, capturedLabels: [] });
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ cleared: true });
    return true;
  }

  if (msg.action === 'getLabelCount') {
    chrome.storage.local.get('collectedLabels', (data) => {
      const today = new Date().toISOString().split('T')[0];
      const count = (data.collectedLabels || []).filter(l => l.date === today).length;
      sendResponse({ count });
    });
    return true;
  }

  if (msg.action === 'getStoredLabel') {
    chrome.storage.local.get('capturedLabels', (data) => {
      const labels = data.capturedLabels || [];
      if (labels.length > 0) {
        sendResponse({ pdfBase64: labels[labels.length - 1].pdfBase64 });
      } else {
        sendResponse({});
      }
    });
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'scan-labels') {
    chrome.action.openPopup();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ collectedLabels: [], capturedRequests: [], capturedLabels: [] });
});
