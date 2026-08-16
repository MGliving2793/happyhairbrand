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

let defaultProduct = { id: 1, title: 'Happy Hair – Instant Seeds Powder Mix', price: 699, image_url: '/images/w0ut7ai7_WhatsApp%20Image%202026-06-23%20at%2010.55.35%20AM.jpeg' };
fetch('/api/products')
  .then(res => res.json())
  .then(data => {
      if (data.products && data.products.length > 0) {
          defaultProduct = data.products[0];
      }
  })
  .catch(console.error);

// Set up the click interceptor
document.addEventListener('click', function(e) {
  const btn = e.target.closest('button, a, [role="button"]');
  if (btn) {
    // Don't intercept buttons inside our own injected react root (modal, widgets, banners)
    if (btn.closest('#advanced-checkout-root')) return;
    
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
      
      window.openProductCheckout(defaultProduct.id, defaultProduct.title, defaultProduct.price, defaultProduct.image_url);
    }
  }
}, true); // Capture phase

// Optimized Promo Hider & Checkout Blocker
const hideAnnoyances = () => {
  // Hide promos
  document.querySelectorAll('section').forEach(sec => {
      if (sec.innerText && (sec.innerText.includes('HAIR100') || sec.innerText.includes('Give ₹100 off'))) {
          sec.style.display = 'none';
      }
  });
  // Block old checkout dialogs
  document.querySelectorAll('[data-testid="checkout-dialog"]').forEach(dialog => {
      if (dialog.style.display !== 'none') {
          dialog.style.display = 'none';
          window.openProductCheckout(defaultProduct.id, defaultProduct.title, defaultProduct.price, defaultProduct.image_url);
      }
  });
};

hideAnnoyances();
const observer = new MutationObserver(() => hideAnnoyances());
observer.observe(document.body, { childList: true, subtree: true });

// Safely disconnect the observer after 10 seconds to save performance, 
// assuming the page has fully rendered the dynamic content by then.
setTimeout(() => observer.disconnect(), 10000);
