const fs = require('fs');

const bundlePath = 'bundle.js';
let bundleCode = fs.readFileSync(bundlePath, 'utf8');

const regex = /if\s*\(form\.payment_method\s*===\s*"upi"\)\s*\{\s*\/\/\s*Stage 1.*?setUpiStage\(\{.*?orderId:\s*data\.order_id.*?\}\);\s*return;\s*\}/s;

const replacement = `if (form.payment_method === "upi" || form.payment_method === "online") {
        const data = await placeOrder();
        if (data.checkout_url) {
          window.location.href = data.checkout_url;
          return;
        }
        sonner__WEBPACK_IMPORTED_MODULE_14__.toast.error("Payment setup is incomplete. Missing checkout URL.");
        return;
      }`;

if (regex.test(bundleCode)) {
  bundleCode = bundleCode.replace(regex, replacement);
  fs.writeFileSync(bundlePath, bundleCode);
  console.log("Successfully patched bundle.js");
} else {
  console.log("Could not match the regex pattern in bundle.js");
}
