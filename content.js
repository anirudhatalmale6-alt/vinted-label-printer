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

  if (msg.action === 'downloadLabel') {
    downloadLabel(msg.order).then(sendResponse);
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

async function downloadLabel(order) {
  const convId = order.conversationId;
  const txId = order.transactionId;
  const shipmentId = order.shipmentId;

  // APPROACH 1: Fetch the conversation page and extract S3 label URL from RSC data
  try {
    const pageResp = await fetch(`https://www.vinted.pl/inbox/${convId}`, {
      credentials: 'include',
      headers: { 'Accept': 'text/html, */*' },
    });
    if (pageResp.ok) {
      const html = await pageResp.text();
      const s3Url = extractS3LabelUrl(html);
      if (s3Url) {
        const pdfResp = await fetch(s3Url);
        if (pdfResp.ok) {
          const blob = await pdfResp.blob();
          if (blob.size > 100) {
            return await blobToBase64(blob);
          }
        }
      }
    }
  } catch (err) {
    console.error('Page fetch error:', err);
  }

  // APPROACH 2: Fetch conversation API and search for S3 URL
  try {
    const convResult = await tryFetchJson(`https://www.vinted.pl/api/v2/conversations/${convId}`);
    if (convResult.ok) {
      const s3Url = findS3Url(JSON.stringify(convResult.data));
      if (s3Url) {
        const pdfResp = await fetch(s3Url);
        if (pdfResp.ok) {
          const blob = await pdfResp.blob();
          if (blob.size > 100) return await blobToBase64(blob);
        }
      }
    }
  } catch {}

  // APPROACH 3: Fetch transaction API and search for S3 URL
  try {
    const txResult = await tryFetchJson(`https://www.vinted.pl/api/v2/transactions/${txId}`);
    if (txResult.ok) {
      const s3Url = findS3Url(JSON.stringify(txResult.data));
      if (s3Url) {
        const pdfResp = await fetch(s3Url);
        if (pdfResp.ok) {
          const blob = await pdfResp.blob();
          if (blob.size > 100) return await blobToBase64(blob);
        }
      }
    }
  } catch {}

  // APPROACH 4: Try shipment endpoint directly
  if (shipmentId) {
    const shipmentUrls = [
      `https://www.vinted.pl/api/v2/shipments/${shipmentId}`,
      `https://www.vinted.pl/api/v2/shipments/${shipmentId}/label`,
    ];
    for (const url of shipmentUrls) {
      try {
        const resp = await fetch(url, { credentials: 'include', headers: getAuthHeaders() });
        if (resp.ok) {
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('json')) {
            const data = await resp.json();
            const s3Url = findS3Url(JSON.stringify(data));
            if (s3Url) {
              const pdfResp = await fetch(s3Url);
              if (pdfResp.ok) {
                const blob = await pdfResp.blob();
                if (blob.size > 100) return await blobToBase64(blob);
              }
            }
          } else if (ct.includes('pdf') || ct.includes('octet')) {
            const blob = await resp.blob();
            if (blob.size > 100) return await blobToBase64(blob);
          }
        }
      } catch {}
    }
  }

  return { error: 'Could not find label S3 URL in page or API data.' };
}

function extractS3LabelUrl(html) {
  // Search for S3 label URLs in the page HTML (including RSC script data)
  const patterns = [
    /https?:\/\/svc-shipping-labels\.s3[^"'\s\\)]+/g,
    /https?:\/\/[^"'\s]*amazonaws\.com[^"'\s]*(?:label|pdf)[^"'\s]*/gi,
    /svc-shipping-labels\.s3\.eu-central-1\.amazonaws\.com[^"'\s\\)]+/g,
  ];

  for (const pattern of patterns) {
    const matches = html.match(pattern);
    if (matches && matches.length > 0) {
      let url = matches[0];
      // Clean up escaped characters from JSON in RSC data
      url = url.replace(/\\u0026/g, '&').replace(/\\u003d/g, '=')
               .replace(/\\\//g, '/').replace(/\\"/g, '"')
               .replace(/&amp;/g, '&');
      return url;
    }
  }

  // Also search in __next_f.push data which contains RSC payload
  const rscChunks = html.match(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g);
  if (rscChunks) {
    for (const chunk of rscChunks) {
      const content = chunk.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const s3Match = content.match(/svc-shipping-labels\.s3[^"'\s\\)]+/);
      if (s3Match) {
        let url = 'https://' + s3Match[0];
        url = url.replace(/\\u0026/g, '&').replace(/\\u003d/g, '=')
                 .replace(/\\\//g, '/').replace(/&amp;/g, '&');
        return url;
      }
    }
  }

  return null;
}

function findS3Url(jsonStr) {
  const match = jsonStr.match(/https?:\/\/svc-shipping-labels\.s3[^"'\s\\]+/);
  if (match) {
    let url = match[0];
    url = url.replace(/\\u0026/g, '&').replace(/\\u003d/g, '=')
             .replace(/\\\//g, '/').replace(/&amp;/g, '&');
    return url;
  }

  // Also try any amazonaws PDF URL
  const awsMatch = jsonStr.match(/https?:\/\/[^"]*amazonaws\.com[^"]*\.pdf[^"]*/);
  if (awsMatch) {
    let url = awsMatch[0];
    url = url.replace(/\\\//g, '/');
    return url;
  }

  return null;
}

async function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ pdfBase64: reader.result.split(',')[1] });
    reader.onerror = () => resolve({ error: 'Failed to read blob' });
    reader.readAsDataURL(blob);
  });
}
