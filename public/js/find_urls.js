const fs = require('fs');
const data = fs.readFileSync('bundle.js', 'utf8');
const matches = data.match(/https?:\/\/[^\s\"'`]+/g) || [];
const unique = [...new Set(matches)];
console.log("URLs found in bundle.js:");
unique.filter(u => !u.includes('react') && !u.includes('w3.org') && !u.includes('github') && !u.includes('schema.org') && !u.includes('google')).forEach(u => console.log(u));
