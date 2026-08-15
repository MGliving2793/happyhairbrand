const fs = require('fs');

const filePath = 'bundle.js';
let content = fs.readFileSync(filePath, 'utf8');

const target = `        }, this), /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_12__.jsxDEV)(react_router_dom__WEBPACK_IMPORTED_MODULE_1__.Link, {
          to: "/",
          className: "btn-outline-green rounded-full px-6 py-3 text-sm font-semibold inline-flex items-center justify-center gap-2",
          children: [/*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_12__.jsxDEV)(lucide_react__WEBPACK_IMPORTED_MODULE_5__["default"], {`;

const replacement = `        }, this), /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_12__.jsxDEV)("a", {
          href: "http://127.0.0.1:3000/api/orders/status/" + orderId,
          className: "btn-primary rounded-full px-6 py-3 text-sm font-semibold inline-flex items-center justify-center gap-2",
          style: { backgroundColor: "#1a361d", color: "white", marginRight: "10px" },
          children: "Track Order"
        }, void 0, false, {
          fileName: _jsxFileName,
          lineNumber: 76,
          columnNumber: 11
        }, this), /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_12__.jsxDEV)(react_router_dom__WEBPACK_IMPORTED_MODULE_1__.Link, {
          to: "/",
          className: "btn-outline-green rounded-full px-6 py-3 text-sm font-semibold inline-flex items-center justify-center gap-2",
          children: [/*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_12__.jsxDEV)(lucide_react__WEBPACK_IMPORTED_MODULE_5__["default"], {`;

if (content.includes(target)) {
  content = content.replace(target, replacement);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Successfully added Track Order button');
} else {
  console.log('Target string not found in bundle.js');
}
