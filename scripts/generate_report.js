'use strict';
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'build', 'report_data.json');
const TEMPLATE_PATH = path.join(PROJECT_ROOT, 'reporte_implementacion.tex');

// Read data
console.log('Reading report data...');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));

// Read template
console.log('Reading LaTeX template...');
let tex = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

// LaTeX sanitization for text values (NOT for code in lstlisting)
function sanitizeLatex(str) {
  if (typeof str !== 'string') str = String(str);
  return str
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&{}_])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

// For numeric values, no sanitization needed
function num(val) {
  return String(val || 0);
}

// Build replacement map — keys match EXACTLY the placeholders in reporte_implementacion.tex
const replacements = {
  '%%TOTAL_COMMITS%%': num(data.git.totalCommits),
  '%%TOTAL_TASKS%%': '17',
  '%%TOTAL_TESTS%%': num(data.tests.totalPassed),
  '%%RENDERER_HTML_LINES%%': num(data.files.rendererHtml),
  '%%RENDERER_CSS_LINES%%': num(data.files.rendererCss),
  '%%RENDERER_JS_LINES%%': num(data.files.rendererJs),
  '%%CSP_CURRENT%%': sanitizeLatex(data.security.csp || "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"),
  '%%LINT_ERRORS%%': num(data.lint.errors),
  '%%LINT_WARNINGS%%': num(data.lint.warnings),
  '%%WM_TESTS%%': num(data.tests.byFile['window-manager']),
  '%%PERSIST_TESTS%%': num(data.tests.byFile['persistence']),
  '%%IR_TESTS%%': num(data.tests.byFile['instance-registry']),
  '%%UI_TESTS%%': num(data.tests.byFile['renderer-ui']),
  '%%METRIC_SRC_FILES%%': '11',
  '%%METRIC_SRC_LINES%%': num(data.files.totalSrc),
};

// Apply replacements
console.log('Applying replacements...');
let replacementCount = 0;
for (const [placeholder, value] of Object.entries(replacements)) {
  const regex = new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const matches = tex.match(regex);
  if (matches) {
    replacementCount += matches.length;
    tex = tex.replace(regex, value);
  } else {
    console.warn(`  Warning: placeholder ${placeholder} not found in template`);
  }
}

// Check for unreplaced placeholders
const remaining = tex.match(/%%[A-Z_]+%%/g);
if (remaining) {
  console.warn(`\nWarning: ${remaining.length} unreplaced placeholders found:`);
  const unique = [...new Set(remaining)];
  unique.forEach(p => console.warn(`  - ${p}`));
} else {
  console.log('  All placeholders replaced successfully!');
}

// Write final file
fs.writeFileSync(TEMPLATE_PATH, tex);
console.log(`\n✓ Report generated: ${TEMPLATE_PATH}`);
console.log(`  ${replacementCount} replacements made`);
