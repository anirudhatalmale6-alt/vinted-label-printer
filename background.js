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

  if (msg.action === 'clearOldLabels') {
    chrome.storage.local.get('collectedLabels', (data) => {
      const today = new Date().toISOString().split('T')[0];
      const labels = (data.collectedLabels || []).filter(l => l.date === today);
      chrome.storage.local.set({ collectedLabels: labels }, () => {
        sendResponse({ cleared: true });
      });
    });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('collectedLabels', (data) => {
    if (!data.collectedLabels) {
      chrome.storage.local.set({ collectedLabels: [] });
    }
  });
});
