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

function getAuthHeaders() {
  const csrf = getCsrfToken();
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return headers;
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
      headers: { ...getAuthHeaders(), 'Accept': 'application/pdf, application/octet-stream, */*' }
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('pdf') || ct.includes('octet-stream')) {
      const blob = await resp.blob();
      return { ok: true, blob, contentType: ct };
    }
    if (ct.includes('json')) {
      const data = await resp.json();
      return { ok: true, isJson: true, data, contentType: ct };
    }
    // Might be PDF without proper content-type
    const blob = await resp.blob();
    if (blob.size > 500) {
      return { ok: true, blob, contentType: ct };
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
    reader.onerror = () => resolve({ error: 'Failed to read blob' });
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
      const txId = String(item.transaction_id || '');
      const convId = String(item.conversation_id || '');
      const title = item.title || '';

      if (!title || !txId) continue;

      // Fetch transaction details to get the SHIPMENT ID
      let shipmentId = null;
      const txResult = await tryFetchJson(`https://www.vinted.pl/api/v2/transactions/${txId}`);
      if (txResult.ok && txResult.data?.transaction?.shipment) {
        shipmentId = String(txResult.data.transaction.shipment.id || '');
      }

      orders.push({
        title,
        transactionId: txId,
        conversationId: convId,
        shipmentId: shipmentId,
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
  let shipmentId = order.shipmentId;

  // If we don't have shipment ID, fetch it from transaction details
  if (!shipmentId) {
    const txResult = await tryFetchJson(`https://www.vinted.pl/api/v2/transactions/${txId}`);
    if (txResult.ok && txResult.data?.transaction?.shipment) {
      shipmentId = String(txResult.data.transaction.shipment.id || '');
    }
  }

  // Build list of URLs to try - prioritize shipment ID based URLs
  const urls = [];

  if (shipmentId) {
    urls.push(
      `https://www.vinted.pl/api/v2/shipments/${shipmentId}/label`,
      `https://www.vinted.pl/api/v2/shipments/${shipmentId}/parcel/label`,
      `https://www.vinted.pl/api/v2/shipments/${shipmentId}/download`,
      `https://www.vinted.pl/api/v2/shipments/${shipmentId}/label/download`,
      `https://www.vinted.pl/api/v2/transactions/${txId}/shipments/${shipmentId}/label`,
      `https://www.vinted.pl/api/v2/transactions/${txId}/shipment/${shipmentId}/label`,
    );
  }

  urls.push(
    `https://www.vinted.pl/api/v2/transactions/${txId}/shipment/label`,
    `https://www.vinted.pl/api/v2/transactions/${txId}/label`,
    `https://www.vinted.pl/api/v2/transactions/${txId}/shipment/label/download`,
    `https://www.vinted.pl/api/v2/conversations/${convId}/shipment/label`,
    `https://www.vinted.pl/api/v2/conversations/${convId}/label`,
  );

  for (const url of urls) {
    const result = await tryFetchPdf(url);
    if (result.ok && result.blob) {
      return await blobToBase64(result.blob);
    }
    // If JSON response, look for a URL inside
    if (result.ok && result.isJson && result.data) {
      const labelUrl = findUrlInData(result.data);
      if (labelUrl) {
        const pdfResult = await tryFetchPdf(labelUrl);
        if (pdfResult.ok && pdfResult.blob) {
          return await blobToBase64(pdfResult.blob);
        }
      }
    }
  }

  // APPROACH 2: Get full transaction data and search for ANY URL
  const txResult = await tryFetchJson(`https://www.vinted.pl/api/v2/transactions/${txId}`);
  if (txResult.ok && txResult.data) {
    const allUrls = extractAllUrls(txResult.data);
    for (const url of allUrls) {
      if (url.includes('label') || url.includes('parcel') || url.includes('pdf') || url.includes('download') || url.includes('shipment')) {
        const pdfResult = await tryFetchPdf(url);
        if (pdfResult.ok && pdfResult.blob) {
          return await blobToBase64(pdfResult.blob);
        }
      }
    }
  }

  // APPROACH 3: Get conversation data and search
  const convResult = await tryFetchJson(`https://www.vinted.pl/api/v2/conversations/${convId}`);
  if (convResult.ok && convResult.data) {
    const allUrls = extractAllUrls(convResult.data);
    for (const url of allUrls) {
      if (url.includes('label') || url.includes('parcel') || url.includes('pdf') || url.includes('download')) {
        const pdfResult = await tryFetchPdf(url);
        if (pdfResult.ok && pdfResult.blob) {
          return await blobToBase64(pdfResult.blob);
        }
      }
    }
  }

  return {
    error: `Label not found. Transaction: ${txId}, Shipment: ${shipmentId || 'unknown'}`,
    shipmentId
  };
}

function findUrlInData(data) {
  const str = JSON.stringify(data);
  const patterns = [
    /"(?:label_url|parcel_label_url|shipping_label_url|download_url|url)"\s*:\s*"(https?:[^"]+)"/i,
    /"(https?:[^"]*(?:label|parcel)[^"]*\.pdf[^"]*)"/i,
    /"(https?:[^"]*(?:label|parcel)[^"]*download[^"]*)"/i,
  ];
  for (const p of patterns) {
    const m = str.match(p);
    if (m) return m[1].replace(/\\\//g, '/');
  }
  return null;
}

