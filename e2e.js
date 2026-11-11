// End-to-end: run every generated command in a real shell against a local echo server,
// and check the server received the same method, path, headers and body.
// Run on Windows: node e2e.js   (uses curl.exe, cmd.exe, pwsh, powershell.exe and Git Bash if installed)
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFile } = require('node:child_process');
const C = require('./converter.js'), EX = require('./examples.js');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'curlconv-'));
fs.writeFileSync(path.join(work, 'report.pdf'), '%PDF-1.4 test file');
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const SHELLS = {
  bash: { ext: '.sh', cmd: f => [BASH, [f]] },
  cmd: { stdin: true, cmd: () => ['cmd.exe', ['/d', '/q']] },
  pwsh: { ext: '.ps1', bom: true, cmd: f => ['pwsh', ['-NoProfile', '-NonInteractive', '-File', f]] },
  ps51: { ext: '.ps1', bom: true, cmd: f => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f]] },
};
const RUNS = [['bash', 'bash', false], ['cmd', 'cmd', false], ['pwsh', 'ps-curl', false], ['pwsh', 'ps-irm', false],
  ['pwsh', 'ps-iwr', false], ['ps51', 'ps-curl', true], ['ps51', 'ps-irm', true], ['ps51', 'ps-iwr', true]];

const seen = new Map();
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const m = /^\/run-(\d+)(.*)$/s.exec(req.url);
    if (m) seen.set(m[1], { method: req.method, url: m[2], headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  });
});

function run(shell, code, id) {
  const sh = SHELLS[shell];
  return new Promise(resolve => {
    let file;
    // Git Bash's own curl reads arguments in the ANSI code page (\u00e9 breaks); use the Unicode-aware System32 curl.exe.
    if (shell === 'bash') code = 'curl() { /c/Windows/System32/curl.exe "$@"; }\n' + code;
    if (!sh.stdin) { file = path.join(work, `run-${id}${sh.ext}`); fs.writeFileSync(file, (sh.bom ? '\ufeff' : '') + code + '\n'); }
    const [cmd, args] = sh.cmd(file);
    const p = execFile(cmd, args, { cwd: work, timeout: 60000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    if (sh.stdin) p.stdin.end(code.replace(/\n/g, '\r\n') + '\r\nexit\r\n');
  });
}

const jsonish = t => { try { return JSON.stringify(JSON.parse(t)); } catch (e) { return t; } };
function check(j, got) {
  if (!got) return ['the server got no request'];
  const p = [], e = j.exp;
  if (got.method !== e.method) p.push(`method ${got.method}, expected ${e.method}`);
  if (got.url !== j.pathq) p.push(`path ${got.url}, expected ${j.pathq}`);
  const want = e.headers.slice();
  if (e.user != null) want.push(['Authorization', 'Basic ' + Buffer.from(e.user).toString('base64')]);
  for (const [k, v] of want) {
    const g = got.headers[k.toLowerCase()];
    if (k.toLowerCase() === 'content-type' && e.form.length) continue;
    if (g !== v) p.push(`header ${k}: got ${JSON.stringify(g)}, expected ${JSON.stringify(v)}`);
  }
  if (e.form.length) {
    if (!/^multipart\/form-data/.test(got.headers['content-type'] || '')) p.push('not multipart');
    for (const f of e.form) {
      const hit = f.file ? new RegExp(`name="?${f.name}"?; filename="?${f.file}"?`).test(got.body) : got.body.includes(f.value);
      if (!hit) p.push(`form field ${f.name} missing`);
    }
  } else {
    const body = e.body ? e.body.text : '';
    if (jsonish(got.body) !== jsonish(body)) p.push(`body ${JSON.stringify(got.body)}, expected ${JSON.stringify(body)}`);
  }
  return p;
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const jobs = [];
  for (const e of EX) for (const [shell, target, legacy] of RUNS) {
    if (shell === 'bash' && !fs.existsSync(BASH)) continue;
    const { req } = C.parse(e.code);
    const id = String(jobs.length + 1);
    const pathq = req.url.replace(/^[a-z]+:\/\/[^/?#]+/i, '') || '/';
    req.url = `http://127.0.0.1:${port}/run-${id}${pathq}`;
    const exp = C.summary(req);
    const out = C.emit(req, target, { legacy });
    if (out.notes.some(x => /has no -Form|cannot send/.test(x))) continue;
    if (out.notes.some(x => /body\.txt/.test(x))) fs.writeFileSync(path.join(work, 'body.txt'), exp.body.text);
    jobs.push({ id, label: `${e.id} | ${shell} ${target}`, shell, code: out.code, exp, pathq });
  }
  let fails = 0, next = 0;
  async function worker() {
    while (next < jobs.length) {
      const j = jobs[next++];
      const r = await run(j.shell, j.code, j.id);
      const problems = check(j, seen.get(j.id));
      if (problems.length) {
        fails++;
        console.log(`FAIL ${j.label}\n  ${problems.join('\n  ')}\n--- code ---\n${j.code}\n--- output ---\n${(r.stdout + r.stderr).trim().slice(0, 1500)}\n`);
      } else console.log(`ok   ${j.label}`);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`\n${jobs.length - fails}/${jobs.length} passed`);
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  process.exitCode = fails ? 1 : 0;
});
