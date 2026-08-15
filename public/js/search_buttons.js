const fs = require('fs');
const data = fs.readFileSync('bundle.js', 'utf8');

const texts = ["I've Paid", "Continue to UPI"];
texts.forEach(t => {
  const idx = data.indexOf(t);
  if (idx !== -1) {
    console.log('Found', t, ':\n', data.substring(Math.max(0, idx - 200), idx + 200));
  } else {
    console.log('Not found', t);
  }
});
