chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getSoldOrders') {
    fetchSoldOrders().then(sendResponse);
    return true;
  }

  if (msg.action === 'downloadLabel') {
    downloadLabel(msg.order).then(sendResponse);
    return true;
  }

  if (msg.action === 'diagnose') {
    runDiagnostics().then(sendResponse);
    return true;
  }
});

function getAuthHeaders() {
  const csrf = getCsrfToken();
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (csrf) {
    headers['X-CSRF-Token'] = csrf;
  }
  return headers;
}

function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta) return meta.getAttribute('content');
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const text = s.textContent || '';
    const match = text.match(/csrf[_-]?token["']?\s*[:=]\s*["']([^"']+)["']/i);
    if (match) return match[1];
  }
  return null;
}

async function tryFetchJson(url) {
  try {
    const resp = await fetch(url, { credentials: 'include', headers: getAuthHeaders() });
    if (!resp.ok) return { ok: false, status: resp.status };
    const data = await resp.json();
    return { ok: true, status: resp.status, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function tryFetchPdf(url) {
  try {
    const resp = await fetch(url, {
      credentials: 'include',
      headers: { ...getAuthHeaders(), 'Accept': 'application/pdf, */*' }
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('pdf') || ct.includes('octet-stream')) {
      const blob = await resp.blob();
      return { ok: true, blob };
    }
    if (ct.includes('json')) {
      const data = await resp.json();
      return { ok: true, isJson: true, data };
    }
    return { ok: false, status: resp.status, contentType: ct };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ pdfBase64: reader.result.split(',')[1] });
    reader.onerror = () => resolve({ error: 'Failed to read PDF' });
    reader.readAsDataURL(blob);
  });
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
      orders.push({
        title: item.title || '',
        transactionId: String(item.transaction_id || ''),
        conversationId: String(item.conversation_id || ''),
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
  const txId = order.transactionId;
  const convId = order.conversationId;

  // APPROACH 1: Fetch the conversation page HTML and find the label download link
  try {
    const pageResp = await fetch(`https://www.vinted.pl/inbox/${convId}`, {
      credentials: 'include',
      headers: { 'Accept': 'text/html, */*' }
    });
    if (pageResp.ok) {
      const html = await pageResp.text();

      // Look for label/shipment download links in the HTML
      const patterns = [
        /href=["'](\/api\/v2\/[^"']*label[^"']*)["']/gi,
        /href=["'](\/api\/v2\/[^"']*shipment[^"']*)["']/gi,
        /href=["']([^"']*shipping[_-]?label[^"']*)["']/gi,
        /href=["']([^"']*etykiet[^"']*)["']/gi,
        /href=["']([^"']*parcel[^"']*)["']/gi,
        /"(https?:\/\/[^"]*label[^"]*\.pdf[^"]*)"/gi,
        /"(https?:\/\/[^"]*shipment[^"]*download[^"]*)"/gi,
        /"(\/[^"]*label[^"]*download[^"]*)"/gi,
        /data-url=["']([^"']*label[^"']*)["']/gi,
        /action=["']([^"']*label[^"']*)["']/gi,
      ];

      const foundUrls = new Set();
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
          foundUrls.add(match[1]);
        }
      }

      // Also look for any URL in __NEXT_DATA__ or inline script data
      const scriptDataMatch = html.match(/__NEXT_DATA__[^>]*>(.*?)<\/script>/s);
      if (scriptDataMatch) {
        const scriptData = scriptDataMatch[1];
        // Find label-related URLs in the JSON data
        const urlMatches = scriptData.match(/"(https?:\/\/[^"]*(?:label|shipment|parcel)[^"]*)"/gi);
        if (urlMatches) {
          urlMatches.forEach(m => foundUrls.add(m.replace(/"/g, '')));
        }
        // Also look for label_url, parcel_label_url etc.
        const fieldMatches = scriptData.match(/"(?:label_url|parcel_label_url|shipping_label_url|shipment_label_url|download_url)"\s*:\s*"([^"]+)"/gi);
        if (fieldMatches) {
          fieldMatches.forEach(m => {
            const val = m.match(/"([^"]+)"\s*$/);
            if (val) foundUrls.add(val[1].replace(/\\\//g, '/'));
          });
        }
      }

      // Try each found URL
      for (const url of foundUrls) {
        const fullUrl = url.startsWith('http') ? url : `https://www.vinted.pl${url}`;
        const pdfResult = await tryFetchPdf(fullUrl);
        if (pdfResult.ok && pdfResult.blob) {
          return await blobToBase64(pdfResult.blob);
        }
        if (pdfResult.ok && pdfResult.isJson && pdfResult.data) {
          const dataStr = JSON.stringify(pdfResult.data);
          const pdfUrlMatch = dataStr.match(/"(https?:[^"]*\.pdf[^"]*)"/);
          if (pdfUrlMatch) {
            const pdfUrl = pdfUrlMatch[1].replace(/\\\//g, '/');
            const pdfResp = await fetch(pdfUrl, { credentials: 'include' });
            if (pdfResp.ok) {
              const blob = await pdfResp.blob();
              return await blobToBase64(blob);
            }
          }
        }
      }
    }
  } catch {}

  // APPROACH 2: Fetch conversation API data and look for label info
  try {
    const convResult = await tryFetchJson(`https://www.vinted.pl/api/v2/conversations/${convId}`);
    if (convResult.ok && convResult.data) {
      const dataStr = JSON.stringify(convResult.data);

      // Search for any URL that looks like a label download
      const urlPatterns = [
        /"(https?:[^"]*(?:label|parcel|shipment)[^"]*(?:download|pdf)[^"]*)"/gi,
        /"(?:label_url|parcel_label_url|shipping_label_url|download_url|url)"\s*:\s*"(https?:[^"]+)"/gi,
        /"(https?:[^"]*\.pdf[^"]*)"/gi,
        /"(\/api\/v2\/[^"]*(?:label|parcel)[^"]*)"/gi,
      ];

      const urls = new Set();
      for (const pat of urlPatterns) {
        let m;
        while ((m = pat.exec(dataStr)) !== null) {
          urls.add((m[1] || m[2]).replace(/\\\//g, '/'));
        }
      }

      for (const url of urls) {
        const fullUrl = url.startsWith('http') ? url : `https://www.vinted.pl${url}`;
        const pdfResult = await tryFetchPdf(fullUrl);
        if (pdfResult.ok && pdfResult.blob) {
          return await blobToBase64(pdfResult.blob);
        }
      }

      // Look for shipment object with nested data
      const findShipment = (obj, depth = 0) => {
        if (!obj || depth > 5) return null;
        if (typeof obj !== 'object') return null;
        if (obj.label_url) return obj.label_url;
        if (obj.parcel_label_url) return obj.parcel_label_url;
        if (obj.shipping_label_url) return obj.shipping_label_url;
        for (const key of Object.keys(obj)) {
          const found = findShipment(obj[key], depth + 1);
          if (found) return found;
        }
        return null;
      };

      const labelUrl = findShipment(convResult.data);
      if (labelUrl) {
        const fullUrl = labelUrl.startsWith('http') ? labelUrl : `https://www.vinted.pl${labelUrl}`;
        const pdfResult = await tryFetchPdf(fullUrl);
        if (pdfResult.ok && pdfResult.blob) {
          return await blobToBase64(pdfResult.blob);
        }
      }
    }
  } catch {}

  // APPROACH 3: Try transaction API
  try {
    const txResult = await tryFetchJson(`https://www.vinted.pl/api/v2/transactions/${txId}`);
    if (txResult.ok && txResult.data) {
      const dataStr = JSON.stringify(txResult.data);
      const urlMatch = dataStr.match(/"(https?:[^"]*(?:label|parcel|shipment)[^"]*)"/i);
      if (urlMatch) {
        const fullUrl = urlMatch[1].replace(/\\\//g, '/');
        const pdfResult = await tryFetchPdf(fullUrl);
        if (pdfResult.ok && pdfResult.blob) {
          return await blobToBase64(pdfResult.blob);
        }
      }
    }
  } catch {}

  // APPROACH 4: Direct URL patterns as last resort
  const directUrls = [
    `https://www.vinted.pl/api/v2/transactions/${txId}/shipment/label`,
    `https://www.vinted.pl/api/v2/transactions/${txId}/label`,
    `https://www.vinted.pl/api/v2/shipments/${txId}/label`,
    `https://www.vinted.pl/api/v2/conversations/${convId}/shipment/label`,
  ];

  for (const url of directUrls) {
    const result = await tryFetchPdf(url);
    if (result.ok && result.blob) {
      return await blobToBase64(result.blob);
    }
  }

  return { error: 'Could not find label download URL. Run diagnostics.' };
}

