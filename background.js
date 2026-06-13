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

  if (msg.action === 'capturedRequest') {
    console.log('[Vinted Label] Captured request:', msg.entry);
    if (msg.entry.isPdf) {
      console.log('[Vinted Label] FOUND PDF DOWNLOAD URL:', msg.entry.url);
    }
  }

  if (msg.action === 'capturedClick') {
    console.log('[Vinted Label] Captured click:', msg.text, msg.href);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('collectedLabels', (data) => {
    if (!data.collectedLabels) {
      chrome.storage.local.set({ collectedLabels: [] });
    }
  });
});
