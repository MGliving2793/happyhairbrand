const fs = require('fs');
const data = fs.readFileSync('bundle.js', 'utf8');
const matches = data.match(/https?:\/\/[a-zA-Z0-9.-]+(?:[a-zA-Z0-9./_-]+)?/g) || [];
const unique = [...new Set(matches)];
console.log("Potential API URLs:");
unique.filter(u => 
  !u.includes('react') && 
  !u.includes('w3.org') && 
  !u.includes('github') && 
  !u.includes('schema.org') && 
  !u.includes('google') &&
  !u.includes('tailwindcss') &&
  !u.includes('cloudflare') &&
  !u.includes('posthog') &&
  !u.includes('emergentagent')
).forEach(u => console.log(u));
