// Monitor ALL web requests to vinted.pl for PDF responses
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const ct = (details.responseHeaders || []).find(
      h => h.name.toLowerCase() === 'content-type'
    );
    const contentType = ct ? ct.value : '';
    const url = details.url;

    // Log everything from vinted.pl API for debugging
    if (url.includes('/api/') && !url.includes('images1.vinted.net')) {
      const entry = {
        url,
        method: details.method,
        status: details.statusCode,
        contentType,
        type: details.type,
        time: Date.now(),
      };

      // Store in captured requests
      chrome.storage.local.get('capturedRequests', (data) => {
        const requests = data.capturedRequests || [];
        requests.push(entry);
        // Keep only last 100
        if (requests.length > 100) requests.splice(0, requests.length - 100);
        chrome.storage.local.set({ capturedRequests: requests });
      });

      // If it's a PDF, this is likely the label URL!
      if (contentType.includes('pdf') || contentType.includes('octet-stream')) {
        console.log('[Vinted Label] FOUND PDF URL:', url);
        chrome.storage.local.set({
          foundLabelUrl: url,
          foundLabelTime: Date.now(),
        });
        // Set badge to notify user
        chrome.action.setBadgeText({ text: 'PDF!' });
        chrome.action.setBadgeBackgroundColor({ color: '#27ae60' });
      }
    }
  },
  { urls: ['https://www.vinted.pl/*'] },
  ['responseHeaders']
);

// Also monitor downloads
chrome.downloads.onCreated.addListener((item) => {
  if (item.url && item.url.includes('vinted')) {
    const entry = {
      url: item.url,
      filename: item.filename,
      mime: item.mime,
      type: 'download',
      time: Date.now(),
    };

    chrome.storage.local.get('capturedRequests', (data) => {
      const requests = data.capturedRequests || [];
      requests.push(entry);
      chrome.storage.local.set({ capturedRequests: requests });
    });

    if (item.mime && (item.mime.includes('pdf') || item.mime.includes('octet-stream'))) {
      console.log('[Vinted Label] PDF DOWNLOAD:', item.url);
      chrome.storage.local.set({
        foundLabelUrl: item.url,
        foundLabelTime: Date.now(),
      });
      chrome.action.setBadgeText({ text: 'PDF!' });
      chrome.action.setBadgeBackgroundColor({ color: '#27ae60' });
    }
  }
});

// Monitor navigation to find label-related URLs
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.url.includes('label') || details.url.includes('shipment') || details.url.includes('parcel')) {
      const entry = {
        url: details.url,
        method: details.method,
        status: details.statusCode,
        type: 'navigation-label-related',
        time: Date.now(),
      };
      chrome.storage.local.get('capturedRequests', (data) => {
        const requests = data.capturedRequests || [];
        requests.push(entry);
        chrome.storage.local.set({ capturedRequests: requests });
      });
    }
  },
  { urls: ['https://www.vinted.pl/*', 'https://*.vinted.net/*', 'https://*.vinted.com/*'] }
);

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'scan-labels') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('vinted.pl')) {
      chrome.action.openPopup();
    }
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
  chrome.storage.local.get('collectedLabels', (data) => {
    if (!data.collectedLabels) {
      chrome.storage.local.set({ collectedLabels: [], capturedRequests: [] });
    }
  });
});