function extractAllUrls(obj) {
  const urls = new Set();
  const str = JSON.stringify(obj);
  const matches = str.match(/"(https?:\/\/[^"]+)"/g);
  if (matches) {
    for (const m of matches) {
      urls.add(m.slice(1, -1).replace(/\\\//g, '/'));
    }
  }
  const pathMatches = str.match(/"(\/api\/v2\/[^"]+)"/g);
  if (pathMatches) {
    for (const m of pathMatches) {
      urls.add('https://www.vinted.pl' + m.slice(1, -1).replace(/\\\//g, '/'));
    }
  }
  return [...urls];
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
  const txId = order.transaction_id;
  const convId = order.conversation_id;
  results.push({ type: 'info', msg: `Order: tx=${txId} conv=${convId} title="${order.title}"` });

  // Get full transaction details including shipment
  results.push({ type: 'info', msg: `--- Transaction details ---` });
  const txResult = await tryFetchJson(`https://www.vinted.pl/api/v2/transactions/${txId}`);
  if (txResult.ok && txResult.data) {
    const tx = txResult.data.transaction || {};
    const shipment = tx.shipment || {};
    const shipmentId = shipment.id;
    results.push({ type: 'success', msg: `Transaction: HTTP 200` });
    results.push({ type: 'info', msg: `Shipment ID: ${shipmentId}` });
    results.push({ type: 'info', msg: `Shipment status: ${shipment.status} - ${shipment.status_title}` });
    results.push({ type: 'info', msg: `Shipment ALL keys: ${Object.keys(shipment).join(', ')}` });
    results.push({ type: 'info', msg: `Shipment FULL: ${JSON.stringify(shipment)}` });
    results.push({ type: 'info', msg: `Transaction ALL keys: ${Object.keys(tx).join(', ')}` });

    // Show ALL URLs found in transaction data
    const allUrls = extractAllUrls(txResult.data);
    results.push({ type: 'info', msg: `URLs found in transaction data: ${allUrls.length}` });
    for (const url of allUrls) {
      results.push({ type: 'info', msg: `  URL: ${url}` });
    }

    // Try label URLs with SHIPMENT ID
    if (shipmentId) {
      results.push({ type: 'info', msg: `--- Trying label URLs with shipment ID ${shipmentId} ---` });
      const shipmentLabelUrls = [
        `/api/v2/shipments/${shipmentId}/label`,
        `/api/v2/shipments/${shipmentId}/parcel/label`,
        `/api/v2/shipments/${shipmentId}/download`,
        `/api/v2/shipments/${shipmentId}/label/download`,
        `/api/v2/transactions/${txId}/shipments/${shipmentId}/label`,
        `/api/v2/transactions/${txId}/shipment/${shipmentId}/label`,
      ];

      for (const path of shipmentLabelUrls) {
        const url = `https://www.vinted.pl${path}`;
        try {
          const resp = await fetch(url, {
            credentials: 'include',
            headers: { ...getAuthHeaders(), 'Accept': 'application/pdf, application/octet-stream, */*' }
          });
          const ct = resp.headers.get('content-type') || '';
          const size = resp.headers.get('content-length') || '?';
          let detail = `${path} -> HTTP ${resp.status} (${ct}, size: ${size})`;
          if (resp.ok && ct.includes('json')) {
            const data = await resp.json();
            detail += ` DATA: ${JSON.stringify(data).substring(0, 300)}`;
          }
          results.push({ type: resp.ok ? 'success' : 'error', msg: detail });
        } catch (err) {
          results.push({ type: 'error', msg: `${path} -> Error: ${err.message}` });
        }
      }
    }

    // Also try with transaction ID
    results.push({ type: 'info', msg: `--- Trying label URLs with transaction ID ${txId} ---` });
    const txLabelUrls = [
      `/api/v2/transactions/${txId}/shipment/label`,
      `/api/v2/transactions/${txId}/label`,
      `/api/v2/transactions/${txId}/shipment/label/download`,
    ];

    for (const path of txLabelUrls) {
      const url = `https://www.vinted.pl${path}`;
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { ...getAuthHeaders(), 'Accept': 'application/pdf, application/octet-stream, */*' }
        });
        const ct = resp.headers.get('content-type') || '';
        let detail = `${path} -> HTTP ${resp.status} (${ct})`;
        if (resp.ok && ct.includes('json')) {
          const data = await resp.json();
          detail += ` DATA: ${JSON.stringify(data).substring(0, 300)}`;
        }
        results.push({ type: resp.ok ? 'success' : 'error', msg: detail });
      } catch (err) {
        results.push({ type: 'error', msg: `${path} -> Error: ${err.message}` });
      }
    }
  } else {
    results.push({ type: 'error', msg: `Transaction API: HTTP ${txResult.status}` });
  }

  // Conversation data
  results.push({ type: 'info', msg: `--- Conversation details ---` });
  const convResult = await tryFetchJson(`https://www.vinted.pl/api/v2/conversations/${convId}`);
  if (convResult.ok && convResult.data) {
    const conv = convResult.data.conversation || {};
    results.push({ type: 'success', msg: `Conversation: HTTP 200` });
    results.push({ type: 'info', msg: `Conv keys: ${Object.keys(conv).join(', ')}` });

    // Look for any label/shipment related fields
    const convStr = JSON.stringify(convResult.data);
    const labelMatches = convStr.match(/"[^"]*(?:label|parcel|shipment|tracking|download)[^"]*"\s*:\s*"?[^",}]+/gi);
    if (labelMatches) {
      for (const lm of labelMatches.slice(0, 10)) {
        results.push({ type: 'info', msg: `Conv match: ${lm}` });
      }
    }
  }

  // Check conversation page HTML for download buttons
  results.push({ type: 'info', msg: `--- Conversation page HTML scan ---` });
  try {
    const pageResp = await fetch(`https://www.vinted.pl/inbox/${convId}`, {
      credentials: 'include'
    });
    if (pageResp.ok) {
      const html = await pageResp.text();
      results.push({ type: 'success', msg: `Page loaded (${html.length} chars)` });

      // Find any href containing relevant keywords
      const hrefMatches = html.match(/href=["'][^"']*(?:label|shipment|parcel|download|etykiet|pobierz)[^"']*["']/gi);
      if (hrefMatches) {
        for (const hm of hrefMatches) {
          results.push({ type: 'success', msg: `Found href: ${hm}` });
        }
      } else {
        results.push({ type: 'info', msg: 'No label/download hrefs found in page HTML' });
      }

      // Find data attributes
      const dataMatches = html.match(/data-[^=]*=["'][^"']*(?:label|shipment|download)[^"']*["']/gi);
      if (dataMatches) {
        for (const dm of dataMatches) {
          results.push({ type: 'success', msg: `Found data attr: ${dm}` });
        }
      }

      // Look for inline scripts with label data
      const scriptBlocks = html.match(/<script[^>]*>([^<]*(?:label|shipment|parcel)[^<]*)<\/script>/gi);
      if (scriptBlocks) {
        for (const sb of scriptBlocks.slice(0, 3)) {
          results.push({ type: 'info', msg: `Script with label ref: ${sb.substring(0, 200)}` });
        }
      }

      // Check __NEXT_DATA__
      const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (nextData) {
        results.push({ type: 'info', msg: `Has __NEXT_DATA__ (${nextData[1].length} chars)` });
        const nd = nextData[1];
        // Look for shipment/label in NEXT_DATA
        const shipmentRefs = nd.match(/"shipment[^"]*":\s*(?:\{[^}]*\}|"[^"]*")/g);
        if (shipmentRefs) {
          for (const sr of shipmentRefs.slice(0, 5)) {
            results.push({ type: 'info', msg: `NEXT_DATA: ${sr.substring(0, 200)}` });
          }
        }
        const labelRefs = nd.match(/"[^"]*label[^"]*":\s*(?:\{[^}]*\}|"[^"]*"|true|false)/gi);
        if (labelRefs) {
          for (const lr of labelRefs.slice(0, 5)) {
            results.push({ type: 'info', msg: `NEXT_DATA label: ${lr.substring(0, 200)}` });
          }
        }
      } else {
        results.push({ type: 'info', msg: 'No __NEXT_DATA__ found' });
      }
    }
  } catch (err) {
    results.push({ type: 'error', msg: `Page error: ${err.message}` });
  }

  return results;
}
