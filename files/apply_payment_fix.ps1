# Backup and apply payment integration fixes
# Usage: Run this PowerShell script from your machine with repo checked out.
# It will backup files and overwrite them with the fixed versions, then show git commands to run.

$root = "C:\Users\HP\Documents\final web"
$timestamp = Get-Date -Format "yyyyMMddHHmmss"

# Files to backup and replace
$files = @(
    "public\js\product-sync.js",
    "frontend\src\Checkout.jsx",
    "server\.env"
)

foreach ($f in $files) {
    $src = Join-Path $root $f
    if (Test-Path $src) {
        $bak = "$src.$timestamp.bak"
        Copy-Item -Path $src -Destination $bak -Force
        Write-Host "Backed up $src -> $bak"
    } else {
        Write-Host "File not found (will create): $src"
    }
}

# Overwrite product-sync.js
$prodSyncPath = Join-Path $root "public\js\product-sync.js"
$prodSyncContent = @'
(function() {
  const API_BASE = '';

  // Inject modal styles
  const style = document.createElement('style');
  style.textContent = `
    .dynamic-prod-card {
      background: #152718;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 18px;
      color: #fff;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: all 0.3s ease;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    }
    .dynamic-prod-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 30px rgba(201, 147, 57, 0.2);
      border-color: #c99339;
    }
    .dynamic-prod-img {
      width: 100%;
      height: 220px;
      object-fit: cover;
      border-radius: 12px;
      margin-bottom: 14px;
      background: #0d1a0e;
    }
    .dynamic-prod-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: #f5f5f5;
      margin-bottom: 8px;
      line-height: 1.3;
    }
    .dynamic-prod-price {
      font-size: 1.25rem;
      font-weight: 700;
      color: #c99339;
      margin-bottom: 14px;
    }
    .dynamic-buy-btn {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #c99339 0%, #a67323 100%);
      color: #ffffff;
      border: none;
      border-radius: 25px;
      font-weight: 700;
      font-size: 0.95rem;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      transition: all 0.2s ease;
    }
    .dynamic-buy-btn:hover {
      background: linear-gradient(135deg, #dba446 0%, #b8822d 100%);
      box-shadow: 0 4px 15px rgba(201, 147, 57, 0.4);
    }
    
    /* Universal Checkout Modal */
    #dyn-checkout-modal {
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.85);
      backdrop-filter: blur(8px);
      z-index: 999999;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 15px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
    }
    #dyn-checkout-modal.open {
      opacity: 1;
      pointer-events: auto;
    }
    .dyn-modal-card {
      background: #0f1c10;
      border: 1px solid #c99339;
      border-radius: 20px;
      width: 100%;
      max-width: 450px;
      padding: 24px;
      color: #fff;
      position: relative;
      box-shadow: 0 20px 50px rgba(0,0,0,0.8);
      max-height: 90vh;
      overflow-y: auto;
    }
    .dyn-close-btn {
      position: absolute;
      top: 15px; right: 15px;
      background: none; border: none;
      color: #aaa; font-size: 24px; cursor: pointer;
    }
    .dyn-close-btn:hover { color: #fff; }
    .dyn-form-group { margin-bottom: 12px; }
    .dyn-form-group label { display: block; font-size: 12px; color: #ccc; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .dyn-form-group input, .dyn-form-group select {
      width: 100%; padding: 10px 12px; background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; color: #fff; font-size: 14px; box-sizing: border-box;
    }
    .dyn-form-group input:focus, .dyn-form-group select:focus {
      border-color: #c99339; outline: none;
    }

    @media (max-width: 600px) {
      .dynamic-prod-card {
        width: 100%;
        margin: 0 auto;
      }
      #dynamic-products-showcase {
        padding: 0 15px !important;
      }
      #dynamic-products-grid {
        grid-template-columns: 1fr !important;
        gap: 16px !important;
      }
      .dyn-modal-card {
        padding: 20px 15px;
      }
    }
  `;
  document.head.appendChild(style);

  // Render Modal HTML
  const modalDiv = document.createElement('div');
  modalDiv.id = 'dyn-checkout-modal';
  modalDiv.innerHTML = `
    <div class="dyn-modal-card">
      <button class="dyn-close-btn" onclick="closeDynCheckout()">&times;</button>
      <h3 style="color:#c99339; margin-top:0; font-size: 1.3rem; margin-bottom: 4px;">Complete Your Order</h3>
      <p id="dyn-modal-prod-summary" style="font-size:13px; color:#aaa; margin-bottom: 16px;"></p>
      
      <form id="dyn-checkout-form">
        <input type="hidden" id="dyn-prod-id">
        <input type="hidden" id="dyn-prod-title">
        <input type="hidden" id="dyn-prod-price">
        
        <div class="dyn-form-group">
          <label>Full Name</label>
          <input type="text" id="dyn-name" placeholder="John Doe">
          <div class="dyn-error" id="err-dyn-name" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
        </div>
        <div class="dyn-form-group">
          <label>Mobile Number</label>
          <input type="tel" id="dyn-phone" placeholder="9876543210">
          <div class="dyn-error" id="err-dyn-phone" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
        </div>
        <div class="dyn-form-group">
          <label>Email Address</label>
          <input type="email" id="dyn-email" placeholder="john@example.com">
          <div class="dyn-error" id="err-dyn-email" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
        </div>
        <div class="dyn-form-group">
          <label>Delivery Address</label>
          <input type="text" id="dyn-address" placeholder="House No, Building, Street Area">
          <div class="dyn-error" id="err-dyn-address" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
        </div>
        <div style="display:flex; gap:10px;">
          <div class="dyn-form-group" style="flex:1;">
            <label>City</label>
            <input type="text" id="dyn-city" placeholder="Mumbai">
            <div class="dyn-error" id="err-dyn-city" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
          </div>
          <div class="dyn-form-group" style="flex:1;">
            <label>Pincode</label>
            <input type="text" id="dyn-pincode" placeholder="400001">
            <div class="dyn-error" id="err-dyn-pincode" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
          </div>
        </div>
        <div class="dyn-form-group">
          <label>State</label>
          <input type="text" id="dyn-state" placeholder="Maharashtra">
          <div class="dyn-error" id="err-dyn-state" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
        </div>
        <div class="dyn-form-group">
          <label>Payment Method <span id="dyn-pay-discount-text" style="color:#2ecc71;font-size:10px;display:none;">(₹10 OFF applied)</span></label>
          <select id="dyn-paymode" onchange="calculateDynTotal()">
            <option value="PREPAID">UPI / Online Payment (Fast Delivery)</option>
            <option value="COD">Cash on Delivery (COD)</option>
          </select>
        </div>
        
        <div style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; margin-bottom: 15px; border: 1px solid rgba(255,255,255,0.05);">
          <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:13px; color:#aaa;">
            <span>Subtotal:</span>
            <span id="dyn-summary-subtotal">₹0</span>
          </div>
          <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:13px; color:#2ecc71;">
            <span>Delivery:</span>
            <span>FREE</span>
          </div>
          <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:13px; color:#2ecc71;" id="dyn-summary-prepaid">
            <span>Prepaid Discount:</span>
            <span>-₹10</span>
          </div>

[TRUNCATED FOR BREVITY]