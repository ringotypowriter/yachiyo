import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBashSemanticGroup } from './bashSemanticAnalyzer.ts'

// ------------------------------------------------------------------
// Search
// ------------------------------------------------------------------

test('resolveBashSemanticGroup: rg pattern', () => {
  assert.equal(resolveBashSemanticGroup("rg 'foo'"), 'search-files')
})

test('resolveBashSemanticGroup: grep -r', () => {
  assert.equal(resolveBashSemanticGroup("grep -r 'foo' ."), 'search-files')
})

test('resolveBashSemanticGroup: find . -name', () => {
  assert.equal(resolveBashSemanticGroup("find . -name '*.ts'"), 'search-files')
})

test('resolveBashSemanticGroup: fd pattern', () => {
  assert.equal(resolveBashSemanticGroup("fd '*.ts'"), 'search-files')
})

test('resolveBashSemanticGroup: git grep', () => {
  assert.equal(resolveBashSemanticGroup('git grep foo'), 'search-files')
})

test('resolveBashSemanticGroup: ag pattern', () => {
  assert.equal(resolveBashSemanticGroup('ag pattern'), 'search-files')
})

test('resolveBashSemanticGroup: find | xargs grep', () => {
  assert.equal(resolveBashSemanticGroup("find . -name '*.ts' | xargs grep foo"), 'search-files')
})

test('resolveBashSemanticGroup: locate file', () => {
  assert.equal(resolveBashSemanticGroup('locate file'), 'search-files')
})

// ------------------------------------------------------------------
// Read
// ------------------------------------------------------------------

test('resolveBashSemanticGroup: cat file', () => {
  assert.equal(resolveBashSemanticGroup('cat file.ts'), 'read-files')
})

test('resolveBashSemanticGroup: head -20 file', () => {
  assert.equal(resolveBashSemanticGroup('head -20 file.ts'), 'read-files')
})

test('resolveBashSemanticGroup: tail -f log', () => {
  assert.equal(resolveBashSemanticGroup('tail -f log.txt'), 'read-files')
})

test('resolveBashSemanticGroup: jq . package.json', () => {
  assert.equal(resolveBashSemanticGroup('jq . package.json'), 'read-files')
})

test('resolveBashSemanticGroup: sed without -i', () => {
  assert.equal(resolveBashSemanticGroup("sed -n '10,20p' file.ts"), 'read-files')
})

test('resolveBashSemanticGroup: awk print', () => {
  assert.equal(resolveBashSemanticGroup("awk '{print $1}' file.txt"), 'read-files')
})

test('resolveBashSemanticGroup: git show', () => {
  assert.equal(resolveBashSemanticGroup('git show HEAD:file.ts'), 'read-files')
})

test('resolveBashSemanticGroup: strings binary', () => {
  assert.equal(resolveBashSemanticGroup('strings binary'), 'read-files')
})

test('resolveBashSemanticGroup: cat | grep | head pipeline', () => {
  assert.equal(resolveBashSemanticGroup('cat file | grep foo | head -5'), 'read-files')
})

test('resolveBashSemanticGroup: find | xargs cat', () => {
  assert.equal(resolveBashSemanticGroup("find . -name '*.ts' | xargs cat"), 'read-files')
})

test('resolveBashSemanticGroup: rg | head pipeline', () => {
  assert.equal(resolveBashSemanticGroup('rg foo | head -5'), 'search-files')
})

// ------------------------------------------------------------------
// Edit
// ------------------------------------------------------------------

test('resolveBashSemanticGroup: sed -i', () => {
  assert.equal(resolveBashSemanticGroup("sed -i 's/old/new/' file.ts"), 'edit-files')
})

test('resolveBashSemanticGroup: perl -pi', () => {
  assert.equal(resolveBashSemanticGroup("perl -pi -e 's/old/new/' file.ts"), 'edit-files')
})

test('resolveBashSemanticGroup: ex wq', () => {
  assert.equal(resolveBashSemanticGroup("ex -c '%s/old/new/g|wq' file.ts"), 'edit-files')
})

test('resolveBashSemanticGroup: ed command', () => {
  assert.equal(resolveBashSemanticGroup("ed file.ts <<<'%s/old/new/g\nw\nq'"), 'edit-files')
})

// ------------------------------------------------------------------
// Write
// ------------------------------------------------------------------

test('resolveBashSemanticGroup: bare echo is run-commands', () => {
  assert.equal(resolveBashSemanticGroup('echo hello'), 'run-commands')
})

test('resolveBashSemanticGroup: echo > file', () => {
  assert.equal(resolveBashSemanticGroup("echo 'hello' > file.ts"), 'write-files')
})

test('resolveBashSemanticGroup: bare printf is run-commands', () => {
  assert.equal(resolveBashSemanticGroup("printf '%s' text"), 'run-commands')
})

test('resolveBashSemanticGroup: printf > file', () => {
  assert.equal(resolveBashSemanticGroup("printf '%s' text > file.ts"), 'write-files')
})

test('resolveBashSemanticGroup: tee file', () => {
  assert.equal(resolveBashSemanticGroup('tee file.ts'), 'write-files')
})

test('resolveBashSemanticGroup: cat heredoc', () => {
  assert.equal(resolveBashSemanticGroup('cat <<EOF > file.ts\nhello\nEOF'), 'write-files')
})

test('resolveBashSemanticGroup: cat file > other', () => {
  assert.equal(resolveBashSemanticGroup('cat file.ts > file2.ts'), 'write-files')
})

