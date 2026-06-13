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

  if (msg.action === 'findDownloadButton') {
    findLabelButton().then(sendResponse);
    return true;
  }
});

function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta) return meta.getAttribute('content');
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

async function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ pdfBase64: reader.result.split(',')[1] });
    reader.onerror = () => resolve({ error: 'Failed to read blob' });
    reader.readAsDataURL(blob);
  });
}

// NETWORK CAPTURE: Override fetch to capture all requests/responses
function startNetworkCapture() {
  if (window.__vintedCaptureActive) return;
  window.__vintedCaptureActive = true;
  window.__vintedCaptured = [];

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const opts = args[1] || {};

    const resp = await origFetch.apply(this, args);

    // Capture everything that's not an image
    if (!url.includes('images1.vinted.net') && !url.includes('.jpeg') && !url.includes('.png')) {
      const ct = resp.headers.get('content-type') || '';
      const entry = {
        url,
        method: opts.method || 'GET',
        status: resp.status,
        contentType: ct,
        headers: Object.fromEntries(resp.headers.entries()),
        time: new Date().toISOString(),
      };

      // If it's a PDF or octet-stream, mark it
      if (ct.includes('pdf') || ct.includes('octet-stream')) {
        entry.isPdf = true;
        entry.size = resp.headers.get('content-length');
      }

      window.__vintedCaptured.push(entry);

      // Also send to extension immediately if it looks like a label
      if (entry.isPdf || url.includes('label') || url.includes('shipment') || url.includes('parcel')) {
        chrome.runtime.sendMessage({
          action: 'capturedRequest',
          entry
        });
      }
    }

    return resp;
  };

  // Also capture XMLHttpRequest
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
        const entry = {
          url,
          method: this.__captureMethod || 'GET',
          status: this.status,
          contentType: ct,
          time: new Date().toISOString(),
          viaXHR: true,
        };
        if (ct.includes('pdf') || ct.includes('octet-stream')) {
          entry.isPdf = true;
        }
        window.__vintedCaptured.push(entry);

        if (entry.isPdf || url.includes('label') || url.includes('shipment') || url.includes('parcel')) {
          chrome.runtime.sendMessage({ action: 'capturedRequest', entry });
        }
      }
    });
    return origSend.apply(this, args);
  };

  // Monitor link clicks and downloads
  document.addEventListener('click', function(e) {
    const target = e.target.closest('a, button, [role="button"]');
    if (target) {
      const text = (target.textContent || '').toLowerCase();
      const href = target.getAttribute('href') || '';
      if (text.includes('etykiet') || text.includes('label') || text.includes('pobierz') ||
          text.includes('download') || text.includes('paczk') || text.includes('nadaj') ||
          href.includes('label') || href.includes('shipment')) {
        window.__vintedCaptured.push({
          type: 'click',
          tagName: target.tagName,
          text: target.textContent.trim().substring(0, 100),
          href: href,
          className: target.className,
          time: new Date().toISOString(),
        });
        chrome.runtime.sendMessage({
          action: 'capturedClick',
          text: target.textContent.trim().substring(0, 100),
          href: href,
          className: target.className,
        });
      }
    }
  }, true);
}

