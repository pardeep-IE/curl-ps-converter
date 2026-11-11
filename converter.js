/* curl <-> PowerShell <-> cmd converter.
   One request model, three input parsers (bash, cmd, PowerShell) and five outputs.
   Runs in the browser (window.CurlConv) and in Node (module.exports). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CurlConv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- helpers ----------
  const lc = s => String(s).toLowerCase();
  const b64 = s => { let bin = ''; for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
  const unb64 = s => { try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(s), c => c.charCodeAt(0))); } catch (e) { return null; } };
  const curlEscape = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const hasScheme = u => /^[a-z][a-z0-9+.-]*:\/\//i.test(u);
  const minifyJson = s => { try { return JSON.stringify(JSON.parse(s)); } catch (e) { return null; } };

  // Copies a JSON string literal starting at s[i]; returns the index after its closing quote.
  const skipString = (s, i) => { let j = i + 1; while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1; return j + 1; };

  // Removes // and /* */ comments from JSON text, plus the trailing commas that commented-out lines leave.
  // Text inside strings is kept. Returns null when there are no comments.
  function stripJsonComments(s) {
    let out = '', i = 0, found = false;
    const atLineStart = () => /(^|\n)[ \t]*$/.test(out);
    const dropLine = k => { // the comment had the line to itself: remove the whole line
      while (s[k] === ' ' || s[k] === '\t' || s[k] === '\r') k++;
      if (atLineStart() && (s[k] === '\n' || k >= s.length)) { out = out.replace(/[ \t]+$/, ''); return k + 1; }
      return null;
    };
    while (i < s.length) {
      const c = s[i];
      if (c === '"') { const j = skipString(s, i); out += s.slice(i, j); i = j; continue; }
      if (c === '/' && s[i + 1] === '/') {
        found = true;
        let e = s.indexOf('\n', i);
        if (e < 0) e = s.length;
        const k = dropLine(e);
        i = k == null ? e : k;
        continue;
      }
      if (c === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        if (e < 0) return null;
        found = true;
        const k = dropLine(e + 2);
        i = k == null ? e + 2 : k;
        continue;
      }
      out += c; i++;
    }
    if (!found) return null;
    let res = '';
    for (let j = 0; j < out.length; j++) {
      if (out[j] === '"') { const e = skipString(out, j); res += out.slice(j, e); j = e - 1; continue; }
      if (out[j] === ',' && /^\s*[}\]]/.test(out.slice(j + 1))) continue;
      res += out[j];
    }
    // Spaces a comment leaves at a line end; valid JSON has no raw line breaks inside strings, so this is safe.
    return res.replace(/[ \t]+(?=\r?\n|$)/g, '');
  }

  // JSON bodies pasted from docs often carry comments; servers reject them, so take them out before converting.
  function cleanJsonBodies(r) {
    for (const p of r.data) {
      if (p.kind === 'urlencode' || !/^\s*[{[]/.test(p.value)) continue; // also skips @file references
      const clean = stripJsonComments(p.value);
      if (clean == null) continue;
      if (minifyJson(clean) == null) {
        r.warnings.push('The body has comments but is not valid JSON even without them, so it was left as is.');
        continue;
      }
      p.value = clean;
      r.notes.push('Removed comments from the JSON body.');
    }
  }

  function newReq() {
    return { url: '', method: '', headers: [], data: [], form: [], user: null, json: false,
      insecure: false, location: false, maxRedirs: null, head: false, get: false, output: null,
      uploadFile: null, proxy: null, maxTime: null, connectTimeout: null, flags: [], extra: [], warnings: [], notes: [] };
  }

  // ---------- curl options ----------
  const SHORT = { b: 'cookie', c: 'cookie-jar', d: 'data', e: 'referer', E: 'cert', F: 'form', H: 'header', K: 'config',
    m: 'max-time', o: 'output', P: 'ftp-port', Q: 'quote', r: 'range', T: 'upload-file', u: 'user', U: 'proxy-user',
    w: 'write-out', x: 'proxy', X: 'request', y: 'speed-time', Y: 'speed-limit', z: 'time-cond', A: 'user-agent',
    D: 'dump-header', C: 'continue-at', t: 'telnet-option',
    s: 'silent', S: 'show-error', L: 'location', k: 'insecure', i: 'include', I: 'head', v: 'verbose', f: 'fail',
    G: 'get', O: 'remote-name', N: 'no-buffer', n: 'netrc', j: 'junk-session-cookies', J: 'remote-header-name',
    l: 'list-only', q: 'disable', R: 'remote-time', Z: 'parallel', 0: 'http1.0', 1: 'tlsv1', 2: 'sslv2', 3: 'sslv3',
    4: 'ipv4', 6: 'ipv6', '#': 'progress-bar', a: 'append', B: 'use-ascii', g: 'globoff', M: 'manual', p: 'proxytunnel',
    V: 'version', h: 'help' };
  const WITH_ARG = new Set(('cookie cookie-jar data data-ascii data-binary data-raw data-urlencode json form form-string ' +
    'header proxy-header referer cert cert-type key key-type pass config max-time connect-timeout output upload-file user ' +
    'proxy-user write-out proxy request speed-time speed-limit time-cond user-agent dump-header continue-at telnet-option ' +
    'url max-redirs cacert capath resolve connect-to retry retry-delay retry-max-time interface limit-rate range ' +
    'oauth2-bearer aws-sigv4 ciphers local-port noproxy preproxy socks4 socks4a socks5 socks5-hostname trace trace-ascii ' +
    'stderr variable keepalive-time max-filesize output-dir request-target unix-socket abstract-unix-socket url-query ' +
    'tls-max dns-servers doh-url happy-eyeballs-timeout-ms ftp-port quote expect100-timeout login-options proxy-cacert ' +
    'proxy-cert proxy-key mail-from mail-rcpt hostpubmd5 hostpubsha256 pinnedpubkey crlfile netrc-file random-file ' +
    'egd-file sasl-authzid service-name tlsuser tlspassword ech ipfs-gateway etag-compare etag-save parallel-max rate ' +
    'proto proto-redir proto-default create-file-mode delegation krb ftp-method ftp-account ftp-alternative-to-user ' +
    'ftp-ssl-ccc-mode socks5-gssapi-service tftp-blksize').split(' '));

  function parseCurlArgs(args, r) {
    const k = args.findIndex(a => /(^|[\\/])curl(\.exe)?$/i.test(a));
    if (k < 0) throw new Error('No curl command found. Paste a command that starts with curl.');
    if (k > 0 && !(k === 1 && /^[$>%#]$/.test(args[0]))) r.warnings.push(`Ignored "${args.slice(0, k).join(' ')}" before curl.`);
    let opts = true;
    for (let i = k + 1; i < args.length; i++) {
      const a = args[i];
      const next = name => {
        if (i + 1 >= args.length) { r.warnings.push(`--${name} is missing its value.`); return ''; }
        return args[++i];
      };
      if (opts && a === '--') { opts = false; continue; }
      if (opts && a.startsWith('--') && a.length > 2) {
        let name = a.slice(2);
        if (name.startsWith('expand-')) { name = name.slice(7); r.warnings.push(`--expand-${name}: curl variables are not expanded here.`); }
        if (WITH_ARG.has(name)) applyOpt(r, name, next(name)); else applyFlag(r, name);
      } else if (opts && a.startsWith('-') && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const long = SHORT[a[j]];
          if (!long) { r.warnings.push(`Unknown option -${a[j]} was ignored.`); continue; }
          if (WITH_ARG.has(long)) { applyOpt(r, long, j + 1 < a.length ? a.slice(j + 1) : next(long)); break; }
          applyFlag(r, long);
        }
      } else if (!r.url) r.url = a;
      else r.warnings.push(`Extra URL "${a}" was ignored; only the first URL is converted.`);
    }
    if (!r.url) throw new Error('The curl command has no URL.');
    return r;
  }

  function applyOpt(r, name, v) {
    switch (name) {
      case 'request': r.method = v; break;
      case 'header': {
        if (v.startsWith('@')) { r.extra.push(['-H', v]); r.warnings.push(`Headers read from the file ${v.slice(1)} were not converted.`); break; }
        const c = v.indexOf(':');
        if (c < 0) {
          if (v.trim().endsWith(';')) r.headers.push([v.trim().slice(0, -1), '']);
          else r.warnings.push(`Header "${v}" has no colon and was ignored.`);
        } else {
          const val = v.slice(c + 1).trim();
          r.headers.push([v.slice(0, c).trim(), val === '' ? null : val]); // "Name:" removes the header in curl
        }
        break;
      }
      case 'data': case 'data-ascii': r.data.push({ kind: 'data', value: v }); break;
      case 'data-raw': r.data.push({ kind: 'raw', value: v }); break;
      case 'data-binary': r.data.push({ kind: 'binary', value: v }); break;
      case 'data-urlencode': r.data.push({ kind: 'urlencode', value: v }); break;
      case 'json': r.data.push({ kind: 'json', value: v }); r.json = true; break;
      case 'form': case 'form-string': r.form.push(parseForm(v, name === 'form-string')); break;
      case 'user': r.user = v; break;
      case 'user-agent': r.headers.push(['User-Agent', v]); break;
      case 'referer': r.headers.push(['Referer', v.replace(/;auto$/, '')]); break;
      case 'cookie':
        if (v.includes('=')) r.headers.push(['Cookie', v]);
        else { r.extra.push(['-b', v]); r.warnings.push(`Cookies read from the file ${v} were not converted.`); }
        break;
      case 'output': r.output = v; break;
      case 'upload-file': r.uploadFile = v; break;
      case 'proxy': r.proxy = v; break;
      case 'max-time': r.maxTime = v; break;
      case 'connect-timeout': r.connectTimeout = v; break;
      case 'max-redirs': r.maxRedirs = v; break;
      case 'oauth2-bearer': r.headers.push(['Authorization', 'Bearer ' + v]); break;
      case 'url': if (!r.url) r.url = v; else r.warnings.push(`Extra URL "${v}" was ignored.`); break;
      default: r.extra.push(['--' + name, v]);
    }
  }

  function applyFlag(r, name) {
    if (name === 'location') r.location = true;
    else if (name === 'insecure') r.insecure = true;
    else if (name === 'head') r.head = true;
    else if (name === 'get') r.get = true;
    else if (name === 'compressed') r.compressed = true;
    else {
      if (name === 'location-trusted') r.location = true;
      r.flags.push(name);
    }
  }

  function parseForm(v, literal) {
    const eq = v.indexOf('=');
    if (eq < 0) return { name: v, value: '', attrs: [], raw: v };
    const name = v.slice(0, eq), rest = v.slice(eq + 1);
    if (literal) return { name, value: rest, string: true, attrs: [], raw: v };
    const cut = rest.search(/;(type|filename|headers|encoder)=/);
    const main = cut < 0 ? rest : rest.slice(0, cut);
    const attrs = cut < 0 ? [] : rest.slice(cut + 1).split(';');
    if (main.startsWith('@') || main.startsWith('<')) return { name, file: main.slice(1), content: main[0] === '<', attrs, raw: v };
    return { name, value: main, attrs, raw: v };
  }

  // ---------- bash tokenizer ----------
  function tokenizeBash(src, warnings) {
    const s = src.replace(/\r\n?/g, '\n');
    const out = [];
    let cur = '', has = false, sawVar = false;
    const push = () => { if (has) out.push(cur); cur = ''; has = false; };
    const varAt = j => s[j] === '$' && /[A-Za-z_{(]/.test(s[j + 1] || '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        if (s[i + 1] === '\n') { i++; continue; }
        if (i + 1 < s.length) { cur += s[++i]; has = true; }
        continue;
      }
      if (c === "'") {
        const e = s.indexOf("'", i + 1);
        if (e < 0) throw new Error('A single quote is not closed.');
        cur += s.slice(i + 1, e); has = true; i = e; continue;
      }
      if (c === '$' && s[i + 1] === "'") { const [t, e] = ansiC(s, i + 2); cur += t; has = true; i = e; continue; }
      if (c === '"') {
        let j = i + 1;
        for (; j < s.length && s[j] !== '"'; j++) {
          if (s[j] === '\\' && '$`"\\\n'.includes(s[j + 1])) { if (s[j + 1] !== '\n') cur += s[j + 1]; j++; }
          else { if (varAt(j)) sawVar = true; cur += s[j]; }
        }
        if (j >= s.length) throw new Error('A double quote is not closed.');
        has = true; i = j; continue;
      }
      if (c === ' ' || c === '\t') { push(); continue; }
      if (c === '\n') {
        push();
        if (/^\s*-/.test(s.slice(i + 1))) continue; // lenient: next line is more options
        if (s.slice(i + 1).trim()) warnings.push('Only the first command was converted.');
        break;
      }
      if (c === '#' && !has) { while (i + 1 < s.length && s[i + 1] !== '\n') i++; continue; }
      if (c === '|' || c === ';' || c === '>' || c === '<' || (c === '&' && (s[i + 1] === '&' || !has))) {
        push(); warnings.push(`Ignored everything from "${c}" on.`); break;
      }
      if (c === '&') warnings.push('An unquoted & would end the command in bash; it was kept as part of the text. Quote the URL.');
      if (varAt(i)) sawVar = true;
      cur += c; has = true;
    }
    push();
    if (sawVar) warnings.push('Shell variables such as $TOKEN were kept as text; replace them with real values.');
    return out;
  }

  function ansiC(s, i) {
    const map = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
    let out = '';
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "'") return [out, i];
      if (c !== '\\') { out += c; continue; }
      const n = s[++i];
      let m;
      if (n in map) out += map[n];
      else if (n === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1)))) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; }
      else if ((n === 'u' || n === 'U') && (m = new RegExp(`^[0-9a-fA-F]{1,${n === 'u' ? 4 : 8}}`).exec(s.slice(i + 1)))) { out += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length; }
      else if (/[0-7]/.test(n) && (m = /^[0-7]{1,3}/.exec(s.slice(i)))) { out += String.fromCharCode(parseInt(m[0], 8)); i += m[0].length - 1; }
      else out += '\\' + n;
    }
    throw new Error("A $'...' string is not closed.");
  }

  // ---------- cmd tokenizer: cmd.exe escaping first, then the C runtime's argument rules ----------
  function tokenizeCmd(src, warnings) {
    const s = src.replace(/\r\n?/g, '\n');
    let line = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { q = !q; line += c; continue; }
      if (!q && c === '^') {
        if (s[i + 1] === '\n') { i++; if (i + 1 < s.length && s[i + 1] !== '\n') line += s[++i]; continue; }
        if (i + 1 < s.length) line += s[++i]; // ^" adds a quote without toggling cmd's quote state
        continue;
      }
      if (c === '\n') {
        if (!q && /^\s*-/.test(s.slice(i + 1))) { line += ' '; continue; }
        if (s.slice(i + 1).trim()) warnings.push('Only the first command was converted.');
        break;
      }
      if (!q && '&|<>'.includes(c)) { warnings.push(`Ignored everything from "${c}" on.`); break; }
      line += c;
    }
    if (/%[A-Za-z_][\w]*%/.test(line)) warnings.push('Text like %NAME% is an environment variable in cmd; it was kept as text.');
    return crtSplit(line);
  }

  function crtSplit(line) {
    const out = [];
    let cur = '', has = false, q = false, i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === '\\') {
        let n = 0;
        while (line[i] === '\\') { n++; i++; }
        if (line[i] === '"') { cur += '\\'.repeat(n >> 1); if (n & 1) { cur += '"'; i++; } }
        else cur += '\\'.repeat(n);
        has = true; continue;
      }
      if (c === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i += 2; continue; }
        q = !q; has = true; i++; continue;
      }
      if (!q && (c === ' ' || c === '\t')) { if (has) out.push(cur); cur = ''; has = false; i++; continue; }
      cur += c; has = true; i++;
    }
    if (has) out.push(cur);
    return out;
  }

  // ---------- PowerShell parser ----------
  const SQ = new Set(["'", '\u2018', '\u2019', '\u201a', '\u201b']);
  const DQ = new Set(['"', '\u201c', '\u201d', '\u201e']);
  const BT = { 0: '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

  function psParse(source) {
    let s = source, i = 0;
    const err = m => { throw new Error(m + ' (PowerShell)'); };
    const isVarStart = c => c !== undefined && /[A-Za-z_{(?^$]/.test(c);

    function ws(nl) {
      for (;;) {
        const c = s[i];
        if (c === ' ' || c === '\t' || c === '\u00a0' || c === '\r') { i++; continue; }
        if (c === '`') {
          let j = i + 1;
          while (s[j] === ' ' || s[j] === '\t' || s[j] === '\r') j++;
          if (s[j] === '\n') { i = j + 1; continue; }
          break;
        }
        if (c === '\n' && nl) { i++; continue; }
        if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (c === '<' && s[i + 1] === '#') { const e = s.indexOf('#>', i + 2); i = e < 0 ? s.length : e + 2; continue; }
        break;
      }
    }
    const expect = c => { ws(true); if (s[i] !== c) err(`Expected "${c}"`); i++; };
    const ident = () => { const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i)); if (!m) err('Expected a name'); i += m[0].length; return m[0]; };

    function sq() {
      i++;
      let out = '';
      for (;;) {
        if (i >= s.length) err('A single-quoted string is not closed');
        const c = s[i];
        if (SQ.has(c)) { if (SQ.has(s[i + 1])) { out += c; i += 2; continue; } i++; return { t: 'str', v: out }; }
        out += c; i++;
      }
    }
    // Body of an expandable string; isEnd decides where it stops.
    function xbody(isEnd) {
      const parts = [];
      let buf = '';
      for (;;) {
        if (i >= s.length) err('A double-quoted string is not closed');
        const c = s[i];
        if (isEnd(c)) break;
        if (c === '`') {
          const n = s[i + 1];
          if (n === 'u' && s[i + 2] === '{') { const e = s.indexOf('}', i); buf += String.fromCodePoint(parseInt(s.slice(i + 3, e), 16)); i = e + 1; continue; }
          buf += n in BT ? BT[n] : n; i += 2; continue;
        }
        if (c === '$' && isVarStart(s[i + 1])) { if (buf) parts.push(buf); buf = ''; parts.push(variable()); continue; }
        buf += c; i++;
      }
      if (buf || !parts.length) parts.push(buf);
      return { t: 'xstr', parts };
    }
    function dq() {
      i++;
      const node = xbody(c => {
        if (!DQ.has(c)) return false;
        if (DQ.has(s[i + 1])) { i++; return false; } // "" inside a string is one quote
        return true;
      });
      i++;
      return node;
    }
    function here() {
      const q = s[i + 1];
      i += 2;
      let j = i;
      while (s[j] === ' ' || s[j] === '\t' || s[j] === '\r') j++;
      if (s[j] !== '\n') err('A here-string must start on a new line');
      i = j + 1;
      const close = q === "'" ? "'@" : '"@';
      let e = s.startsWith(close, i) ? i - 1 : s.indexOf('\n' + close, i);
      if (e < 0) err('A here-string is not closed');
      const content = e < i ? '' : s.slice(i, e).replace(/\r$/, '');
      i = (e < i ? i : e + 1) + 2;
      if (q === "'") return { t: 'str', v: content };
      const S = s, I = i;
      s = content + '\u0000'; i = 0;
      try { return xbody(c => c === '\u0000'); } finally { s = S; i = I; }
    }
    function variable() {
      const start = i;
      i++;
      if (s[i] === '(') { i++; const stmts = statements(')'); i++; return { t: 'subexpr', stmts, raw: s.slice(start, i) }; }
      let name;
      if (s[i] === '{') { const e = s.indexOf('}', i); name = s.slice(i + 1, e); i = e + 1; }
      else {
        const m = /^(?:(?:env|global|script|local|private|using|variable):)?[A-Za-z0-9_?]+|^[$^?_]/i.exec(s.slice(i));
        if (!m) return { t: 'str', v: '$' };
        name = m[0]; i += name.length;
      }
      return { t: 'var', name, raw: s.slice(start, i) };
    }
    function hashtable() {
      const start = i;
      i += 2;
      const entries = [];
      for (;;) {
        ws(true);
        while (s[i] === ';') { i++; ws(true); }
        if (s[i] === '}') { i++; break; }
        if (i >= s.length) err('A @{ hashtable is not closed');
        let key;
        if (SQ.has(s[i])) key = sq();
        else if (DQ.has(s[i])) key = dq();
        else if (s[i] === '(' || s[i] === '$') key = postfix(primary());
        else { const m = /^[^\s=;}]+/.exec(s.slice(i)); key = { t: 'str', v: m[0] }; i += m[0].length; }
        ws(false);
        if (s[i] !== '=') err('Expected "=" in a hashtable');
        i++; ws(true);
        entries.push([key, pipeline()]);
      }
      return { t: 'hash', entries, raw: s.slice(start, i) };
    }
    function typeLit() {
      let depth = 0;
      const start = i;
      for (; i < s.length; i++) {
        if (s[i] === '[') depth++;
        else if (s[i] === ']' && --depth === 0) { i++; return s.slice(start + 1, i - 1).trim(); }
      }
      err('A [type] is not closed');
    }
    function statements(close) {
      const out = [];
      for (;;) {
        ws(true);
        while (s[i] === ';') { i++; ws(true); }
        if (s[i] === close) return out;
        if (i >= s.length) { if (close) err(`Missing "${close}"`); return out; }
        const before = i;
        out.push(statement());
        if (i === before) err(`Unexpected "${s[i]}"`);
      }
    }
    function block() {
      const start = i;
      let depth = 0;
      while (i < s.length) {
        const c = s[i];
        if (SQ.has(c)) { sq(); continue; }
        if (DQ.has(c)) { dq(); continue; }
        i++;
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return { t: 'block', raw: s.slice(start, i) };
      }
      err('A { script block } is not closed');
    }
    function statement() {
      const save = i;
      if (s[i] === '$' || s[i] === '[') {
        try {
          if (s[i] === '[') { typeLit(); ws(false); }
          if (s[i] === '$') {
            const target = postfix(variable());
            ws(false);
            if (s[i] === '=' && s[i + 1] !== '=') { i++; ws(true); return { t: 'assign', target, value: pipeline() }; }
          }
        } catch (e) { /* not an assignment */ }
        i = save;
      }
      return pipeline();
    }
    function pipeline() {
      const elems = [element()];
      for (;;) {
        ws(false);
        if (s[i] === '|' && s[i + 1] !== '|') { i++; ws(true); elems.push(element()); continue; }
        break;
      }
      return elems.length === 1 ? elems[0] : { t: 'pipe', elems };
    }
    function element() {
      ws(false);
      const c = s[i];
      if (c === '&' && s[i + 1] !== '&') { i++; ws(false); return command(argValue()); }
      if (c === '$' || SQ.has(c) || DQ.has(c) || c === '(' || c === '[' || c === '{' || /[0-9]/.test(c || '') ||
        (c === '@' && /[{('"\u2018\u2019\u201c\u201d]/.test(s[i + 1] || ''))) return expr(false);
      return command();
    }
    function expr(noComma) {
      let left = noComma ? postfix(primary()) : commaList();
      for (;;) {
        ws(false);
        if (s[i] === '+' && s[i + 1] !== '+' && s[i + 1] !== '=') {
          i++; ws(true);
          left = { t: 'add', l: left, r: noComma ? postfix(primary()) : commaList() };
          continue;
        }
        return left;
      }
    }
    function commaList() {
      const first = postfix(primary());
      ws(false);
      if (s[i] !== ',') return first;
      const items = [first];
      while (s[i] === ',') { i++; ws(true); items.push(postfix(primary())); ws(false); }
      return { t: 'arr', items };
    }
    function postfix(node) {
      for (;;) {
        if (s[i] === '.' && /[A-Za-z_]/.test(s[i + 1] || '')) { i++; node = call({ t: 'member', obj: node, name: ident() }); continue; }
        if (s[i] === ':' && s[i + 1] === ':') { i += 2; node = call({ t: 'static', obj: node, name: ident() }); continue; }
        return node;
      }
    }
    function call(m) {
      if (s[i] !== '(') return m;
      i++;
      const args = [];
      ws(true);
      if (s[i] !== ')') for (;;) { args.push(expr(true)); ws(true); if (s[i] === ',') { i++; ws(true); continue; } break; }
      expect(')');
      return { t: 'call', target: m, args };
    }
    function primary() {
      ws(false);
      const c = s[i], n = s[i + 1];
      if (SQ.has(c)) return sq();
      if (DQ.has(c)) return dq();
      if (c === '@') {
        if (n === '{') return hashtable();
        if (n === '(') { i += 2; const st = statements(')'); i++; return { t: 'arr', stmts: st }; }
        if (SQ.has(n) || DQ.has(n)) return here();
        if (/[A-Za-z_]/.test(n || '')) { i++; return { t: 'splat', name: ident() }; }
      }
      if (c === '$') return variable();
      if (c === '{') return block();
      if (c === '(') { i++; ws(true); const v = pipeline(); expect(')'); return { t: 'paren', v }; }
      if (c === '[') {
        const name = typeLit();
        if (s[i] === ':' && s[i + 1] === ':') return { t: 'type', name };
        if (i < s.length && !/[\s;|)}\],]/.test(s[i])) return { t: 'cast', type: name, v: postfix(primary()) };
        return { t: 'type', name };
      }
      const m = /^-?(?:0x[0-9a-f]+|\d+(?:\.\d+)?)/i.exec(s.slice(i));
      if (m && !/[A-Za-z_]/.test(s[i + m[0].length] || '')) { i += m[0].length; return { t: 'num', v: Number(m[0]) }; }
      const w = /^[^\s;|)}\],=]+/.exec(s.slice(i));
      if (!w) err(`Unexpected "${c}"`);
      i += w[0].length;
      return { t: 'str', v: w[0], bare: true };
    }
    function command(nameNode) {
      const start = i;
      const name = nameNode || argValue();
      const args = [];
      for (;;) {
        ws(false);
        const c = s[i];
        if (c === undefined || c === ';' || c === ')' || c === '}' || c === '|') break;
        if (c === '\n') {
          let j = i;
          while (j < s.length && /\s/.test(s[j])) j++;
          if (s[j] === '-' && /[A-Za-z]/.test(s[j + 1] || '')) { i = j; continue; } // lenient: next line is a parameter
          break;
        }
        if (c === '&' && s[i + 1] === '&') break;
        if (c === '-' && s[i + 1] === '-' && s[i + 2] === '%') {
          i += 3;
          let e = s.indexOf('\n', i);
          if (e < 0) e = s.length;
          args.push({ t: 'stopparse', v: s.slice(i, e) });
          i = e; break;
        }
        if (c === '-' && /[A-Za-z_?]/.test(s[i + 1] || '')) {
          const m = /^-([A-Za-z_?][^\s:;|)}'"(\u2018\u2019\u201c\u201d]*)/.exec(s.slice(i));
          i += m[0].length;
          const p = { t: 'param', name: m[1] };
          if (s[i] === ':') { i++; p.value = argValue(); p.colon = true; }
          else if (s[i] && !/[\s;|)}]/.test(s[i])) p.glued = argValue();
          args.push(p); continue;
        }
        args.push(argValue());
      }
      return { t: 'cmd', name, args, raw: s.slice(start, i) };
    }
    // One argument in command mode: barewords, quoted strings and variables glue together.
    function argValue() {
      const pieces = [];
      for (;;) {
        const c = s[i];
        if (c === undefined || /[\s;|)}]/.test(c) || c === ',') break;
        if (c === '`') { if (s[i + 1] === '\n') break; pieces.push({ t: 'str', v: s[i + 1] || '' }); i += 2; continue; }
        if (SQ.has(c)) { pieces.push(sq()); continue; }
        if (DQ.has(c)) { pieces.push(dq()); continue; }
        if (c === '@' && !pieces.length && /[{(A-Za-z_'"\u2018\u2019\u201c\u201d]/.test(s[i + 1] || '')) { pieces.push(postfix(primary())); continue; }
        if (c === '{' && !pieces.length) { pieces.push(block()); continue; }
        if (c === '$' && isVarStart(s[i + 1])) { pieces.push(postfix(variable())); continue; }
        if (c === '(') { if (pieces.length) break; pieces.push(postfix(primary())); continue; }
        let buf = '';
        while (i < s.length && !/[\s;|)},`$(\u2018\u2019\u201a\u201b\u201c\u201d\u201e'"]/.test(s[i])) buf += s[i++];
        if (!buf) buf = s[i++];
        pieces.push({ t: 'str', v: buf, bare: true });
      }
      let node = pieces.length === 1 ? pieces[0] : { t: 'concat', parts: pieces };
      if (s[i] === ',') {
        const items = [node];
        while (s[i] === ',') { i++; ws(false); items.push(argValue()); }
        node = { t: 'arr', items };
      }
      return node;
    }

    return statements(undefined);
  }

  // ---------- PowerShell evaluator ----------
  const IWR_PARAMS = ['Uri', 'Method', 'CustomMethod', 'Headers', 'Body', 'ContentType', 'UserAgent', 'InFile', 'OutFile',
    'Form', 'WebSession', 'SessionVariable', 'Credential', 'UseDefaultCredentials', 'Authentication', 'Token',
    'AllowUnencryptedAuthentication', 'SkipCertificateCheck', 'SkipHeaderValidation', 'SkipHttpErrorCheck',
    'MaximumRedirection', 'MaximumRetryCount', 'RetryIntervalSec', 'TimeoutSec', 'ConnectionTimeoutSeconds',
    'OperationTimeoutSeconds', 'Proxy', 'ProxyCredential', 'ProxyUseDefaultCredentials', 'NoProxy', 'UseBasicParsing',
    'DisableKeepAlive', 'TransferEncoding', 'PassThru', 'Resume', 'PreserveAuthorizationOnRedirect',
    'PreserveHttpMethodOnRedirect', 'HttpVersion', 'SslProtocol', 'CertificateThumbprint', 'Certificate',
    'StatusCodeVariable', 'ResponseHeadersVariable', 'FollowRelLink', 'MaximumFollowRelLink', 'UnixSocket',
    'Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction', 'ProgressAction', 'ErrorVariable',
    'WarningVariable', 'InformationVariable', 'OutVariable', 'OutBuffer', 'PipelineVariable'];
  const SWITCHES = new Set(['useDefaultCredentials', 'allowUnencryptedAuthentication', 'skipCertificateCheck',
    'skipHeaderValidation', 'skipHttpErrorCheck', 'proxyUseDefaultCredentials', 'noProxy', 'useBasicParsing',
    'disableKeepAlive', 'passThru', 'resume', 'preserveAuthorizationOnRedirect', 'preserveHttpMethodOnRedirect',
    'followRelLink', 'verbose', 'debug', 'asPlainText', 'force', 'compress', 'raw', 'enumsAsStrings', 'asArray'].map(lc));
  const resolveIwr = name => {
    const l = lc(name);
    const exact = IWR_PARAMS.find(p => lc(p) === l);
    if (exact) return exact;
    const pre = IWR_PARAMS.filter(p => lc(p).startsWith(l));
    return pre.length === 1 ? pre[0] : null;
  };

  function str(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    if (Array.isArray(v)) return v.map(str).join(' ');
    for (const k of ['text', 'unknown', 'file', 'bytes', 'secure']) if (v[k] != null) return v[k];
    return '';
  }
  const truthy = v => v === true || lc(str(v)) === 'true';

  function toJs(v) {
    if (Array.isArray(v)) return v.map(toJs);
    if (v && typeof v === 'object') {
      if (v.hash) { const o = {}; for (const [k, x] of v.hash) o[k] = toJs(x); return o; }
      return str(v);
    }
    return v;
  }

  function evaluator(warnings) {
    const vars = Object.create(null);
    const self = { request: null, requests: 0 };
    const varKey = name => lc(name).replace(/^(global|script|local|private|using|variable):/, '');

    function ev(n) {
      switch (n.t) {
        case 'str': return n.v;
        case 'num': return n.v;
        case 'xstr': return n.parts.map(p => typeof p === 'string' ? p : str(ev(p))).join('');
        case 'concat': return n.parts.map(p => str(ev(p))).join('');
        case 'var': {
          const k = varKey(n.name);
          if (k === 'true') return true;
          if (k === 'false') return false;
          if (k === 'null') return null;
          if (k in vars) return vars[k];
          warnings.push(`${n.raw} has no value in the pasted code; it was kept as text.`);
          return { unknown: n.raw };
        }
        case 'subexpr': { const r = n.stmts.map(run).filter(x => x !== undefined); return r.length === 1 ? r[0] : r; }
        case 'paren': return ev(n.v);
        case 'arr': return n.stmts ? n.stmts.flatMap(st => { const v = run(st); return v === undefined ? [] : [].concat(v); }) : n.items.map(ev);
        case 'hash': return { hash: n.entries.map(([k, v]) => [str(ev(k)), ev(v)]) };
        case 'cast': {
          const v = ev(n.v), t = lc(n.type);
          if (/^(int|long|double)$/.test(t)) return Number(str(v));
          if (t === 'string') return str(v);
          return v;
        }
        case 'type': return { type: n.name };
        case 'splat': return vars[varKey(n.name)] ?? { unknown: '@' + n.name };
        case 'stopparse': return n.v;
        case 'add': {
          const l = ev(n.l), r = ev(n.r);
          if (typeof l === 'string' && /^basic\s+$/i.test(l) && r && r.b64 != null) return { basic: r.b64, text: l + r.text };
          if (typeof l === 'number' && typeof r === 'number') return l + r;
          if (Array.isArray(l)) return l.concat(r);
          return str(l) + str(r);
        }
        case 'member': {
          if (n.obj.t === 'type' || n.obj.t === 'static') return { unknown: '' };
          const o = ev(n.obj), k = lc(n.name);
          if (o && o.session) return k === 'cookies' ? o.cookies : k === 'headers' ? o.headers : o.props[k];
          if (o && o.hash) { const e = o.hash.find(([x]) => lc(x) === k); return e ? e[1] : null; }
          return { unknown: '' };
        }
        case 'static': {
          const t = n.obj.t === 'type' ? lc(n.obj.name) : '';
          if (/(^|\.)encoding$/.test(t)) return { encoding: lc(n.name) };
          return { unknown: '' };
        }
        case 'call': return callMethod(n);
        case 'cmd': return runCmd(n, undefined);
        case 'pipe': {
          let v;
          n.elems.forEach((e, idx) => { v = e.t === 'cmd' ? runCmd(e, idx ? { value: v } : undefined) : ev(e); });
          return v;
        }
        default: return { unknown: '' };
      }
    }

    function callMethod(n) {
      const m = n.target, name = lc(m.name), args = n.args.map(ev);
      if (m.t === 'static') {
        const t = m.obj.t === 'type' ? lc(m.obj.name) : '';
        if (/(^|\.)convert$/.test(t) && name === 'tobase64string' && args[0] && args[0].bytes != null) return { b64: args[0].bytes, text: b64(args[0].bytes) };
        if (/pscredential$/.test(t) && name === 'new') return { cred: { user: str(args[0]), pass: str(args[1]) } };
        if (/(dictionary|hashtable)/.test(t) && name === 'new') return { hash: [] };
        return { unknown: '' };
      }
      const obj = ev(m.obj);
      if (name === 'getbytes' && obj && obj.encoding) return { bytes: str(args[0]) };
      if (name === 'add') {
        if (Array.isArray(obj)) { obj.push(args[0]); return undefined; }
        if (obj && obj.hash) { obj.hash.push([str(args[0]), args[1]]); return undefined; }
      }
      return { unknown: '' };
    }

    function bind(args, resolve) {
      const named = {}, pos = [], unknown = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a.t === 'splat') {
          const h = ev(a);
          if (h && h.hash) for (const [key, v] of h.hash) { const p = resolve ? resolve(key) : key; if (p) named[p] = v; else unknown.push(key); }
          else if (Array.isArray(h)) pos.push(...h);
          continue;
        }
        if (a.t !== 'param') { pos.push(ev(a)); continue; }
        const p = resolve ? resolve(a.name) : a.name;
        let v;
        if (a.colon) v = ev(a.value);
        else if (a.glued) v = ev(a.glued);
        else if (SWITCHES.has(lc(p || a.name))) v = true;
        else if (k + 1 < args.length && args[k + 1].t !== 'param') v = ev(args[++k]);
        else v = true;
        if (p) named[p] = v; else unknown.push(a.name);
      }
      return { named, pos, unknown };
    }

    function runCmd(n, input) {
      const raw = str(ev(n.name));
      const name = lc(raw.replace(/^.*[\\/]/, '').replace(/^microsoft\.powershell\.utility\\/i, ''));
      const isIwr = /^(invoke-webrequest|invoke-restmethod|iwr|irm)$/.test(name) ||
        (/^(curl|wget)$/.test(name) && n.args.some(a => a.t === 'param' && /^(uri|method|headers|body|contenttype|usebasicparsing|outfile|websession|infile)$/i.test(a.name)));
      if (isIwr || /^curl(\.exe)?$/.test(name)) {
        self.requests++;
        if (!self.request) self.request = isIwr ? iwrToModel(bind(n.args, resolveIwr), warnings) : nativeCurl(n.args);
        return { unknown: '' };
      }
      const { named, pos } = bind(n.args);
      const get = k => { const e = Object.keys(named).find(x => lc(x) === lc(k)); return e ? named[e] : undefined; };
      switch (name) {
        case 'convertto-json': {
          const v = input ? input.value : get('InputObject') ?? pos[0];
          return JSON.stringify(toJs(v), null, truthy(get('Compress')) ? 0 : 2);
        }
        case 'convertto-securestring': return { secure: str(get('String') ?? pos[0]) };
        case 'new-object': {
          const type = lc(str(get('TypeName') ?? pos[0]));
          const a = [].concat(get('ArgumentList') ?? pos[1] ?? []);
          if (/webrequestsession$/.test(type)) return { session: true, props: {}, cookies: [], headers: { hash: [] } };
          if (/(^|\.)cookie$/.test(type)) return { cookie: { name: str(a[0]), value: str(a[1]) } };
          if (/pscredential$/.test(type)) return { cred: { user: str(a[0]), pass: str(a[1]) } };
          if (/(dictionary|hashtable)/.test(type)) return { hash: [] };
          return { unknown: '' };
        }
        case 'get-item': case 'gi': case 'get-childitem': case 'gci': case 'dir': case 'ls':
          return { file: str(get('LiteralPath') ?? get('Path') ?? pos[0]) };
        case 'get-credential':
          warnings.push('Get-Credential asks for a password at run time; add -u user:password to the curl command.');
          return { unknown: '' };
        default: return { unknown: '' };
      }
    }

    function nativeCurl(args) {
      const out = [];
      for (const a of args) {
        if (a.t === 'stopparse') out.push(...crtSplit(a.v));
        else if (a.t === 'param') out.push('-' + a.name + (a.colon ? ':' + str(ev(a.value)) : a.glued ? str(ev(a.glued)) : ''));
        else { const v = ev(a); if (Array.isArray(v)) out.push(...v.map(str)); else out.push(str(v)); }
      }
      // Windows PowerShell 5.1 needs \" inside native arguments; undo it when every quote is escaped that way.
      const fixed = out.map(x => {
        if (!x.includes('"') || !/(^|[^\\])(\\\\)*\\"/.test(x)) return x;
        const bare = /(^|[^\\])(\\\\)*"/.test(x.replace(/^"/, ' "'));
        if (bare) return x;
        warnings.push('Read \\" as a plain quote, as Windows PowerShell 5.1 passes it to curl.exe.');
        return x.replace(/(\\*)\\"/g, (m, bs) => '\\'.repeat(bs.length / 2) + '"');
      });
      return parseCurlArgs(['curl'].concat(fixed), newReq());
    }

    function run(st) {
      if (st.t === 'assign') {
        const v = ev(st.value), t = st.target;
        if (t.t === 'var') vars[varKey(t.name)] = v;
        else if (t.t === 'member') {
          const o = ev(t.obj);
          if (o && o.session) o.props[lc(t.name)] = v;
          else if (o && o.hash) o.hash.push([t.name, v]);
        }
        return undefined;
      }
      return ev(st);
    }
    self.run = run;
    return self;
  }

  function iwrToModel({ named, pos, unknown }, warnings) {
    const r = newReq();
    const get = k => named[k];
    for (const u of unknown) warnings.push(`Unknown parameter -${u} was ignored.`);
    const uri = get('Uri') ?? pos.shift();
    if (uri == null) throw new Error('The PowerShell command has no -Uri.');
    r.url = str(uri);
    if (pos.length) warnings.push('Extra unnamed values after the URL were ignored.');
    const has = k => r.headers.some(h => lc(h[0]) === lc(k));

    const h = get('Headers');
    if (h && h.hash) {
      const pseudo = [];
      for (const [k, v] of h.hash) {
        if (/^(authority|method|path|scheme)$/i.test(k)) { pseudo.push(k); continue; }
        if (v && v.basic != null && lc(k) === 'authorization') { r.user = v.basic; continue; }
        r.headers.push([k, Array.isArray(v) ? v.map(str).join(', ') : str(v)]);
      }
      if (pseudo.length) warnings.push(`Dropped ${pseudo.join(', ')}: browsers copy these HTTP/2 pseudo-headers as normal headers.`);
    } else if (h != null) warnings.push('-Headers is not a hashtable here, so its headers were not converted.');

    const sess = get('WebSession');
    let sessUa = null;
    if (sess && sess.session) {
      sessUa = sess.props.useragent ?? null;
      for (const [k, v] of sess.headers.hash) r.headers.push([k, str(v)]);
      const cookies = sess.cookies.filter(c => c && c.cookie).map(c => c.cookie.name + '=' + c.cookie.value);
      if (cookies.length && !has('cookie')) r.headers.push(['Cookie', cookies.join('; ')]);
    } else if (sess != null) warnings.push('-WebSession has no value in the pasted code; its cookies were not converted.');

    const ct = get('ContentType');
    if (ct != null && !has('content-type')) r.headers.push(['Content-Type', str(ct)]);
    const ua = get('UserAgent') ?? sessUa;
    if (ua != null && !has('user-agent')) r.headers.push(['User-Agent', str(ua)]);

    const auth = lc(str(get('Authentication') ?? ''));
    const token = get('Token');
    if (token != null && /^(bearer|oauth)$/.test(auth || 'bearer')) r.headers.push(['Authorization', 'Bearer ' + str(token)]);
    const cred = get('Credential');
    if (cred && cred.cred) { r.user = cred.cred.user + ':' + cred.cred.pass; if (auth !== 'basic') r.flags.push('anyauth'); }
    else if (cred != null) warnings.push('-Credential has no value in the pasted code; add -u user:password to the curl command.');
    if (truthy(get('UseDefaultCredentials'))) { r.user = ':'; r.flags.push('negotiate'); }

    const method = lc(str(get('Method') ?? get('CustomMethod') ?? 'GET')).toUpperCase();
    const b = get('Body');
    if (b != null) {
      if (b.hash) {
        for (const [k, v] of b.hash) r.data.push({ kind: 'urlencode', value: k + '=' + str(v) });
        if (method === 'GET') r.get = true;
      } else r.data.push({ kind: 'text', value: str(b) });
    }
    const inFile = get('InFile');
    if (inFile != null) r.data.push({ kind: 'binary', value: '@' + str(inFile) });
    const form = get('Form');
    if (form && form.hash) {
      for (const [k, v] of form.hash) for (const item of [].concat(v)) {
        r.form.push(item && item.file != null ? { name: k, file: item.file, attrs: [] } : { name: k, value: str(item), attrs: [] });
      }
    }
    r.method = method === inferredMethod(r) ? '' : method;

    const out = get('OutFile');
    if (out != null) r.output = str(out);
    if (truthy(get('SkipCertificateCheck'))) r.insecure = true;
    const mr = get('MaximumRedirection');
    if (mr != null && Number(str(mr)) === 0) r.location = false;
    else { r.location = true; if (mr != null) r.maxRedirs = str(mr); }
    const to = get('TimeoutSec') ?? get('ConnectionTimeoutSeconds') ?? get('OperationTimeoutSeconds');
    if (to != null && Number(str(to)) > 0) r.maxTime = str(to);
    if (get('Proxy') != null) r.proxy = str(get('Proxy'));
    if (truthy(get('NoProxy'))) r.extra.push(['--noproxy', '*']);
    const hv = { '1.0': 'http1.0', '1.1': 'http1.1', '2.0': 'http2', '3.0': 'http3' }[str(get('HttpVersion') ?? '')];
    if (hv) r.flags.push(hv);
    if (truthy(get('PreserveAuthorizationOnRedirect'))) r.flags.push('location-trusted');
    if (truthy(get('DisableKeepAlive'))) r.flags.push('no-keepalive');
    if (truthy(get('Resume'))) r.extra.push(['-C', '-']);
    if (get('Certificate') != null || get('CertificateThumbprint') != null) warnings.push('Client certificates were not converted; use --cert in curl.');
    if (get('ProxyCredential') != null) warnings.push('-ProxyCredential was not converted; use --proxy-user in curl.');
    return r;
  }

  function parsePowerShell(src, warnings) {
    const E = evaluator(warnings);
    for (const st of psParse(src.replace(/\r\n?/g, '\n'))) {
      E.run(st);
      if (E.request) break;
    }
    if (!E.request) throw new Error('No Invoke-RestMethod, Invoke-WebRequest or curl.exe command found.');
    if (/ServerCertificateValidationCallback\s*=\s*\{\s*\$true\s*\}/i.test(src)) E.request.insecure = true;
    const n = (src.match(/(^|[\s;(=|&])(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl(\.exe)?)(?=\s|$)/gi) || []).length;
    if (n > 1) warnings.push('Only the first request in the code was converted.');
    return E.request;
  }

  // ---------- request model helpers ----------
  function inferredMethod(r) {
    if (r.head) return 'HEAD';
    if (r.uploadFile) return 'PUT';
    if (r.get) return 'GET';
    if (r.data.length || r.form.length) return 'POST';
    return 'GET';
  }
  const effMethod = r => r.method || inferredMethod(r);

  function dataPart(p) {
    const v = p.value;
    switch (p.kind) {
      case 'raw': case 'text': return { text: v };
      case 'data': case 'binary': case 'json':
        return v.startsWith('@') ? { file: v.slice(1), strip: p.kind === 'data' } : { text: v };
      case 'urlencode': {
        const eq = v.indexOf('='), at = v.indexOf('@');
        if (eq >= 0 && (at < 0 || eq < at)) { const name = v.slice(0, eq); return { text: (name ? name + '=' : '') + curlEscape(v.slice(eq + 1)) }; }
        if (at >= 0) return { file: v.slice(at + 1), encode: true };
        return { text: curlEscape(v) };
      }
    }
    return { text: v };
  }

  function bodyOf(r, notes) {
    if (!r.data.length) return null;
    const parts = r.data.map(dataPart);
    if (parts.length === 1 && parts[0].file != null) return parts[0];
    if (parts.some(p => p.file != null)) notes.push('Data read from files was left out because it is mixed with text data.');
    return { text: parts.filter(p => p.file == null).map(p => p.text).join(r.json ? '' : '&') };
  }

  // What the request actually sends: URL, method, headers and body, with curl's defaults applied.
  function normalize(r) {
    const notes = [];
    const n = { url: r.url, method: effMethod(r).toUpperCase(), headers: [], body: null, form: r.form, user: r.user };
    if (!hasScheme(n.url)) { n.url = 'http://' + n.url; notes.push('Added http:// to the URL, as curl does.'); }
    for (const [k, v] of r.headers) {
      if (v === null) notes.push(`curl removes the ${k} header here; there is no PowerShell equivalent, so it was skipped.`);
      else n.headers.push([k, v]);
    }
    const has = k => n.headers.some(h => lc(h[0]) === lc(k));
    if (r.json) {
      if (!has('content-type')) n.headers.push(['Content-Type', 'application/json']);
      if (!has('accept')) n.headers.push(['Accept', 'application/json']);
    }
    const b = bodyOf(r, notes);
    if (b && r.get) {
      if (b.text != null) n.url += (n.url.includes('?') ? '&' : '?') + b.text;
      else notes.push('-G with data from a file was not converted.');
    } else if (b) {
      n.body = b;
      if (!has('content-type') && !r.form.length) n.headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    }
    if (r.uploadFile) n.body = { file: r.uploadFile };
    return { n, notes };
  }

  // ---------- quoting ----------
  const qBash = s => {
    if (s !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(s)) {
      return "$'" + s.replace(/[\\']/g, '\\$&').replace(/[\x00-\x1f\x7f]/g, c =>
        ({ '\n': '\\n', '\t': '\\t', '\r': '\\r' })[c] || '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + "'";
    }
    return "'" + s.replace(/'/g, "'\\''") + "'";
  };
  // C runtime quoting, which curl.exe uses to split its command line.
  const qCrt = s => s !== '' && /^[A-Za-z0-9_@+=:,./\\-]+$/.test(s) ? s
    : '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  // cmd: quote for the C runtime, then caret-escape what cmd.exe would see outside its own quote state.
  const qCmd = s => {
    let q = false, out = '';
    for (const ch of qCrt(s)) {
      if (ch === '"') q = !q;
      else if (!q && '&|<>^()'.includes(ch)) out += '^';
      out += ch;
    }
    return out;
  };
  const qPs = s => "'" + s.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&') + "'";
  // Windows PowerShell 5.1 passes quotes to native programs unescaped, so escape them for the C runtime ourselves.
  const legacyEscape = s => { s = s.replace(/(\\*)"/g, '$1$1\\"'); return /\s/.test(s) ? s.replace(/(\\+)$/, '$1$1') : s; };
  // 5.1 wraps an argument in quotes only when a space follows an even number of " characters (\" counts too).
  const ps51Pass = a => {
    let n = 0, need = false;
    for (const c of a) { if (c === '"') n++; else if (/\s/.test(c) && n % 2 === 0) need = true; }
    return need ? '"' + a + '"' : a;
  };
  const ps51Ok = a => { if (a === '') return true; const got = crtSplit(ps51Pass(legacyEscape(a))); return got.length === 1 && got[0] === a; };
  const qPsNative = (s, legacy) => {
    if (legacy) { if (s === '') return "'\"\"'"; s = legacyEscape(s); }
    return /^[A-Za-z0-9_./]+$/.test(s) ? s : qPs(s);
  };

  // ---------- curl output (bash, cmd, PowerShell curl.exe) ----------
  function curlLines(r, oneLine, notes) {
    const lines = [[r.url]];
    const inferred = inferredMethod(r);
    if (r.method && r.method !== inferred) lines.push(['-X', r.method]);
    for (const [k, v] of r.headers) lines.push(['-H', v === null ? k + ':' : v === '' ? k + ';' : `${k}: ${v}`]);
    if (r.user != null) lines.push(['-u', r.user]);
    for (const p of r.data) lines.push(dataArgs(p, oneLine, notes));
    for (const f of r.form) lines.push([f.string ? '--form-string' : '-F', formSpec(f)]);
    if (r.uploadFile) lines.push(['-T', r.uploadFile]);
    if (r.get) lines.push(['-G']);
    if (r.head) lines.push(['-I']);
    if (r.location && !r.flags.includes('location-trusted')) lines.push(['-L']);
    if (r.maxRedirs != null) lines.push(['--max-redirs', String(r.maxRedirs)]);
    if (r.insecure) lines.push(['-k']);
    if (r.compressed) lines.push(['--compressed']);
    if (r.proxy) lines.push(['-x', r.proxy]);
    if (r.maxTime != null) lines.push(['--max-time', String(r.maxTime)]);
    if (r.connectTimeout != null) lines.push(['--connect-timeout', String(r.connectTimeout)]);
    if (r.output) lines.push(['-o', r.output]);
    for (const f of r.flags) lines.push(['--' + f]);
    for (const e of r.extra) lines.push(e);
    return lines;
  }

  function emitCurl(r, sh, o) {
    let notes = [];
    let lines = curlLines(r, sh === 'cmd', notes);
    let mode = sh;
    if (sh === 'ps' && o.legacy && lines.some(l => l.some(a => !ps51Ok(a)))) {
      // 5.1 would split a value that has both quotes and spaces; --% hands the rest of the line to curl.exe untouched.
      mode = 'stop';
      notes = [];
      lines = curlLines(r, true, notes);
      notes.push('Uses --% because Windows PowerShell 5.1 cannot pass a value with both quotes and spaces to curl.exe. Keep it on one line; %NAME% is still expanded.');
    } else if (sh === 'ps' && o.legacy) notes.push('Written for Windows PowerShell 5.1: quotes inside values are escaped as \\" for curl.exe.');

    const quote = mode === 'bash' ? qBash : mode === 'cmd' ? qCmd : mode === 'stop' ? qCrt : s => qPsNative(s, o.legacy);
    const text = lines.map((parts, li) => parts.map((p, pi) => pi === 0 && li > 0 ? p : quote(p)).join(' '));
    text[0] = (sh === 'ps' ? 'curl.exe' : 'curl') + (mode === 'stop' ? ' --%' : '') + ' ' + text[0];
    const one = text.join(' ');
    const cont = sh === 'bash' ? ' \\\n  ' : sh === 'cmd' ? ' ^\n  ' : ' `\n  ';
    const code = mode === 'stop' || (one.length <= 90 && !one.includes('\n')) ? one : text.join(cont);
    if (mode === 'cmd' || mode === 'stop') {
      if (mode === 'cmd' && /%[A-Za-z_][\w]*%/.test(code)) notes.push('Text like %NAME% is expanded by cmd if that environment variable exists. In a .bat file, double every %.');
      if (one.length > 8000) notes.push('Command lines are limited to about 8,000 characters; move the body to a file if this fails.');
    }
    return { code, notes };
  }

  function dataArgs(p, oneLine, notes) {
    let flag = { data: '-d', raw: '--data-raw', binary: '--data-binary', urlencode: '--data-urlencode', json: '--json' }[p.kind];
    let v = p.value;
    if (p.kind === 'text') flag = v.startsWith('@') ? '--data-raw' : '-d';
    if (oneLine && /[\r\n]/.test(v) && !(dataPart(p).file != null)) {
      const min = minifyJson(v);
      if (min != null) { notes.push('Removed line breaks from the JSON body, because this command has to stay on one line.'); v = min; }
      else { notes.push('The body has line breaks, which this command cannot pass on one line. Save it as body.txt where you run the command.'); return ['--data-binary', '@body.txt']; }
    }
    return [flag, v];
  }

  const formSpec = f => f.raw != null ? f.raw
    : f.name + '=' + (f.file != null ? (f.content ? '<' : '@') + f.file : f.value) + (f.attrs && f.attrs.length ? ';' + f.attrs.join(';') : '');

  // ---------- PowerShell output ----------
  function psHash(entries, indent) {
    const w = Math.max(...entries.map(e => e[0].length));
    return '@{\n' + entries.map(([k, v]) => indent + '    ' + k.padEnd(w) + ' = ' + v).join('\n') + '\n' + indent + '}';
  }
  function psBody(s) {
    const lit = /\n/.test(s) && !/(^|\n)'@/.test(s) ? "@'\n" + s + "\n'@" : qPs(s);
    return /[^\x00-\x7f]/.test(s) ? `[Text.Encoding]::UTF8.GetBytes(${lit})` : lit;
  }

  function emitPs(r, cmdlet, o) {
    const legacy = !!o.legacy;
    const { n, notes } = normalize(r);
    const P = [], pre = [], hdrs = [];
    let ct = null, ua = null, credential = null, cookie = null;
    for (const [k, v] of n.headers) {
      if (lc(k) === 'content-type') ct = v;
      else if (lc(k) === 'user-agent') ua = v;
      else if (legacy && lc(k) === 'cookie') cookie = v;
      else hdrs.push([qPs(k), qPs(v)]);
    }
    if (n.user != null) {
      const c = n.user.indexOf(':');
      const u = c < 0 ? n.user : n.user.slice(0, c), p = c < 0 ? '' : n.user.slice(c + 1);
      if (c < 0) notes.push('curl would ask for the password; add it after the user name.');
      if (r.flags.includes('negotiate') && n.user === ':') P.push(['UseDefaultCredentials', '$true']);
      else if (['ntlm', 'negotiate', 'digest', 'anyauth'].some(f => r.flags.includes(f))) {
        credential = `[pscredential]::new(${qPs(u)}, (ConvertTo-SecureString ${qPs(p)} -AsPlainText -Force))`;
      } else hdrs.push([qPs('Authorization'), `'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${qPs(u + ':' + p)}))`]);
    }

    P.unshift(['Uri', qPs(n.url)]);
    const M = n.method;
    if (M !== 'GET' || (n.body && legacy)) {
      const std = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'MERGE'];
      if (std.includes(M)) P.push(['Method', qPs(M[0] + M.slice(1).toLowerCase())]);
      else if (!legacy) P.push(['CustomMethod', qPs(M)]);
      else notes.push(`Windows PowerShell 5.1 cannot send ${M} requests; use the curl.exe output.`);
    }
    if (M === 'GET' && n.body && legacy) notes.push('Windows PowerShell 5.1 cannot send a body with GET; use the curl.exe output.');
    if (hdrs.length) P.push(['Headers', psHash(hdrs, '    ')]);
    if (ct != null) P.push(['ContentType', qPs(ct)]);
    if (ua != null) P.push(['UserAgent', qPs(ua)]);
    if (cookie != null) {
      const host = n.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/^[^@]*@/, '').replace(/:\d+$/, '');
      pre.push('# Windows PowerShell 5.1 ignores a Cookie header, so the cookies go into a web session.',
        '$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession');
      for (const part of cookie.split(/;\s*/).filter(Boolean)) {
        const eq = part.indexOf('=');
        pre.push(`$session.Cookies.Add((New-Object System.Net.Cookie(${qPs(eq < 0 ? part : part.slice(0, eq))}, ${qPs(eq < 0 ? '' : part.slice(eq + 1))}, '/', ${qPs(host)})))`);
      }
      P.push(['WebSession', '$session']);
    }
    if (credential) P.push(['Credential', credential]);

    if (n.form.length) {
      if (legacy) notes.push('Windows PowerShell 5.1 has no -Form parameter; use the curl.exe output for multipart uploads.');
      else {
        const groups = new Map();
        for (const f of n.form) {
          if (f.attrs && f.attrs.length) notes.push(`Form field ${f.name}: ${f.attrs.join('; ')} was not converted; PowerShell sets the part type itself.`);
          const code = f.file != null
            ? (f.content ? `(Get-Content -Raw -LiteralPath ${qPs(f.file)})` : `(Get-Item -LiteralPath ${qPs(f.file)})`)
            : qPs(f.value);
          groups.set(f.name, (groups.get(f.name) || []).concat(code));
        }
        P.push(['Form', psHash([...groups].map(([k, v]) => [qPs(k), v.length > 1 ? '@(' + v.join(', ') + ')' : v[0]]), '    ')]);
      }
    } else if (n.body) {
      if (n.body.file != null) {
        P.push(['InFile', qPs(n.body.file)]);
        if (n.body.strip) notes.push('curl -d @file removes line breaks from the file; -InFile sends it as is (like --data-binary).');
        if (n.body.encode) notes.push('URL-encoding a file body was not converted; encode the file first.');
      } else P.push(['Body', psBody(n.body.text)]);
    }
    if (r.output) P.push(['OutFile', qPs(r.output)]);
    if (r.insecure) {
      if (legacy) pre.push('# Windows PowerShell 5.1 has no -SkipCertificateCheck. This turns off certificate checks for the rest of the session.',
        '[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }');
      else P.push(['SkipCertificateCheck', '$true']);
    }
    if (r.maxRedirs != null) P.push(['MaximumRedirection', String(r.maxRedirs)]);
    const t = r.maxTime ?? r.connectTimeout;
    if (t != null) {
      P.push(['TimeoutSec', String(Math.ceil(Number(t)))]);
      if (r.maxTime == null) notes.push('Used --connect-timeout as -TimeoutSec, which limits the whole request.');
    }
    if (r.proxy) P.push(['Proxy', qPs(hasScheme(r.proxy) ? r.proxy : 'http://' + r.proxy)]);
    if (!legacy) {
      if (r.flags.includes('location-trusted')) P.push(['PreserveAuthorizationOnRedirect', '$true']);
      const hv = { 'http1.0': '1.0', 'http1.1': '1.1', http2: '2.0', http3: '3.0' };
      const f = r.flags.find(x => hv[x]);
      if (f) P.push(['HttpVersion', qPs(hv[f])]);
    }
    if (r.flags.includes('no-keepalive')) P.push(['DisableKeepAlive', '$true']);
    if (legacy && cmdlet === 'Invoke-WebRequest') P.push(['UseBasicParsing', '$true']);
    if (r.flags.includes('include') && cmdlet === 'Invoke-RestMethod') notes.push('curl -i shows response headers; use Invoke-WebRequest to see them.');
    if (r.flags.includes('verbose')) notes.push('Add -Verbose to see request details.');
    for (const e of r.extra) notes.push(`Not converted: ${e.join(' ')}`);

    const head = pre.length ? pre.join('\n') + '\n' : '';
    const multiline = P.some(([, v]) => v.includes('\n'));
    if (P.length <= 2 && !multiline) {
      return { code: head + cmdlet + ' ' + P.map(([k, v]) => v === '$true' ? '-' + k : `-${k} ${v}`).join(' '), notes };
    }
    return { code: head + '$params = ' + psHash(P, '') + '\n' + cmdlet + ' @params', notes };
  }

  // ---------- public API ----------
  function detect(src) {
    const s = src.trim();
    if (/(^|[\s;(=|&])(Invoke-(WebRequest|RestMethod)|iwr|irm)(?=\s|$)/i.test(s) || /(^|\n)\s*\$\w+(\.\w+)*\s*=/.test(s) || /New-Object\s/i.test(s)) return 'powershell';
    if (/\^\s*\n/.test(s) || /\^"/.test(s)) return 'cmd';
    if (/`\s*\n/.test(s)) return 'powershell';
    if (/(^|\s)curl\.exe(\s|$)/i.test(s)) return /\\\s*\n/.test(s) ? 'bash' : /'/.test(s) || /--%/.test(s) ? 'powershell' : 'cmd';
    return 'bash';
  }

  function parse(src, dialect) {
    const d = !dialect || dialect === 'auto' ? detect(src) : dialect;
    const warnings = [];
    let r;
    if (d === 'powershell') r = parsePowerShell(src, warnings);
    else r = parseCurlArgs(d === 'cmd' ? tokenizeCmd(src, warnings) : tokenizeBash(src, warnings), newReq());
    cleanJsonBodies(r);
    r.warnings = [...new Set(warnings.concat(r.warnings))];
    r.notes = [...new Set(r.notes)];
    return { req: r, dialect: d };
  }

  const TARGETS = {
    bash: { label: 'Bash / zsh', emit: (r, o) => emitCurl(r, 'bash', o) },
    cmd: { label: 'cmd', emit: (r, o) => emitCurl(r, 'cmd', o) },
    'ps-curl': { label: 'PowerShell curl.exe', emit: (r, o) => emitCurl(r, 'ps', o) },
    'ps-irm': { label: 'Invoke-RestMethod', emit: (r, o) => emitPs(r, 'Invoke-RestMethod', o) },
    'ps-iwr': { label: 'Invoke-WebRequest', emit: (r, o) => emitPs(r, 'Invoke-WebRequest', o) },
  };
  const emit = (r, target, opts) => TARGETS[target].emit(r, opts || {});

  // Plain summary of what goes over the wire, for the page and for tests.
  function summary(r) {
    const { n } = normalize(r);
    return { method: n.method, url: n.url, headers: n.headers, user: n.user,
      body: n.body ? (n.body.file != null ? { file: n.body.file } : { text: n.body.text }) : null,
      form: n.form.map(f => ({ name: f.name, value: f.value, file: f.file })),
      insecure: r.insecure, output: r.output };
  }

  return { parse, emit, detect, summary, TARGETS, crtSplit, unb64 };
});
