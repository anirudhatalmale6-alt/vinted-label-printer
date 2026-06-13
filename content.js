chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getSoldOrders') {
    fetchSoldOrders().then(sendResponse);
    return true;
  }

  if (msg.action === 'downloadLabel') {
    downloadLabel(msg.transactionId).then(sendResponse);
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

  const cookies = document.cookie.split(';');
  for (const c of cookies) {
    const [name, val] = c.trim().split('=');
    if (name === '_vinted_fr_session' || name === 'csrf_token' || name === '_csrf_token') {
      return decodeURIComponent(val);
    }
  }

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
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (csrf) {
    headers['X-CSRF-Token'] = csrf;
    headers['x-csrf-token'] = csrf;
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
    const data = await resp.json();
    return { url, label, status, ok: true, data };
  } catch (err) {
    return { url, label, status: 0, ok: false, error: err.message, data: null };
  }
}

async function runDiagnostics() {
  const results = [];
  const csrf = getCsrfToken();
  results.push({ check: 'CSRF Token', value: csrf ? csrf.substring(0, 20) + '...' : 'NOT FOUND' });
  results.push({ check: 'Current URL', value: window.location.href });
  results.push({ check: 'Cookies present', value: document.cookie.length > 0 ? 'Yes' : 'No' });

  const endpoints = [
    { url: 'https://www.vinted.pl/api/v2/users/current', label: 'Current user' },
    { url: 'https://www.vinted.pl/api/v2/my_orders?type=sold&page=1&per_page=20', label: 'My orders (sold)' },
    { url: 'https://www.vinted.pl/api/v2/my_orders/sold?page=1&per_page=20', label: 'My orders/sold' },
    { url: 'https://www.vinted.pl/api/v2/transactions?page=1&per_page=20', label: 'Transactions' },
    { url: 'https://www.vinted.pl/api/v2/transactions?type=sold&page=1&per_page=20', label: 'Transactions (sold)' },
    { url: 'https://www.vinted.pl/api/v2/conversations?page=1&per_page=20', label: 'Conversations' },
  ];

  for (const ep of endpoints) {
    const result = await tryFetch(ep.url, ep.label);
    const summary = {
      check: `API: ${ep.label}`,
      url: ep.url,
      status: result.status,
      ok: result.ok,
    };
    if (result.ok && result.data) {
      const keys = Object.keys(result.data);
      summary.responseKeys = keys;
      if (result.data.user) summary.userId = result.data.user.id;
      for (const key of keys) {
        if (Array.isArray(result.data[key])) {
          summary[`${key}_count`] = result.data[key].length;
          if (result.data[key].length > 0) {
            summary[`${key}_first_keys`] = Object.keys(result.data[key][0]);
          }
        }
      }
    }
    if (result.error) summary.error = result.error;
    results.push(summary);
  }

  const userResult = results.find(r => r.userId);
  if (userResult) {
    const userId = userResult.userId;
    const userEndpoints = [
      { url: `https://www.vinted.pl/api/v2/users/${userId}/items?page=1&per_page=20&status=sold`, label: `User ${userId} sold items` },
      { url: `https://www.vinted.pl/api/v2/users/${userId}/sold_items?page=1&per_page=20`, label: `User ${userId} sold_items` },
    ];
    for (const ep of userEndpoints) {
      const result = await tryFetch(ep.url, ep.label);
      const summary = {
        check: `API: ${ep.label}`,
        url: ep.url,
        status: result.status,
        ok: result.ok,
      };
      if (result.ok && result.data) {
        const keys = Object.keys(result.data);
        summary.responseKeys = keys;
        for (const key of keys) {
          if (Array.isArray(result.data[key])) {
            summary[`${key}_count`] = result.data[key].length;
            if (result.data[key].length > 0) {
              summary[`${key}_first_keys`] = Object.keys(result.data[key][0]);
            }
          }
        }
      }
      if (result.error) summary.error = result.error;
      results.push(summary);
    }
  }

  // Also try scraping the page for order-related links/elements
  const pageInfo = {
    check: 'Page scrape',
    orderLinks: [],
    transactionLinks: [],
  };
  document.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (href && (href.includes('/transaction/') || href.includes('/order/'))) {
      pageInfo.orderLinks.push(href);
    }
    if (href && href.includes('/shipment')) {
      pageInfo.transactionLinks.push(href);
    }
  });
  pageInfo.orderLinksCount = pageInfo.orderLinks.length;
  pageInfo.transactionLinksCount = pageInfo.transactionLinks.length;
  results.push(pageInfo);

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
    const orders = [];

    const endpoints = [
      'https://www.vinted.pl/api/v2/my_orders?type=sold&page=1&per_page=50',
      'https://www.vinted.pl/api/v2/my_orders/sold?page=1&per_page=50',
      'https://www.vinted.pl/api/v2/transactions?type=sold&page=1&per_page=50',
      'https://www.vinted.pl/api/v2/transactions?page=1&per_page=50',
    ];

    for (const url of endpoints) {
      const result = await tryFetch(url, '');
      if (!result.ok || !result.data) continue;

      const data = result.data;
      const items = data.my_orders || data.transactions || data.orders || data.items || [];

      if (!Array.isArray(items) || items.length === 0) continue;

      for (const item of items) {
        const transaction = item.transaction || item;
        const title = transaction.item?.title || item.item?.title || item.title || transaction.title || '';
        const transactionId = transaction.id || item.id || item.transaction_id || '';

        if (!title || !transactionId) continue;

        const alreadyAdded = orders.some(o => o.transactionId === String(transactionId));
        if (alreadyAdded) continue;

        orders.push({
          title,
          transactionId: String(transactionId),
          labelUrl: `https://www.vinted.pl/api/v2/transactions/${transactionId}/shipment/label`,
          status: (transaction.status || item.status || '').toLowerCase(),
          createdAt: transaction.created_at || item.created_at || transaction.date || '',
        });
      }

      if (orders.length > 0) break;
    }

    // If API didn't work, try getting user ID and fetching their items
    if (orders.length === 0) {
      const userResp = await tryFetch('https://www.vinted.pl/api/v2/users/current', 'user');
      if (userResp.ok && userResp.data?.user?.id) {
        const userId = userResp.data.user.id;
        const userEndpoints = [
          `https://www.vinted.pl/api/v2/users/${userId}/items?status=sold&page=1&per_page=50`,
          `https://www.vinted.pl/api/v2/users/${userId}/sold_items?page=1&per_page=50`,
        ];
        for (const url of userEndpoints) {
          const result = await tryFetch(url, '');
          if (!result.ok || !result.data) continue;
          const items = result.data.items || result.data.sold_items || [];
          if (!Array.isArray(items) || items.length === 0) continue;

          for (const item of items) {
            const title = item.title || '';
            const transactionId = item.transaction_id || item.id || '';
            if (!title || !transactionId) continue;
            orders.push({
              title,
              transactionId: String(transactionId),
              labelUrl: `https://www.vinted.pl/api/v2/transactions/${transactionId}/shipment/label`,
              status: (item.status || '').toLowerCase(),
              createdAt: item.created_at || '',
            });
          }
          if (orders.length > 0) break;
        }
      }
    }

    return { orders, endpoint_used: orders.length > 0 ? 'found' : 'none_worked' };
  } catch (err) {
    return { orders: [], error: err.message };
  }
}

async function downloadLabel(transactionId) {
  try {
    const resp = await fetch(
      `https://www.vinted.pl/api/v2/transactions/${transactionId}/shipment/label`,
      {
        credentials: 'include',
        headers: {
          ...getAuthHeaders(),
          'Accept': 'application/pdf, */*'
        }
      }
    );

    if (!resp.ok) {
      return { error: `HTTP ${resp.status}` };
    }

    const blob = await resp.blob();
    const reader = new FileReader();

    return new Promise((resolve) => {
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve({ pdfBase64: base64 });
      };
      reader.onerror = () => resolve({ error: 'Failed to read PDF' });
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    return { error: err.message };
  }
}
