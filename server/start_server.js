const { execSync } = require('child_process');
try {
  execSync('powershell -Command "Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"');
} catch (e) {}

require('./src/index.js');
