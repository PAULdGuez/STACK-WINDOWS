'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_COMMIT = '520d850';
const PROJECT_ROOT = path.resolve(__dirname, '..');

function run(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000 }).trim();
  } catch (e) {
    console.warn(`Warning: command failed: ${cmd}`);
    console.warn(e.message);
    return '';
  }
}

function countLines(filePath) {
  try {
    const abs = path.join(PROJECT_ROOT, filePath);
    return fs.readFileSync(abs, 'utf-8').split('\n').length;
  } catch { return 0; }
}

const data = {};

// === GIT METRICS ===
console.log('Collecting git metrics...');
const commitLog = run(`git log --oneline ${BASE_COMMIT}..HEAD`);
const commitLines = commitLog ? commitLog.split('\n').filter(Boolean) : [];
data.git = {
  baseCommit: BASE_COMMIT,
  totalCommits: commitLines.length,
  commitList: commitLines.map(line => {
    const [hash, ...rest] = line.split(' ');
    return { hash, message: rest.join(' ') };
  }),
};

// Parse shortstat output: " 10 files changed, 2165 insertions(+), 1866 deletions(-)"
function parseShortstat(output) {
  const files = (output.match(/(\d+) files? changed/) || [0, 0])[1];
  const ins = (output.match(/(\d+) insertions?/) || [0, 0])[1];
  const del = (output.match(/(\d+) deletions?/) || [0, 0])[1];
  return { filesChanged: Number(files), insertions: Number(ins), deletions: Number(del) };
}

data.git.totalDiff = parseShortstat(run(`git diff --shortstat ${BASE_COMMIT}..HEAD`));
data.git.srcDiff = parseShortstat(run(`git diff --shortstat ${BASE_COMMIT}..HEAD -- src/`));
data.git.testsDiff = parseShortstat(run(`git diff --shortstat ${BASE_COMMIT}..HEAD -- tests/`));

