chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getSoldOrders') {
    fetchSoldOrders().then(sendResponse);
    return true;
  }

  if (msg.action === 'downloadLabel') {
    downloadLabel(msg.order).then(sendResponse);
    return true;
  }

  if (msg.action === 'checkAuth') {
    checkAuthentication().then(sendResponse);
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
  if (csrf) {
    headers['X-CSRF-Token'] = csrf;
  }
  return headers;
}

async function tryFetch(url, label) {
  try {
    const resp = await fetch(url, {
      credentials: 'include',
      headers: getAuthHeaders()
    });
    const status = resp.status;
    if (!resp.ok) return { url, label, status, ok: false, data: null };
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      const data = await resp.json();
      return { url, label, status, ok: true, data, contentType };
    }
    if (contentType.includes('pdf') || contentType.includes('octet-stream')) {
      return { url, label, status, ok: true, data: null, contentType, isPdf: true, response: resp };
    }
    const text = await resp.text();
    return { url, label, status, ok: true, data: null, contentType, text: text.substring(0, 200) };
  } catch (err) {
    return { url, label, status: 0, ok: false, error: err.message, data: null };
  }
}

async function runDiagnostics() {
  const results = [];
  const csrf = getCsrfToken();
  results.push({ check: 'CSRF Token', value: csrf ? csrf.substring(0, 20) + '...' : 'NOT FOUND' });
  results.push({ check: 'Current URL', value: window.location.href });

  // Check basic API
  const userResult = await tryFetch('https://www.vinted.pl/api/v2/users/current', 'Current user');
  results.push({
    check: 'API: Current user',
    status: userResult.status,
    ok: userResult.ok,
    userId: userResult.data?.user?.id
  });

  // Get orders
  const ordersResult = await tryFetch('https://www.vinted.pl/api/v2/my_orders?type=sold&page=1&per_page=20', 'My orders');
  if (ordersResult.ok && ordersResult.data) {
    const orders = ordersResult.data.my_orders || [];
    results.push({
      check: 'API: My orders (sold)',
      status: ordersResult.status,
      ok: true,
      count: orders.length,
      allKeys: orders.length > 0 ? Object.keys(orders[0]) : [],
      firstOrder: orders.length > 0 ? JSON.parse(JSON.stringify(orders[0])) : null
    });

    // For first order, try all possible label URLs
    if (orders.length > 0) {
      const order = orders[0];
      const txId = order.transaction_id;
      const convId = order.conversation_id;

      // First, get full transaction details
      const txDetailUrls = [
        `https://www.vinted.pl/api/v2/transactions/${txId}`,
        `https://www.vinted.pl/api/v2/conversations/${convId}`,
      ];

      for (const url of txDetailUrls) {
        const r = await tryFetch(url, '');
        const summary = { check: `Detail: ${url}`, status: r.status, ok: r.ok };
        if (r.ok && r.data) {
          summary.keys = Object.keys(r.data);
          // Look for shipment info
          const dataStr = JSON.stringify(r.data);
          if (dataStr.includes('shipment')) {
            const shipmentMatch = dataStr.match(/"shipment_id"\s*:\s*(\d+)/);
            if (shipmentMatch) summary.shipmentId = shipmentMatch[1];
            // Get nested shipment keys
            if (r.data.transaction?.shipment) {
              summary.shipmentKeys = Object.keys(r.data.transaction.shipment);
              summary.shipmentData = r.data.transaction.shipment;
            }
            if (r.data.conversation?.transaction?.shipment) {
              summary.shipmentKeys = Object.keys(r.data.conversation.transaction.shipment);
              summary.shipmentData = r.data.conversation.transaction.shipment;
            }
          }
          // Look for any label/tracking URLs in the response
          const labelMatches = dataStr.match(/"(label[^"]*url|tracking[^"]*url|download[^"]*url|parcel_label[^"]*|shipment_label[^"]*)":\s*"([^"]+)"/gi);
          if (labelMatches) summary.labelRelatedFields = labelMatches;
          // Capture full data for analysis
          summary.fullData = r.data;
        }
        results.push(summary);
      }

      // Try different label URL patterns
      const labelUrls = [
        `https://www.vinted.pl/api/v2/transactions/${txId}/shipment/label`,
        `https://www.vinted.pl/api/v2/transactions/${txId}/label`,
        `https://www.vinted.pl/api/v2/transactions/${txId}/shipment`,
        `https://www.vinted.pl/api/v2/shipments/${txId}/label`,
        `https://www.vinted.pl/api/v2/conversations/${convId}/shipment/label`,
        `https://www.vinted.pl/api/v2/conversations/${convId}/label`,
        `https://www.vinted.pl/transaction/${txId}/shipping-label`,
        `https://www.vinted.pl/api/v2/my_orders/${txId}/label`,
        `https://www.vinted.pl/api/v2/my_orders/${txId}/shipment/label`,
      ];

      for (const url of labelUrls) {
        const r = await tryFetch(url, '');
        results.push({
          check: `Label URL: ${url.replace('https://www.vinted.pl', '')}`,
          status: r.status,
          ok: r.ok,
          contentType: r.contentType || '',
          isPdf: r.isPdf || false,
          hasData: !!r.data,
          dataKeys: r.data ? Object.keys(r.data) : [],
          text: r.text || ''
        });
      }
    }
  } else {
    results.push({
      check: 'API: My orders (sold)',
      status: ordersResult.status,
      ok: false,
      error: ordersResult.error
    });
  }

  return results;
}

