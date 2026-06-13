// This script runs in the PAGE context (not content script isolation)
// It intercepts window.open and URL.createObjectURL to capture blob PDFs

(function() {
  const origOpen = window.open;
  const origCreateObjectURL = URL.createObjectURL;

  // Intercept URL.createObjectURL to track blob creation
  URL.createObjectURL = function(blob) {
    const url = origCreateObjectURL.call(URL, blob);

    if (blob && (blob.type === 'application/pdf' || blob.size > 1000)) {
      // Read the blob and send to content script
      const reader = new FileReader();
      reader.onload = function() {
        window.postMessage({
          type: 'VINTED_LABEL_BLOB',
          blobType: blob.type,
          blobSize: blob.size,
          blobUrl: url,
          dataUrl: reader.result,
        }, '*');
      };
      reader.readAsDataURL(blob);
    }
    return url;
  };

  // Intercept window.open to capture what URL is opened
  window.open = function(url, ...args) {
    window.postMessage({
      type: 'VINTED_LABEL_WINDOW_OPEN',
      url: String(url || ''),
    }, '*');

    // If it's a blob URL, try to fetch and capture the blob content
    if (url && String(url).startsWith('blob:')) {
      fetch(url)
        .then(resp => resp.blob())
        .then(blob => {
          const reader = new FileReader();
          reader.onload = function() {
            window.postMessage({
              type: 'VINTED_LABEL_BLOB_CAPTURED',
              blobUrl: String(url),
              blobType: blob.type,
              blobSize: blob.size,
              dataUrl: reader.result,
            }, '*');
          };
          reader.readAsDataURL(blob);
        })
        .catch(() => {});
    }

    return origOpen.apply(this, [url, ...args]);
  };

  // Also intercept dynamic <a> click-to-download
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function() {
    if (this.href && (this.href.startsWith('blob:') || this.download)) {
      window.postMessage({
        type: 'VINTED_LABEL_LINK_CLICK',
        href: this.href,
        download: this.download,
      }, '*');

      if (this.href.startsWith('blob:')) {
        fetch(this.href)
          .then(resp => resp.blob())
          .then(blob => {
            const reader = new FileReader();
            reader.onload = function() {
              window.postMessage({
                type: 'VINTED_LABEL_BLOB_CAPTURED',
                blobUrl: this.href,
                blobType: blob.type,
                blobSize: blob.size,
                dataUrl: reader.result,
              }, '*');
            };
            reader.readAsDataURL(blob);
          })
          .catch(() => {});
      }
    }
    return origClick.call(this);
  };
})();
