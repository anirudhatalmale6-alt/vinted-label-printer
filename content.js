// Inject the page-level interceptor script immediately
function injectPageScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injector.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}
injectPageScript();

// Listen for messages from the injected page script
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;

  if (data.type === 'VINTED_LABEL_BLOB_CAPTURED' || data.type === 'VINTED_LABEL_BLOB') {
    console.log('[Vinted Label Extension] Captured blob:', data.blobType, data.blobSize, 'bytes');

    // Send to background for storage
    chrome.runtime.sendMessage({
      action: 'blobCaptured',
      blobType: data.blobType,
      blobSize: data.blobSize,
      blobUrl: data.blobUrl,
      dataUrl: data.dataUrl,
      url: window.location.href,
    });
  }

  if (data.type === 'VINTED_LABEL_WINDOW_OPEN') {
    console.log('[Vinted Label Extension] window.open:', data.url);
    chrome.runtime.sendMessage({
      action: 'windowOpenCaptured',
      url: data.url,
      pageUrl: window.location.href,
    });
  }

  if (data.type === 'VINTED_LABEL_LINK_CLICK') {
    console.log('[Vinted Label Extension] Link click:', data.href, data.download);
    chrome.runtime.sendMessage({
      action: 'linkClickCaptured',
      href: data.href,
      download: data.download,
      pageUrl: window.location.href,
    });
  }
});

// Standard message handler for extension popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getSoldOrders') {
    fetchSoldOrders().then(sendResponse);
    return true;
  }

  if (msg.action === 'downloadLabel') {
    downloadLabel(msg.order).then(sendResponse);
    return true;
  }
});

function getAuthHeaders(accept) {
  const headers = {
    'Accept': accept || 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
  };
  return headers;
}

async function tryFetchJson(url) {
  try {
    const resp = await fetch(url, { credentials: 'include', headers: getAuthHeaders() });
    if (!resp.ok) return { ok: false, status: resp.status };
    const data = await resp.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fetchSoldOrders() {
  try {
    const result = await tryFetchJson('https://www.vinted.pl/api/v2/my_orders?type=sold&page=1&per_page=50');
    if (!result.ok || !result.data) {
      return { orders: [], error: `API returned HTTP ${result.status}` };
    }

    const orders = [];
    const items = result.data.my_orders || [];

    for (const item of items) {
      const txId = String(item.transaction_id || '');
      const convId = String(item.conversation_id || '');
      const title = item.title || '';
      if (!title || !txId) continue;

      let shipmentId = null;
      const txResult = await tryFetchJson(`https://www.vinted.pl/api/v2/transactions/${txId}`);
      if (txResult.ok && txResult.data?.transaction?.shipment) {
        shipmentId = String(txResult.data.transaction.shipment.id || '');
      }

      orders.push({
        title,
        transactionId: txId,
        conversationId: convId,
        shipmentId,
        status: (item.status || '').toLowerCase(),
        date: item.date || '',
      });
    }

    return { orders };
  } catch (err) {
    return { orders: [], error: err.message };
  }
}

async function downloadLabel(order) {
  // Check if we have a stored label from blob capture
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'getStoredLabel', transactionId: order.transactionId },
      (resp) => {
        if (resp && resp.pdfBase64) {
          resolve({ pdfBase64: resp.pdfBase64 });
        } else {
          resolve({ error: 'Label not available yet. Please download it manually first.' });
        }
      }
    );
  });
}
