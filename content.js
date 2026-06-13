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
});

async function checkAuthentication() {
  try {
    const resp = await fetch('https://www.vinted.pl/api/v2/users/current', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    if (resp.ok) {
      const data = await resp.json();
      return { authenticated: true, username: data.user?.login || 'unknown' };
    }
    return { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

async function fetchSoldOrders() {
  try {
    const endpoints = [
      '/api/v2/my_orders/sold?page=1&per_page=50',
      '/api/v2/transactions?type=sold&page=1&per_page=50'
    ];

    for (const endpoint of endpoints) {
      try {
        const resp = await fetch(`https://www.vinted.pl${endpoint}`, {
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });

        if (!resp.ok) continue;

        const data = await resp.json();
        return parseOrders(data);
      } catch {
        continue;
      }
    }

    return { orders: [], error: 'Could not fetch orders from any API endpoint' };
  } catch (err) {
    return { orders: [], error: err.message };
  }
}

function parseOrders(data) {
  const orders = [];
  const today = new Date().toISOString().split('T')[0];
  const items = data.my_orders || data.transactions || data.items || [];

  for (const item of items) {
    const transaction = item.transaction || item;
    const status = (transaction.status || item.status || '').toLowerCase();

    const hasLabel = ['sold', 'shipped', 'label_ready', 'shipping_label_ready',
                      'debit_processed', 'payment_processed'].some(s => status.includes(s));

    if (!hasLabel) continue;

    const title = transaction.item?.title || item.item?.title || item.title || '';
    const transactionId = transaction.id || item.id || '';
    const createdAt = transaction.created_at || transaction.date || '';

    if (!title || !transactionId) continue;

    orders.push({
      title,
      transactionId: String(transactionId),
      labelUrl: `https://www.vinted.pl/api/v2/transactions/${transactionId}/shipment/label`,
      status,
      createdAt,
      isToday: createdAt.startsWith(today)
    });
  }

  return { orders };
}

async function downloadLabel(transactionId) {
  try {
    const resp = await fetch(
      `https://www.vinted.pl/api/v2/transactions/${transactionId}/shipment/label`,
      {
        credentials: 'include',
        headers: { 'Accept': 'application/pdf' }
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