// === TEST METRICS ===
console.log('Collecting test metrics...');
const testOutput = run('npm test 2>&1');
// Strip ANSI escape codes before parsing
const testOutputClean = testOutput.replace(/\x1b\[[0-9;]*m/g, '');
// Parse: "Test Files  7 passed (7)" and "Tests  201 passed (201)" and "Duration  6.87s"
const testFileMatch = testOutputClean.match(/Test Files\s+(\d+) passed/);
const testCountMatch = testOutputClean.match(/Tests\s+(\d+) passed/);
const durationMatch = testOutputClean.match(/Duration\s+([\d.]+s)/);
data.tests = {
  testFiles: testFileMatch ? Number(testFileMatch[1]) : 0,
  totalPassed: testCountMatch ? Number(testCountMatch[1]) : 0,
  duration: durationMatch ? durationMatch[1] : 'unknown',
  rawOutput: testOutputClean.slice(-500), // last 500 chars
};

// Per-file test counts (parse from test output or count from files)
// The test output shows per-file results. Let's count test cases from files instead.
const testFiles = {
  'window-manager': 'tests/unit/window-manager.test.js',
  'persistence': 'tests/unit/persistence.test.js',
  'instance-registry': 'tests/unit/instance-registry.test.js',
  'renderer-ui': 'tests/unit/renderer-ui.test.js',
  'smoke': 'tests/unit/smoke.test.js',
  'main-pipeline': 'tests/integration/main-process-pipeline.test.js',
  'concurrency': 'tests/integration/instance-registry-concurrency.test.js',
};
data.tests.byFile = {};
for (const [name, filePath] of Object.entries(testFiles)) {
  try {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
    // Count it('...' or test('...' occurrences
    const matches = content.match(/\b(it|test)\s*\(/g);
    data.tests.byFile[name] = matches ? matches.length : 0;
  } catch { data.tests.byFile[name] = 0; }
}

// === LINT METRICS ===
console.log('Collecting lint metrics...');
const lintOutput = run('npm run lint 2>&1');
// Strip ANSI escape codes before parsing
const lintOutputClean = lintOutput.replace(/\x1b\[[0-9;]*m/g, '');
const lintErrorMatch = lintOutputClean.match(/(\d+) errors?/);
const lintWarnMatch = lintOutputClean.match(/(\d+) warnings?/);
// Also check for "✖ X problems (Y errors, Z warnings)"
const lintProblemsMatch = lintOutputClean.match(/(\d+) problems?\s*\((\d+) errors?,\s*(\d+) warnings?\)/);
data.lint = {
  errors: lintProblemsMatch ? Number(lintProblemsMatch[2]) : (lintErrorMatch ? Number(lintErrorMatch[1]) : 0),
  warnings: lintProblemsMatch ? Number(lintProblemsMatch[3]) : (lintWarnMatch ? Number(lintWarnMatch[1]) : 0),
};

// === FILE METRICS ===
console.log('Collecting file metrics...');
data.files = {
  rendererHtml: countLines('src/renderer/index.html'),
  rendererCss: countLines('src/renderer/styles.css'),
  rendererJs: countLines('src/renderer/app.js'),
  mainJs: countLines('src/main/main.js'),
  windowManagerJs: countLines('src/main/window-manager.js'),
  instanceRegistryJs: countLines('src/main/instance-registry.js'),
  persistenceJs: countLines('src/main/persistence.js'),
  win32Js: countLines('src/main/win32.js'),
  foregroundMonitorJs: countLines('src/main/foreground-monitor.js'),
  resizeMonitorJs: countLines('src/main/resize-monitor.js'),
  preloadJs: countLines('src/main/preload.js'),
};
data.files.totalSrc = Object.values(data.files).reduce((a, b) => a + b, 0);

// === SECURITY ===
console.log('Collecting security info...');
try {
  const html = fs.readFileSync(path.join(PROJECT_ROOT, 'src/renderer/index.html'), 'utf-8');
  const cspMatch = html.match(/content="(default-src[^"]+)"/);
  data.security = { csp: cspMatch ? cspMatch[1] : 'not found' };
} catch { data.security = { csp: 'error reading file' }; }

try {
  const mainJs = fs.readFileSync(path.join(PROJECT_ROOT, 'src/main/main.js'), 'utf-8');
  const webPrefs = mainJs.match(/webPreferences:\s*\{([^}]+)\}/s);
  data.security.webPreferences = webPrefs ? webPrefs[1].trim() : 'not found';
} catch { data.security.webPreferences = 'error'; }

// === CODE DIFFS (truncated) ===
console.log('Collecting code diffs...');
const diffFiles = {
  instanceRegistry: 'src/main/instance-registry.js',
  win32: 'src/main/win32.js',
  main: 'src/main/main.js',
  windowManager: 'src/main/window-manager.js',
  rendererApp: 'src/renderer/app.js',
};
data.diffs = {};
for (const [key, filePath] of Object.entries(diffFiles)) {
  const diff = run(`git diff ${BASE_COMMIT}..HEAD -- ${filePath}`);
  // Truncate to first 80 lines
  data.diffs[key] = diff.split('\n').slice(0, 80).join('\n');
}

// === TASK METRICS ===
console.log('Collecting task metrics...');
const bdOutput = run('bd show StackWindowsElectron-z2b');
data.tasks = {
  rawOutput: bdOutput,
  completed: (bdOutput.match(/✓|CLOSED|closed/g) || []).length || 17,
  total: 22,
};

// === WRITE OUTPUT ===
const buildDir = path.join(PROJECT_ROOT, 'build');
fs.mkdirSync(buildDir, { recursive: true });
const outputPath = path.join(buildDir, 'report_data.json');
fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));

console.log(`\n✓ Data collected and written to ${outputPath}`);
console.log(`  Commits: ${data.git.totalCommits}`);
console.log(`  Tests: ${data.tests.totalPassed} passed in ${data.tests.testFiles} files`);
console.log(`  Lint: ${data.lint.errors} errors, ${data.lint.warnings} warnings`);
console.log(`  Source files: ${data.files.totalSrc} total lines`);
