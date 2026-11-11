// Run: node test.js   (parsing checks + round trips through every output)
const assert = require('node:assert/strict');
const C = require('./converter.js');
const EX = require('./examples.js');

const ex = id => C.parse(EX.find(e => e.id === id).code);
const hdr = (sm, name) => (sm.headers.find(h => h[0].toLowerCase() === name.toLowerCase()) || [])[1];
const jsonish = t => { try { return JSON.stringify(JSON.parse(t)); } catch (e) { return t; } };
const canon = sm => ({
  method: sm.method, url: sm.url, user: sm.user, insecure: sm.insecure, output: sm.output, form: sm.form,
  headers: sm.headers.map(([k, v]) => k.toLowerCase() + ': ' + v).sort(),
  body: sm.body && sm.body.text != null ? { text: jsonish(sm.body.text) } : sm.body,
});

// --- parsing ---
{
  const { req, dialect } = ex('json-post');
  const sm = C.summary(req);
  assert.equal(dialect, 'bash');
  assert.equal(sm.method, 'POST');
  assert.equal(hdr(sm, 'authorization'), 'Bearer eyJhbGciOiJIUzI1NiJ9.demo');
  assert.equal(sm.body.text, `{"customer":"O'Brien","items":[{"sku":"A-100","qty":2}],"note":"50% off & free shipping"}`);
}
{
  const sm = C.summary(ex('dataverse').req);
  assert.equal(sm.url, 'https://contoso.crm4.dynamics.com/api/data/v9.2/accounts?$select=name,revenue&$top=3');
  assert.equal(hdr(sm, 'odata-version'), '4.0');
  assert.equal(sm.method, 'GET');
}
{
  const { req, dialect } = ex('chrome-ps');
  const sm = C.summary(req);
  assert.equal(dialect, 'powershell');
  assert.equal(sm.method, 'POST');
  assert.equal(sm.body.text, '{"query":"invoice 2026","page":1}');
  assert.equal(hdr(sm, 'cookie'), 'sid=abc123');
  assert.equal(hdr(sm, 'user-agent'), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  assert.equal(hdr(sm, 'authority'), undefined);
  assert.equal(hdr(sm, 'content-type'), 'application/json');
}
{
  const { req, dialect } = ex('chrome-cmd');
  assert.equal(dialect, 'cmd');
  const sm = C.summary(req);
  assert.equal(sm.url, 'https://app.example.com/api/search');
  assert.equal(sm.body.text, '{"query":"invoice 2026","page":1}');
}
{
  const sm = C.summary(ex('postman').req);
  assert.equal(sm.method, 'POST');
  assert.equal(hdr(sm, 'authorization'), 'Basic dXNlcjpwYXNz');
  assert.deepEqual(JSON.parse(sm.body.text), { name: 'Ana', active: true });
}
{
  const sm = C.summary(ex('upload').req);
  assert.equal(sm.method, 'POST');
  assert.equal(sm.user, 'admin:s3cr3t');
  assert.equal(sm.insecure, true);
  assert.deepEqual(sm.form, [{ name: 'file', value: undefined, file: 'report.pdf' }, { name: 'title', value: 'Q3 report', file: undefined }]);
}
{
  const { req, dialect } = ex('ps51-curl');
  assert.equal(dialect, 'powershell');
  const sm = C.summary(req);
  assert.equal(sm.method, 'PATCH');
  assert.equal(sm.body.text, '{"status":"done"}');
}
{
  const sm = C.summary(ex('tricky').req);
  assert.equal(hdr(sm, 'x-note'), 'it\'s "quoted" & 100% ^up $HOME `tick` \\back');
  assert.equal(sm.body.text, 'line1 it\'s "q" & 100% ^ $HOME `t` \\x\\ é\nline2');
}
// small cases
assert.deepEqual(C.crtSplit('a "b c" d\\"e "f\\\\" "g""h"'), ['a', 'b c', 'd"e', 'f\\', 'g"h']);
assert.equal(C.summary(C.parse("curl -sSLXPUT -d@x.json example.com").req).method, 'PUT');
assert.equal(C.summary(C.parse('curl -G -d a=1 --data-urlencode "b=x y" https://h/p').req).url, 'https://h/p?a=1&b=x%20y');
assert.equal(C.summary(C.parse("irm https://h/p -Body @{ a = 'x y'; b = 2 }").req).url, 'https://h/p?a=x%20y&b=2');
assert.equal(C.summary(C.parse("$t = 'abc'; Invoke-RestMethod -Uri \"https://h/$t\" -Headers @{ Authorization = \"Bearer $t\" }").req).url, 'https://h/abc');
{
  const { req } = C.parse('Invoke-RestMethod -Uri https://h -Method Post -Body $payload');
  assert.equal(C.summary(req).body.text, '$payload');
  assert.ok(req.warnings.some(w => w.includes('$payload has no value')));
}
assert.equal(C.summary(C.parse("[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }\nirm https://h").req).insecure, true);
assert.throws(() => C.parse('Invoke-RestMethod -Uri https://h -Body @{ a = 1'), /not closed/);
{
  const sm = C.summary(C.parse("$b = @{ name = 'x'; tags = @('a','b'); n = 3 } | ConvertTo-Json -Compress\nInvoke-RestMethod https://h -Method Post -Body $b -ContentType 'application/json'").req);
  assert.deepEqual(JSON.parse(sm.body.text), { name: 'x', tags: ['a', 'b'], n: 3 });
}
// Windows PowerShell 5.1 + curl.exe: a value with quotes and spaces switches to --% on one line
{
  const out = C.emit(ex('json-post').req, 'ps-curl', { legacy: true });
  assert.ok(out.code.startsWith('curl.exe --% ') && !out.code.includes('\n'), out.code);
  assert.ok(C.emit(ex('ps51-curl').req, 'ps-curl', { legacy: true }).code.includes(`'{\\"status\\":\\"done\\"}'`));
}

// --- round trips: every example through every output and back ---
const OUT = [['bash', 'bash'], ['cmd', 'cmd'], ['ps-curl', 'powershell'], ['ps-irm', 'powershell'], ['ps-iwr', 'powershell']];
const LOSSY = /has no -Form|cannot send|Save it as body\.txt|left out/i;
let checked = 0, skipped = [];
for (const e of EX) {
  const { req } = C.parse(e.code);
  const want = canon(C.summary(req));
  for (const [target, dialect] of OUT) for (const legacy of [false, true]) {
    if (legacy && !target.startsWith('ps')) continue;
    const label = `${e.id} -> ${target}${legacy ? ' (5.1)' : ''}`;
    const out = C.emit(req, target, { legacy });
    if (out.notes.some(n => LOSSY.test(n))) { skipped.push(label); continue; }
    assert.equal(C.detect(out.code), dialect, `${label}: detected wrong shell\n${out.code}`);
    const back = C.parse(out.code, dialect);
    assert.deepEqual(canon(C.summary(back.req)), want, `${label}\n${out.code}`);
    checked++;
  }
}
console.log(`ok: ${checked} round trips; skipped (known lossy): ${skipped.join(', ') || 'none'}`);
