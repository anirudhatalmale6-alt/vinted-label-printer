// Inject the page-level interceptor
function injectPageScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injector.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}
injectPageScript();

// Listen for messages from injected page script
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;

  if (data.type === 'VINTED_LABEL_BLOB_CAPTURED' || data.type === 'VINTED_LABEL_BLOB') {
    chrome.runtime.sendMessage({
      action: 'blobCaptured',
      blobType: data.blobType, blobSize: data.blobSize,
      blobUrl: data.blobUrl, dataUrl: data.dataUrl,
      url: window.location.href,
    });
  }

  if (data.type === 'VINTED_LABEL_WINDOW_OPEN') {
    chrome.runtime.sendMessage({
      action: 'windowOpenCaptured',
      url: data.url, pageUrl: window.location.href,
    });
  }

  if (data.type === 'VINTED_LABEL_LINK_CLICK') {
    chrome.runtime.sendMessage({
      action: 'linkClickCaptured',
      href: data.href, download: data.download,
      pageUrl: window.location.href,
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getSoldOrders') {
    fetchSoldOrders().then(sendResponse);
    return true;
  }

  if (msg.action === 'findS3Url') {
    findS3UrlInPage().then(sendResponse);
    return true;
  }
});

function getAuthHeaders() {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

async function tryFetchJson(url) {
  try {
    const resp = await fetch(url, { credentials: 'include', headers: getAuthHeaders() });
    if (!resp.ok) return { ok: false, status: resp.status };
    return { ok: true, data: await resp.json() };
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

// Search the fully-loaded page DOM for S3 label URLs
async function findS3UrlInPage() {
  // Wait a moment for any remaining RSC data to load
  await new Promise(r => setTimeout(r, 2000));

  // Search the full document HTML
  const fullHtml = document.documentElement.outerHTML;

  // Search for S3 label URLs (may be escaped in various ways)
  const patterns = [
    /https?:\/\/svc-shipping-labels\.s3[^\s"'<>\\]+/g,
    /svc-shipping-labels\.s3\.eu-central-1\.amazonaws\.com[^\s"'<>\\]+/g,
    /svc-shipping-labels\.s3[^"'<>\s})\]]+/g,
  ];

  for (const pat of patterns) {
    const matches = fullHtml.match(pat);
    if (matches) {
      let url = matches[0];
      if (!url.startsWith('http')) url = 'https://' + url;
      url = url.replace(/\\u0026/g, '&').replace(/\\u003d/g, '=')
               .replace(/\\\//g, '/').replace(/&amp;/g, '&')
               .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>');
      return { found: true, url };
    }
  }

  // Also search all script element text content (RSC payloads)
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const text = s.textContent || '';
    if (text.includes('svc-shipping-labels') || text.includes('shipping-labels.s3')) {
      const match = text.match(/svc-shipping-labels\.s3[^\s"'\\})\]]+/);
      if (match) {
        let url = 'https://' + match[0];
        url = url.replace(/\\u0026/g, '&').replace(/\\u003d/g, '=')
                 .replace(/\\\//g, '/');
        return { found: true, url, source: 'script' };
      }
    }
  }

  // Search in all text nodes (in case URL is in a hidden element)
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent || '';
    if (text.includes('svc-shipping-labels')) {
      const match = text.match(/https?:\/\/svc-shipping-labels[^\s"']+/);
      if (match) return { found: true, url: match[0], source: 'text' };
    }
  }

  return { found: false, htmlLength: fullHtml.length };
}