test('resolveBashSemanticGroup: grep specific file', () => {
  assert.equal(resolveBashSemanticGroup('grep foo file.ts'), 'read-files')
})

test('resolveBashSemanticGroup: grep -r stays search', () => {
  assert.equal(resolveBashSemanticGroup('grep -r foo .'), 'search-files')
})

test('resolveBashSemanticGroup: grep multiple files stays search', () => {
  assert.equal(resolveBashSemanticGroup('grep foo file1.ts file2.ts'), 'search-files')
})

test('resolveBashSemanticGroup: grep current directory stays search', () => {
  assert.equal(resolveBashSemanticGroup('grep foo .'), 'search-files')
})

test('resolveBashSemanticGroup: rg specific file', () => {
  assert.equal(resolveBashSemanticGroup('rg foo file.ts'), 'read-files')
})

test('resolveBashSemanticGroup: rg no operand stays search', () => {
  assert.equal(resolveBashSemanticGroup('rg foo'), 'search-files')
})

test('resolveBashSemanticGroup: grep > file', () => {
  assert.equal(resolveBashSemanticGroup('grep foo file.ts > out.ts'), 'write-files')
})

// ------------------------------------------------------------------
// Run (fallback)
// ------------------------------------------------------------------

test('resolveBashSemanticGroup: npm test', () => {
  assert.equal(resolveBashSemanticGroup('npm test'), 'run-commands')
})

test('resolveBashSemanticGroup: pytest', () => {
  assert.equal(resolveBashSemanticGroup('pytest'), 'run-commands')
})

test('resolveBashSemanticGroup: cargo test', () => {
  assert.equal(resolveBashSemanticGroup('cargo test'), 'run-commands')
})

test('resolveBashSemanticGroup: node script', () => {
  assert.equal(resolveBashSemanticGroup('node script.js'), 'run-commands')
})

test('resolveBashSemanticGroup: python3 script', () => {
  assert.equal(resolveBashSemanticGroup('python3 script.py'), 'run-commands')
})

test('resolveBashSemanticGroup: make build', () => {
  assert.equal(resolveBashSemanticGroup('make build'), 'run-commands')
})

test('resolveBashSemanticGroup: docker ps', () => {
  assert.equal(resolveBashSemanticGroup('docker ps'), 'run-commands')
})

test('resolveBashSemanticGroup: kubectl get pods', () => {
  assert.equal(resolveBashSemanticGroup('kubectl get pods'), 'run-commands')
})

test('resolveBashSemanticGroup: cd && cat file', () => {
  // The primary intent after skipping setup commands is read
  assert.equal(resolveBashSemanticGroup('cd /tmp && cat file.ts'), 'read-files')
})

test('resolveBashSemanticGroup: pwd && ls', () => {
  assert.equal(resolveBashSemanticGroup('pwd && ls'), 'read-files')
})

test('resolveBashSemanticGroup: date && cat file', () => {
  assert.equal(resolveBashSemanticGroup('date && cat file.ts'), 'read-files')
})

test('resolveBashSemanticGroup: npm test && cat result', () => {
  // First command group is npm test → run-commands
  assert.equal(resolveBashSemanticGroup('npm test && cat result.txt'), 'run-commands')
})

test('resolveBashSemanticGroup: empty command', () => {
  assert.equal(resolveBashSemanticGroup(''), 'run-commands')
})

test('resolveBashSemanticGroup: only whitespace', () => {
  assert.equal(resolveBashSemanticGroup('   '), 'run-commands')
})

test('resolveBashSemanticGroup: python script with read-like args', () => {
  // Python is run-commands unless it looks like an in-place edit script
  assert.equal(resolveBashSemanticGroup('python -c "print(1)"'), 'run-commands')
})

test('resolveBashSemanticGroup: git diff', () => {
  assert.equal(resolveBashSemanticGroup('git diff'), 'read-files')
})

test('resolveBashSemanticGroup: git log', () => {
  assert.equal(resolveBashSemanticGroup('git log --oneline'), 'read-files')
})

test('resolveBashSemanticGroup: git add', () => {
  assert.equal(resolveBashSemanticGroup('git add file.ts'), 'run-commands')
})

test('resolveBashSemanticGroup: git commit', () => {
  assert.equal(resolveBashSemanticGroup('git commit -m "msg"'), 'run-commands')
})

// ------------------------------------------------------------------
// /dev/null redirects should not misclassify as write-files
// ------------------------------------------------------------------

test('resolveBashSemanticGroup: find with 2>/dev/null stays search', () => {
  assert.equal(
    resolveBashSemanticGroup('find /opt/apps/Example -maxdepth 3 -type d 2>/dev/null | head -1'),
    'search-files'
  )
})

test('resolveBashSemanticGroup: find with stderr suppression and no pipe stays search', () => {
  assert.equal(resolveBashSemanticGroup("find . -name '*.ts' -type f 2>/dev/null"), 'search-files')
})

test('resolveBashSemanticGroup: grep with >/dev/null is search (stdout suppression)', () => {
  assert.equal(resolveBashSemanticGroup('grep -r foo . > /dev/null'), 'search-files')
})

test('resolveBashSemanticGroup: cat with > real-file is still write', () => {
  assert.equal(resolveBashSemanticGroup('cat file.ts > copy.ts'), 'write-files')
})

test('resolveBashSemanticGroup: echo > /dev/null is run-commands', () => {
  assert.equal(resolveBashSemanticGroup('echo hello > /dev/null'), 'run-commands')
})