async function checkAuthentication() {
  try {
    const resp = await fetch('https://www.vinted.pl/api/v2/users/current', {
      credentials: 'include',
      headers: getAuthHeaders()
    });
    if (resp.ok) {
      const data = await resp.json();
      return { authenticated: true, username: data.user?.login || 'unknown', userId: data.user?.id };
    }
    return { authenticated: false, status: resp.status };
  } catch (err) {
    return { authenticated: false, error: err.message };
  }
}

async function fetchSoldOrders() {
  try {
    const result = await tryFetch('https://www.vinted.pl/api/v2/my_orders?type=sold&page=1&per_page=50', 'orders');

    if (!result.ok || !result.data) {
      return { orders: [], error: `API returned HTTP ${result.status}` };
    }

    const orders = [];
    const items = result.data.my_orders || [];

    for (const item of items) {
      const title = item.title || '';
      const transactionId = item.transaction_id || '';
      const conversationId = item.conversation_id || '';

      if (!title || !transactionId) continue;

      orders.push({
        title,
        transactionId: String(transactionId),
        conversationId: String(conversationId),
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

  // Try to get transaction/conversation details first for a direct label URL
  const detailUrls = [
    `https://www.vinted.pl/api/v2/transactions/${txId}`,
    `https://www.vinted.pl/api/v2/conversations/${convId}`,
  ];

  for (const url of detailUrls) {
    try {
      const resp = await fetch(url, { credentials: 'include', headers: getAuthHeaders() });
      if (!resp.ok) continue;
      const data = await resp.json();
      const dataStr = JSON.stringify(data);

      // Look for label URL in the response
      const urlMatch = dataStr.match(/"(?:label_url|parcel_label_url|shipping_label_url|download_url)"\s*:\s*"([^"]+)"/);
      if (urlMatch) {
        const labelUrl = urlMatch[1].replace(/\\\//g, '/');
        const labelResp = await fetch(labelUrl, { credentials: 'include' });
        if (labelResp.ok) {
          const blob = await labelResp.blob();
          return await blobToBase64(blob);
        }
      }

      // Look for shipment with label info
      const shipment = data.transaction?.shipment || data.conversation?.transaction?.shipment;
      if (shipment) {
        // Try shipment-based label URLs
        const shipmentId = shipment.id || shipment.shipment_id;
        if (shipmentId) {
          const shipLabelUrls = [
            `https://www.vinted.pl/api/v2/shipments/${shipmentId}/label`,
            `https://www.vinted.pl/api/v2/transactions/${txId}/shipments/${shipmentId}/label`,
          ];
          for (const sUrl of shipLabelUrls) {
            const sResp = await fetch(sUrl, {
              credentials: 'include',
              headers: { ...getAuthHeaders(), 'Accept': 'application/pdf, */*' }
            });
            if (sResp.ok) {
              const ct = sResp.headers.get('content-type') || '';
              if (ct.includes('pdf') || ct.includes('octet')) {
                const blob = await sResp.blob();
                return await blobToBase64(blob);
              }
            }
          }
        }
      }
    } catch {}
  }

  // Try all known label URL patterns
  const labelUrls = [
    `https://www.vinted.pl/api/v2/transactions/${txId}/shipment/label`,
    `https://www.vinted.pl/api/v2/transactions/${txId}/label`,
    `https://www.vinted.pl/api/v2/shipments/${txId}/label`,
    `https://www.vinted.pl/api/v2/conversations/${convId}/shipment/label`,
    `https://www.vinted.pl/api/v2/conversations/${convId}/label`,
    `https://www.vinted.pl/api/v2/my_orders/${txId}/label`,
    `https://www.vinted.pl/api/v2/my_orders/${txId}/shipment/label`,
  ];

  for (const url of labelUrls) {
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Accept': 'application/pdf, */*' }
      });
      if (!resp.ok) continue;
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('pdf') || ct.includes('octet')) {
        const blob = await resp.blob();
        return await blobToBase64(blob);
      }
      // If JSON response, check for a URL inside it
      if (ct.includes('json')) {
        const data = await resp.json();
        const str = JSON.stringify(data);
        const urlMatch = str.match(/"(https?:[^"]*(?:label|pdf)[^"]*)"/i);
        if (urlMatch) {
          const pdfUrl = urlMatch[1].replace(/\\\//g, '/');
          const pdfResp = await fetch(pdfUrl, { credentials: 'include' });
          if (pdfResp.ok) {
            const blob = await pdfResp.blob();
            return await blobToBase64(blob);
          }
        }
        return { error: 'Got JSON instead of PDF', data };
      }
    } catch {}
  }

  return { error: 'All label URL patterns returned 404. Run diagnostics for details.' };
}

async function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve({ pdfBase64: base64 });
    };
    reader.onerror = () => resolve({ error: 'Failed to read PDF blob' });
    reader.readAsDataURL(blob);
  });
}
