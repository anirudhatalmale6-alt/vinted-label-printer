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

  if (msg.action === 'startCapture') {
    startNetworkCapture();
    sendResponse({ started: true });
    return true;
  }

  if (msg.action === 'getCaptured') {
    sendResponse({ captured: window.__vintedCaptured || [] });
    return true;
  }
});

function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta) return meta.getAttribute('content');
  return null;
}

function getAuthHeaders(accept) {
  const csrf = getCsrfToken();
  const headers = {
    'Accept': accept || 'application/json, text/plain, */*',
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

async function tryPostJson(url, body) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('pdf') || ct.includes('octet-stream')) {
      const blob = await resp.blob();
      return { ok: resp.ok, status: resp.status, blob, isPdf: true };
    }
    if (ct.includes('json')) {
      const data = await resp.json();
      return { ok: resp.ok, status: resp.status, data };
    }
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text: text.substring(0, 500), contentType: ct };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function tryFetchPdf(url, method) {
  try {
    const opts = {
      method: method || 'GET',
      credentials: 'include',
      headers: getAuthHeaders('application/pdf, application/octet-stream, */*'),
    };
    const resp = await fetch(url, opts);
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
    const blob = await resp.blob();
    if (blob.size > 500) return { ok: true, blob };
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

// Network capture with window.open and blob URL interception
function startNetworkCapture() {
  if (window.__vintedCaptureActive) return;
  window.__vintedCaptureActive = true;
  window.__vintedCaptured = [];

  // Intercept fetch
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const opts = args[1] || {};
    const resp = await origFetch.apply(this, args);

    if (!url.includes('images1.vinted.net') && !url.includes('.jpeg') && !url.includes('.png') && !url.includes('.svg')) {
      const ct = resp.headers.get('content-type') || '';
      window.__vintedCaptured.push({
        type: 'fetch',
        url,
        method: opts.method || 'GET',
        status: resp.status,
        contentType: ct,
        isPdf: ct.includes('pdf') || ct.includes('octet'),
        time: new Date().toISOString(),
      });
    }
    return resp;
  };

  // Intercept XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__captureUrl = url;
    this.__captureMethod = method;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      const url = this.__captureUrl || '';
      if (!url.includes('images1.vinted.net') && !url.includes('.jpeg')) {
        const ct = this.getResponseHeader('content-type') || '';
        window.__vintedCaptured.push({
          type: 'xhr',
          url,
          method: this.__captureMethod || 'GET',
          status: this.status,
          contentType: ct,
          isPdf: ct.includes('pdf') || ct.includes('octet'),
          time: new Date().toISOString(),
        });
      }
    });
    return origSend.apply(this, args);
  };

  // Intercept window.open
  const origWindowOpen = window.open;
  window.open = function(url, ...rest) {
    window.__vintedCaptured.push({
      type: 'window.open',
      url: url || '',
      time: new Date().toISOString(),
    });
    return origWindowOpen.apply(this, [url, ...rest]);
  };

  // Intercept createElement for dynamic <a> downloads
  const origCreateElement = document.createElement.bind(document);
  document.createElement = function(tag, ...rest) {
    const el = origCreateElement(tag, ...rest);
    if (tag.toLowerCase() === 'a') {
      const origClick = el.click.bind(el);
      el.click = function() {
        if (el.href || el.download) {
          window.__vintedCaptured.push({
            type: 'dynamic-link-click',
            href: el.href,
            download: el.download,
            time: new Date().toISOString(),
          });
        }
        return origClick();
      };
    }
    return el;
  };

  // Intercept URL.createObjectURL for blob URLs
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(blob) {
    const url = origCreateObjectURL(blob);
    if (blob && blob.type) {
      window.__vintedCaptured.push({
        type: 'blob-url',
        blobType: blob.type,
        blobSize: blob.size,
        url: url,
        isPdf: blob.type.includes('pdf'),
        time: new Date().toISOString(),
      });
    }
    return url;
  };

  // Listen for all clicks
  document.addEventListener('click', function(e) {
    const target = e.target.closest('a, button, [role="button"], [data-testid]');
    if (target) {
      window.__vintedCaptured.push({
        type: 'click',
        tag: target.tagName,
        text: (target.textContent || '').trim().substring(0, 100),
        href: target.getAttribute('href') || '',
        className: (target.className || '').toString().substring(0, 100),
        dataTestId: target.getAttribute('data-testid') || '',
        ariaLabel: target.getAttribute('aria-label') || '',
        time: new Date().toISOString(),
      });
    }
  }, true);
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
      let availableActions = null;
      const txResult = await tryFetchJson(`https://www.vinted.pl/api/v2/transactions/${txId}`);
      if (txResult.ok && txResult.data?.transaction) {
        const tx = txResult.data.transaction;
        shipmentId = tx.shipment ? String(tx.shipment.id || '') : null;
        availableActions = tx.available_actions || [];
      }

      orders.push({
        title,
        transactionId: txId,
        conversationId: convId,
        shipmentId,
        availableActions,
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
  const shipmentId = order.shipmentId;

  // APPROACH 1: Try "send_shipping_label" action via POST
  const postEndpoints = [
    { url: `https://www.vinted.pl/api/v2/transactions/${txId}/send_shipping_label`, body: null },
    { url: `https://www.vinted.pl/api/v2/transactions/${txId}/shipping_label`, body: null },
    { url: `https://www.vinted.pl/api/v2/transactions/${txId}/actions/send_shipping_label`, body: null },
    { url: `https://www.vinted.pl/api/v2/shipments/${shipmentId}/send_label`, body: null },
    { url: `https://www.vinted.pl/api/v2/shipments/${shipmentId}/label`, body: null },
  ];

  for (const ep of postEndpoints) {
    const result = await tryPostJson(ep.url, ep.body);
    if (result.ok) {
      if (result.blob) return await blobToBase64(result.blob);
      if (result.data) {
        // The response might contain a URL to download the label
        const str = JSON.stringify(result.data);
        const urlMatch = str.match(/"(https?:[^"]*(?:label|pdf|download)[^"]*)"/i);
        if (urlMatch) {
          const pdfUrl = urlMatch[1].replace(/\\\//g, '/');
          const pdfResult = await tryFetchPdf(pdfUrl);
          if (pdfResult.ok && pdfResult.blob) return await blobToBase64(pdfResult.blob);
        }
      }
    }
  }

  // APPROACH 2: Try GET with shipment ID
  if (shipmentId) {
    const getUrls = [
      `https://www.vinted.pl/api/v2/shipments/${shipmentId}/label`,
      `https://www.vinted.pl/api/v2/shipments/${shipmentId}/parcel/label`,
      `https://www.vinted.pl/api/v2/transactions/${txId}/shipments/${shipmentId}/label`,
    ];
    for (const url of getUrls) {
      const result = await tryFetchPdf(url);
      if (result.ok && result.blob) return await blobToBase64(result.blob);
      if (result.ok && result.isJson && result.data) {
        const str = JSON.stringify(result.data);
        const urlMatch = str.match(/"(https?:[^"]*(?:label|pdf|download)[^"]*)"/i);
        if (urlMatch) {
          const pdfResult = await tryFetchPdf(urlMatch[1].replace(/\\\//g, '/'));
          if (pdfResult.ok && pdfResult.blob) return await blobToBase64(pdfResult.blob);
        }
      }
    }
  }

  // APPROACH 3: Try GET with transaction ID
  const txUrls = [
    `https://www.vinted.pl/api/v2/transactions/${txId}/shipment/label`,
    `https://www.vinted.pl/api/v2/transactions/${txId}/label`,
    `https://www.vinted.pl/api/v2/conversations/${convId}/shipment/label`,
  ];
  for (const url of txUrls) {
    const result = await tryFetchPdf(url);
    if (result.ok && result.blob) return await blobToBase64(result.blob);
  }

  // APPROACH 4: Try POST to get label URL from shipment
  const postPdfEndpoints = [
    `https://www.vinted.pl/api/v2/transactions/${txId}/shipment/label`,
    `https://www.vinted.pl/api/v2/transactions/${txId}/label`,
    `https://www.vinted.pl/api/v2/shipments/${shipmentId}/label`,
  ];
  for (const url of postPdfEndpoints) {
    const result = await tryFetchPdf(url, 'POST');
    if (result.ok && result.blob) return await blobToBase64(result.blob);
  }

  return { error: `Label not found. Please use Capture Mode.` };
}

async function runDiagnostics() {
  const results = [];

  const ordersResult = await tryFetchJson('https://www.vinted.pl/api/v2/my_orders?type=sold&page=1&per_page=5');
  if (!ordersResult.ok) {
    results.push({ type: 'error', msg: 'Cannot fetch orders' });
    return results;
  }

  const orders = ordersResult.data.my_orders || [];
  if (orders.length === 0) {
    results.push({ type: 'info', msg: 'No orders found' });
    return results;
  }

  const order = orders[0];
  const txId = order.transaction_id;
  const convId = order.conversation_id;
  results.push({ type: 'info', msg: `Order: tx=${txId} conv=${convId}` });

  const txResult = await tryFetchJson(`https://www.vinted.pl/api/v2/transactions/${txId}`);
  if (txResult.ok) {
    const tx = txResult.data.transaction || {};
    results.push({ type: 'info', msg: `available_actions: ${JSON.stringify(tx.available_actions)}` });

    const shipmentId = tx.shipment?.id;
    results.push({ type: 'info', msg: `Shipment ID: ${shipmentId}` });

    // Try send_shipping_label via POST
    results.push({ type: 'info', msg: `--- Trying POST endpoints ---` });
    const postUrls = [
      `/api/v2/transactions/${txId}/send_shipping_label`,
      `/api/v2/transactions/${txId}/shipping_label`,
      `/api/v2/transactions/${txId}/actions/send_shipping_label`,
      `/api/v2/shipments/${shipmentId}/send_label`,
      `/api/v2/shipments/${shipmentId}/label`,
      `/api/v2/transactions/${txId}/shipment/label`,
      `/api/v2/transactions/${txId}/label`,
    ];

    for (const path of postUrls) {
      const url = `https://www.vinted.pl${path}`;
      const result = await tryPostJson(url, null);
      let detail = `POST ${path} -> HTTP ${result.status}`;
      if (result.ok && result.data) {
        detail += ` DATA: ${JSON.stringify(result.data).substring(0, 400)}`;
      }
      if (result.ok && result.isPdf) {
        detail += ` [GOT PDF!]`;
      }
      if (result.text) {
        detail += ` TEXT: ${result.text.substring(0, 100)}`;
      }
      if (result.error) {
        detail += ` ERROR: ${result.error}`;
      }
      results.push({ type: result.ok ? 'success' : 'error', msg: detail });
    }

    // Also try GET with Accept: application/pdf
    results.push({ type: 'info', msg: `--- Trying GET endpoints ---` });
    const getUrls = [
      `/api/v2/shipments/${shipmentId}/label`,
      `/api/v2/transactions/${txId}/shipment/label`,
    ];
    for (const path of getUrls) {
      const url = `https://www.vinted.pl${path}`;
      const result = await tryFetchPdf(url);
      let detail = `GET ${path} -> ${result.ok ? 'OK' : 'FAIL'} ${result.status || ''}`;
      if (result.blob) detail += ` [GOT PDF! size=${result.blob.size}]`;
      if (result.isJson) detail += ` JSON: ${JSON.stringify(result.data).substring(0, 300)}`;
      results.push({ type: result.ok && result.blob ? 'success' : 'error', msg: detail });
    }
  }

  // Show captured requests
  if (window.__vintedCaptured && window.__vintedCaptured.length > 0) {
    results.push({ type: 'info', msg: `--- Captured requests: ${window.__vintedCaptured.length} ---` });
    for (const c of window.__vintedCaptured) {
      let detail = `[${c.type}] `;
      if (c.url) detail += `${c.method || ''} ${c.url} -> ${c.status || ''} (${c.contentType || ''})`;
      if (c.text) detail += ` "${c.text}"`;
      if (c.href) detail += ` href="${c.href}"`;
      if (c.blobType) detail += ` blob: ${c.blobType} (${c.blobSize} bytes)`;
      if (c.isPdf) detail += ' [PDF!]';
      results.push({ type: c.isPdf ? 'success' : 'info', msg: detail });
    }
  }

  return results;
}