// Find the download button on the page
async function findLabelButton() {
  const results = [];

  // Search for all buttons and links
  const allClickable = document.querySelectorAll('a, button, [role="button"], [role="link"]');
  const keywords = ['etykiet', 'label', 'pobierz', 'download', 'paczk', 'nadaj', 'wyślij', 'wysłij', 'shipping', 'wydruk', 'druk', 'print'];

  for (const el of allClickable) {
    const text = (el.textContent || '').toLowerCase().trim();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const href = el.getAttribute('href') || '';
    const dataTestId = el.getAttribute('data-testid') || '';

    const allText = text + ' ' + ariaLabel + ' ' + title + ' ' + href + ' ' + dataTestId;

    if (keywords.some(kw => allText.includes(kw))) {
      results.push({
        tag: el.tagName,
        text: text.substring(0, 100),
        href: href,
        ariaLabel: ariaLabel,
        title: title,
        dataTestId: dataTestId,
        className: (el.className || '').toString().substring(0, 100),
        id: el.id || '',
        outerHTML: el.outerHTML.substring(0, 300),
      });
    }
  }

  // Also search for any element with "etykiet" in any attribute
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    for (const attr of el.attributes) {
      if (keywords.some(kw => attr.value.toLowerCase().includes(kw))) {
        results.push({
          tag: el.tagName,
          attr: `${attr.name}="${attr.value}"`,
          text: (el.textContent || '').trim().substring(0, 50),
          outerHTML: el.outerHTML.substring(0, 300),
          viaAttr: true,
        });
        break;
      }
    }
  }

  return { buttons: results, totalClickable: allClickable.length };
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
        availableActions: txResult.ok ? txResult.data?.transaction?.available_actions : null,
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

  // Check if we have a captured label URL pattern stored
  const stored = await new Promise(r => chrome.storage.local.get('labelUrlPattern', r));
  if (stored.labelUrlPattern) {
    const url = stored.labelUrlPattern
      .replace('{txId}', txId)
      .replace('{shipmentId}', shipmentId)
      .replace('{convId}', convId);
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Accept': 'application/pdf, */*' }
      });
      if (resp.ok) {
        const blob = await resp.blob();
        if (blob.size > 100) return await blobToBase64(blob);
      }
    } catch {}
  }

  // Try all known URL patterns
  const urls = [];
  if (shipmentId) {
    urls.push(
      `https://www.vinted.pl/api/v2/shipments/${shipmentId}/label`,
      `https://www.vinted.pl/api/v2/shipments/${shipmentId}/parcel/label`,
      `https://www.vinted.pl/api/v2/shipments/${shipmentId}/download`,
      `https://www.vinted.pl/api/v2/transactions/${txId}/shipments/${shipmentId}/label`,
    );
  }
  urls.push(
    `https://www.vinted.pl/api/v2/transactions/${txId}/shipment/label`,
    `https://www.vinted.pl/api/v2/transactions/${txId}/label`,
    `https://www.vinted.pl/api/v2/conversations/${convId}/shipment/label`,
  );

  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Accept': 'application/pdf, application/octet-stream, */*' }
      });
      if (resp.ok) {
        const blob = await resp.blob();
        if (blob.size > 100) return await blobToBase64(blob);
      }
    } catch {}
  }

  return { error: `Label not found. Use Capture Mode to discover the download URL.` };
}

async function runDiagnostics() {
  const results = [];

  // Get first order's transaction details - focus on available_actions and order fields
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

  // Full transaction data
  const txResult = await tryFetchJson(`https://www.vinted.pl/api/v2/transactions/${txId}`);
  if (txResult.ok) {
    const tx = txResult.data.transaction || {};

    // Show available_actions
    results.push({ type: 'info', msg: `available_actions: ${JSON.stringify(tx.available_actions)}` });
    results.push({ type: 'info', msg: `order field: ${JSON.stringify(tx.order)}` });

    // Show full transaction JSON (in chunks)
    const fullTx = JSON.stringify(txResult.data);
    for (let i = 0; i < Math.min(fullTx.length, 5000); i += 500) {
      results.push({ type: 'info', msg: `TX[${i}]: ${fullTx.substring(i, i + 500)}` });
    }
  }

  // Check captured requests
  if (window.__vintedCaptured && window.__vintedCaptured.length > 0) {
    results.push({ type: 'success', msg: `Captured ${window.__vintedCaptured.length} requests` });
    for (const c of window.__vintedCaptured) {
      results.push({ type: c.isPdf ? 'success' : 'info', msg: `Captured: ${c.method || ''} ${c.url || c.text || ''} -> ${c.status || ''} (${c.contentType || c.type || ''})` });
    }
  }

  // Find buttons on the page
  const btnResult = await findLabelButton();
  results.push({ type: 'info', msg: `Found ${btnResult.buttons.length} label-related elements (${btnResult.totalClickable} total clickable)` });
  for (const btn of btnResult.buttons.slice(0, 10)) {
    results.push({ type: 'success', msg: `Button: <${btn.tag}> "${btn.text}" href="${btn.href}" class="${btn.className}" ${btn.dataTestId ? 'testid=' + btn.dataTestId : ''} ${btn.attr || ''}` });
    results.push({ type: 'info', msg: `  HTML: ${btn.outerHTML}` });
  }

  return results;
}
