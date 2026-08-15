const fs = require('fs');
let data = fs.readFileSync('bundle.js', 'utf8');

const target1 = 'className: "mt-6 w-full btn-primary rounded-full h-12 text-sm font-semibold",';
const target2 = 'className: "mt-3 w-full inline-flex items-center justify-center gap-2 rounded-full h-11 text-xs font-semibold btn-outline-green",';

const replacement1 = 'className: "mt-6 w-full btn-primary rounded-full h-12 text-sm font-semibold" + (upiStage ? " hidden" : ""),';
const replacement2 = 'className: "mt-3 w-full inline-flex items-center justify-center gap-2 rounded-full h-11 text-xs font-semibold btn-outline-green" + (upiStage ? " hidden" : ""),';

data = data.replace(target1, replacement1);
data = data.replace(target2, replacement2);

fs.writeFileSync('bundle.js', data);
console.log('Replaced successfully.');