async function runDiagnostics() {
  const results = [];
  const csrf = getCsrfToken();
  results.push({ type: 'info', msg: `CSRF Token: ${csrf ? csrf.substring(0, 20) + '...' : 'NOT FOUND'}` });
  results.push({ type: 'info', msg: `Page URL: ${window.location.href}` });

  // Get orders
  const ordersResult = await tryFetchJson('https://www.vinted.pl/api/v2/my_orders?type=sold&page=1&per_page=10');
  if (!ordersResult.ok) {
    results.push({ type: 'error', msg: `My orders API: HTTP ${ordersResult.status}` });
    return results;
  }

  const orders = ordersResult.data.my_orders || [];
  results.push({ type: 'success', msg: `Found ${orders.length} orders` });

  if (orders.length === 0) return results;

  const order = orders[0];
  results.push({ type: 'info', msg: `First order: ${JSON.stringify(order)}` });

  const convId = order.conversation_id;
  const txId = order.transaction_id;

  // Fetch conversation API
  results.push({ type: 'info', msg: `--- Checking conversation ${convId} ---` });
  const convResult = await tryFetchJson(`https://www.vinted.pl/api/v2/conversations/${convId}`);
  if (convResult.ok) {
    results.push({ type: 'success', msg: `Conversation API: HTTP 200` });
    results.push({ type: 'info', msg: `Conv keys: ${Object.keys(convResult.data).join(', ')}` });
    const fullJson = JSON.stringify(convResult.data);
    // Split into chunks for display
    for (let i = 0; i < Math.min(fullJson.length, 3000); i += 500) {
      results.push({ type: 'info', msg: `ConvData[${i}]: ${fullJson.substring(i, i + 500)}` });
    }
  } else {
    results.push({ type: 'error', msg: `Conversation API: HTTP ${convResult.status}` });
  }

  // Fetch transaction API
  results.push({ type: 'info', msg: `--- Checking transaction ${txId} ---` });
  const txResult = await tryFetchJson(`https://www.vinted.pl/api/v2/transactions/${txId}`);
  if (txResult.ok) {
    results.push({ type: 'success', msg: `Transaction API: HTTP 200` });
    const txJson = JSON.stringify(txResult.data);
    for (let i = 0; i < Math.min(txJson.length, 3000); i += 500) {
      results.push({ type: 'info', msg: `TxData[${i}]: ${txJson.substring(i, i + 500)}` });
    }
  } else {
    results.push({ type: 'error', msg: `Transaction API: HTTP ${txResult.status}` });
  }

  // Fetch conversation page HTML and look for label links
  results.push({ type: 'info', msg: `--- Checking conversation page HTML ---` });
  try {
    const pageResp = await fetch(`https://www.vinted.pl/inbox/${convId}`, {
      credentials: 'include',
      headers: { 'Accept': 'text/html' }
    });
    if (pageResp.ok) {
      const html = await pageResp.text();
      results.push({ type: 'success', msg: `Conversation page: loaded (${html.length} chars)` });

      // Look for label-related elements
      const labelKeywords = ['label', 'etykiet', 'shipment', 'parcel', 'przesylk', 'nadaj', 'paczk'];
      for (const kw of labelKeywords) {
        const regex = new RegExp(`[^\\n]{0,100}${kw}[^\\n]{0,100}`, 'gi');
        const matches = html.match(regex);
        if (matches) {
          for (const m of matches.slice(0, 3)) {
            results.push({ type: 'info', msg: `HTML match [${kw}]: ${m.trim().substring(0, 200)}` });
          }
        }
      }

      // Extract __NEXT_DATA__ if present
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
      if (nextDataMatch) {
        results.push({ type: 'info', msg: `Found __NEXT_DATA__ (${nextDataMatch[1].length} chars)` });
        // Search for shipment/label data in NEXT_DATA
        const nd = nextDataMatch[1];
        const shipmentMatch = nd.match(/"shipment"\s*:\s*\{[^}]*\}/g);
        if (shipmentMatch) {
          for (const sm of shipmentMatch) {
            results.push({ type: 'info', msg: `NEXT_DATA shipment: ${sm.substring(0, 300)}` });
          }
        }
        // Look for any URL with label/parcel
        const urlMatches = nd.match(/"[^"]*(?:label|parcel|shipment)[^"]*url[^"]*"\s*:\s*"[^"]+"/gi);
        if (urlMatches) {
          for (const um of urlMatches) {
            results.push({ type: 'success', msg: `NEXT_DATA URL: ${um}` });
          }
        }
      }

      // Also look for any link containing download/label
      const linkMatches = html.match(/<a[^>]*(?:label|etykiet|download|pobierz)[^>]*>/gi);
      if (linkMatches) {
        for (const lm of linkMatches.slice(0, 5)) {
          results.push({ type: 'success', msg: `Download link: ${lm}` });
        }
      }

      // Check for buttons with label text
      const btnMatches = html.match(/<button[^>]*>(?:[^<]*(?:label|etykiet|pobierz|download)[^<]*)<\/button>/gi);
      if (btnMatches) {
        for (const bm of btnMatches.slice(0, 3)) {
          results.push({ type: 'success', msg: `Download button: ${bm}` });
        }
      }
    }
  } catch (err) {
    results.push({ type: 'error', msg: `Page fetch error: ${err.message}` });
  }

  // Try direct label URL patterns
  results.push({ type: 'info', msg: `--- Trying label URLs ---` });
  const labelUrls = [
    `/api/v2/transactions/${txId}/shipment/label`,
    `/api/v2/transactions/${txId}/label`,
    `/api/v2/transactions/${txId}/shipment`,
    `/api/v2/shipments/${txId}/label`,
    `/api/v2/conversations/${convId}/shipment/label`,
    `/api/v2/conversations/${convId}/label`,
    `/api/v2/my_orders/${txId}/label`,
    `/api/v2/my_orders/${txId}/shipment/label`,
    `/member/transaction/${txId}/label`,
  ];

  for (const path of labelUrls) {
    const url = `https://www.vinted.pl${path}`;
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Accept': 'application/pdf, application/json, */*' }
      });
      const ct = resp.headers.get('content-type') || '';
      results.push({
        type: resp.ok ? 'success' : 'error',
        msg: `${path} -> HTTP ${resp.status} (${ct})`
      });
      if (resp.ok && ct.includes('json')) {
        const data = await resp.json();
        results.push({ type: 'info', msg: `  Response: ${JSON.stringify(data).substring(0, 300)}` });
      }
    } catch (err) {
      results.push({ type: 'error', msg: `${path} -> Error: ${err.message}` });
    }
  }

  return results;
}
