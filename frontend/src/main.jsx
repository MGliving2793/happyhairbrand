import React from 'react'
import { createRoot } from 'react-dom/client'
import Checkout from './Checkout.jsx'
import TrackingBanner from './TrackingBanner.jsx'
import InstagramWidget from './InstagramWidget.jsx'

// Create a mount point if it doesn't exist
let mountNode = document.getElementById('advanced-checkout-root');
if (!mountNode) {
  mountNode = document.createElement('div');
  mountNode.id = 'advanced-checkout-root';
  document.body.appendChild(mountNode);
}

const root = createRoot(mountNode);

let renderCheckout = (isOpen, initialProduct) => {
  root.render(
    <React.StrictMode>
      <TrackingBanner />
      <InstagramWidget />
      <Checkout isOpen={isOpen} initialProduct={initialProduct} onClose={() => renderCheckout(false, null)} />
    </React.StrictMode>
  );
};

// Initially render it closed
renderCheckout(false, null);

// Expose it globally so the click interceptor can open it!
window.openProductCheckout = (id, title, price, image) => {
  renderCheckout(true, { id, title, price, image });
};

// Set up the click interceptor
document.addEventListener('click', function(e) {
  const btn = e.target.closest('button, a, [role="button"]');
  if (btn) {
    // Don't intercept buttons inside our own modal
    if (btn.closest('.dyn-checkout-modal')) return;
    
    const text = btn.textContent.trim().toLowerCase();
    const testId = btn.getAttribute('data-testid') || '';
    const hasCartIcon = btn.classList.contains('cart-icon') || btn.querySelector('svg') !== null;
    
    if (
      text.includes('buy') || text.includes('shop') || text.includes('order') || text.includes('get ') || text.includes('checkout') ||
      testId.includes('shop') || testId.includes('checkout') || hasCartIcon ||
      ((btn.tagName === 'BUTTON' || btn.getAttribute('role') === 'button') && !text)
    ) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      
      window.openProductCheckout(1, 'Happy Hair – Instant Seeds Powder Mix', 699, '/images/w0ut7ai7_WhatsApp%20Image%202026-06-23%20at%2010.55.35%20AM.jpeg');
    }
  }
}, true); // Capture phase

// Ultimate Fallback: MutationObserver to block the React Modal if the click interceptor misses it
const observer = new MutationObserver((mutations) => {
  for (let m of mutations) {
    if (m.addedNodes) {
      m.addedNodes.forEach(node => {
        if (node.nodeType === 1) {
          if (node.getAttribute('data-testid') === 'checkout-dialog' || node.querySelector('[data-testid="checkout-dialog"]')) {
            // Hide the old modal
            const dialog = node.getAttribute('data-testid') === 'checkout-dialog' ? node : node.querySelector('[data-testid="checkout-dialog"]');
            if (dialog) dialog.style.display = 'none';
            
            // Open the new React modal
            window.openProductCheckout(1, 'Happy Hair – Instant Seeds Powder Mix', 699, '/images/w0ut7ai7_WhatsApp%20Image%202026-06-23%20at%2010.55.35%20AM.jpeg');
          }
        }
      });
    }
  }
});
observer.observe(document.body, { childList: true, subtree: true });
