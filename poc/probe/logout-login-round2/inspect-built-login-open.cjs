// Read-only: extract the login/open handler region from the built background.js
// to verify what the browser is ACTUALLY running (not what src/ says).
const fs = require('node:fs');

const buf = fs.readFileSync('.output/chrome-mv3/background.js');
const s = buf.toString('utf8');

function show(label, needle) {
  const i = s.indexOf(needle);
  console.log('=== ' + label + ' ===');
  if (i < 0) {
    console.log('  NOT FOUND: ' + needle);
    return;
  }
  console.log('  index=' + i);
  console.log('  ...' + s.slice(Math.max(0, i - 400), i + 700) + '...');
  console.log('');
}

show('need-incognito.html reference', 'need-incognito.html');
show('incognito-disabled literal', 'incognito-disabled');

// Count occurrences of the explainer diag text (it is Chinese, may or may not
// survive minification as a literal).
for (const t of ['弹说明页', '权限未开启']) {
  const c = s.split(t).length - 1;
  console.log('literal "' + t + '" count = ' + c);
}
