// Monitor ALL web requests for PDFs (any URL - label might come from a CDN or carrier)
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const url = details.url;

    // Skip static assets
    if (url.match(/\.(jpeg|jpg|png|gif|svg|css|woff|woff2|ttf|ico)(\?|$)/i)) return;
    if (url.includes('images1.vinted.net')) return;
    if (url.includes('google') || url.includes('facebook') || url.includes('analytics')) return;

    const ct = (details.responseHeaders || []).find(
      h => h.name.toLowerCase() === 'content-type'
    );
    const contentType = ct ? ct.value : '';
    const contentDisp = (details.responseHeaders || []).find(
      h => h.name.toLowerCase() === 'content-disposition'
    );
    const disposition = contentDisp ? contentDisp.value : '';

    const isPdf = contentType.includes('pdf') ||
                  contentType.includes('octet-stream') ||
                  disposition.includes('.pdf') ||
                  url.includes('.pdf');

    const isVinted = url.includes('vinted');
    const isLabelRelated = url.includes('label') || url.includes('shipment') ||
                           url.includes('parcel') || url.includes('shipping');

    // Store everything that's relevant
    if (isVinted || isPdf || isLabelRelated) {
      const entry = {
        url,
        method: details.method,
        status: details.statusCode,
        contentType,
        disposition,
        tabId: details.tabId,
        type: details.type,
        isPdf,
        time: Date.now(),
      };

      chrome.storage.local.get('capturedRequests', (data) => {
        const requests = data.capturedRequests || [];
        requests.push(entry);
        if (requests.length > 200) requests.splice(0, requests.length - 200);
        chrome.storage.local.set({ capturedRequests: requests });
      });

      if (isPdf) {
        console.log('[Vinted Label] FOUND PDF:', url, contentType, disposition);
        chrome.storage.local.set({
          foundLabelUrl: url,
          foundLabelTime: Date.now(),
          foundLabelContentType: contentType,
          foundLabelDisposition: disposition,
        });
        chrome.action.setBadgeText({ text: 'PDF!' });
        chrome.action.setBadgeBackgroundColor({ color: '#27ae60' });
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Monitor downloads (catches file saves)
chrome.downloads.onCreated.addListener((item) => {
  const entry = {
    url: item.url || '',
    finalUrl: item.finalUrl || '',
    filename: item.filename || '',
    mime: item.mime || '',
    type: 'download-created',
    fileSize: item.fileSize,
    state: item.state,
    time: Date.now(),
  };

  chrome.storage.local.get('capturedRequests', (data) => {
    const requests = data.capturedRequests || [];
    requests.push(entry);
    chrome.storage.local.set({ capturedRequests: requests });
  });

  console.log('[Vinted Label] Download created:', item.url, item.mime, item.filename);

  if (item.mime && (item.mime.includes('pdf') || item.mime.includes('octet'))) {
    chrome.storage.local.set({
      foundLabelUrl: item.url,
      foundLabelTime: Date.now(),
    });
    chrome.action.setBadgeText({ text: 'PDF!' });
    chrome.action.setBadgeBackgroundColor({ color: '#27ae60' });
  }
});

// Monitor tab navigations (catches new tab openings for PDFs)
chrome.webNavigation?.onCompleted?.addListener((details) => {
  if (details.url && (details.url.includes('label') || details.url.includes('shipment') ||
      details.url.includes('.pdf') || details.url.includes('parcel'))) {
    const entry = {
      url: details.url,
      type: 'navigation',
      tabId: details.tabId,
      time: Date.now(),
    };
    chrome.storage.local.get('capturedRequests', (data) => {
      const requests = data.capturedRequests || [];
      requests.push(entry);
      chrome.storage.local.set({ capturedRequests: requests });
    });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'scan-labels') {
    chrome.action.openPopup();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getLabelCount') {
    chrome.storage.local.get('collectedLabels', (data) => {
      const today = new Date().toISOString().split('T')[0];
      const count = (data.collectedLabels || []).filter(l => l.date === today).length;
      sendResponse({ count });
    });
    return true;
  }

  if (msg.action === 'getCapturedFromBg') {
    chrome.storage.local.get(['capturedRequests', 'foundLabelUrl', 'foundLabelTime'], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (msg.action === 'clearCaptured') {
    chrome.storage.local.set({ capturedRequests: [], foundLabelUrl: null });
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ cleared: true });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ collectedLabels: [], capturedRequests: [] });
});
