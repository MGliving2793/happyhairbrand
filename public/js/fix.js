const fs = require('fs');
let content = fs.readFileSync('bundle.js', 'utf8');

const target = `    } finally {
      return null;
    }
  };
    "x-dynamic": "false",`;

const replacement = `    } finally {
      setBusy(false);
    }
  };
  return /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_8__.jsxDEV)("section", {
    "x-dynamic": "false",`;

content = content.replace(target, replacement);
fs.writeFileSync('bundle.js', content, 'utf8');
console.log('Syntax fix applied!');
