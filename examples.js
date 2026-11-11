/* Sample commands for the page's example picker and for the tests. */
(function (root, list) {
  if (typeof module === 'object' && module.exports) module.exports = list;
  else root.CurlExamples = list;
})(typeof globalThis !== 'undefined' ? globalThis : this, [
  {
    id: 'json-post', label: 'JSON POST with a token (bash)', dialect: 'bash',
    code: String.raw`curl -X POST 'https://api.example.com/v1/orders' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.demo' \
  -H 'Content-Type: application/json' \
  -d '{"customer":"O'\''Brien","items":[{"sku":"A-100","qty":2}],"note":"50% off & free shipping"}'`,
  },
  {
    id: 'dataverse', label: 'Dataverse Web API query (bash)', dialect: 'bash',
    code: String.raw`curl 'https://contoso.crm4.dynamics.com/api/data/v9.2/accounts?$select=name,revenue&$top=3' \
  -H 'Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOi.demo' \
  -H 'OData-MaxVersion: 4.0' \
  -H 'OData-Version: 4.0' \
  -H 'Accept: application/json'`,
  },
  {
    id: 'chrome-ps', label: 'Chrome "Copy as PowerShell"', dialect: 'powershell',
    code: String.raw`$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$session.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
$session.Cookies.Add((New-Object System.Net.Cookie("sid", "abc123", "/", "app.example.com")))
Invoke-WebRequest -UseBasicParsing -Uri "https://app.example.com/api/search" ` + '`' + String.raw`
-Method "POST" ` + '`' + String.raw`
-WebSession $session ` + '`' + String.raw`
-Headers @{
"authority"="app.example.com"
  "accept"="application/json"
  "origin"="https://app.example.com"
} ` + '`' + String.raw`
-ContentType "application/json" ` + '`' + String.raw`
-Body "{` + '`"query`":`"invoice 2026`",`"page`":1}"',
  },
  {
    id: 'chrome-cmd', label: 'Chrome "Copy as cURL (cmd)"', dialect: 'cmd',
    code: String.raw`curl ^"https://app.example.com/api/search^" ^
  -H ^"accept: application/json^" ^
  -H ^"content-type: application/json^" ^
  --data-raw ^"^{^\^"query^\^":^\^"invoice 2026^\^",^\^"page^\^":1^}^"`,
  },
  {
    id: 'postman', label: 'Postman PowerShell snippet', dialect: 'powershell',
    code: '$headers = New-Object "System.Collections.Generic.Dictionary[[String],[String]]"\n' +
      '$headers.Add("Content-Type", "application/json")\n' +
      '$headers.Add("Authorization", "Basic dXNlcjpwYXNz")\n\n' +
      '$body = @"\n{\n  `"name`": `"Ana`",\n  `"active`": true\n}\n"@\n\n' +
      "$response = Invoke-RestMethod 'https://api.example.com/users' -Method 'POST' -Headers $headers -Body $body\n" +
      '$response | ConvertTo-Json',
  },
  {
    id: 'upload', label: 'File upload with basic auth (bash)', dialect: 'bash',
    code: String.raw`curl -F 'file=@report.pdf;type=application/pdf' -F 'title=Q3 report' -u admin:s3cr3t -k https://files.example.com/upload`,
  },
  {
    id: 'ps51-curl', label: 'curl.exe in Windows PowerShell 5.1', dialect: 'powershell',
    code: String.raw`curl.exe -X PATCH "https://api.example.com/items/42" -H "Content-Type: application/json" -d '{\"status\":\"done\"}'`,
  },
  {
    id: 'json-comments', label: 'JSON body with comments (bash)', dialect: 'bash',
    code: String.raw`curl -X PUT 'https://api.example.com/v1/settings' \
  -H 'Content-Type: application/json' \
  -d '{
  // display options
  "theme": "dark", /* or "light" */
  "homepage": "https://example.com/start", // the // inside the URL stays
  "retries": 3,
  // "debug": true,
}'`,
  },
  {
    id: 'tricky', label: 'Tricky characters (bash)', dialect: 'bash',
    code: String.raw`curl 'https://api.example.com/echo?q=caf%C3%A9&x=1&y=$z' \
  -H 'X-Note: it'\''s "quoted" & 100% ^up $HOME ` + '`tick`' + String.raw` \back' \
  --data-binary $'line1 it\'s "q" & 100% ^ $HOME ` + '`t`' + String.raw` \\x\\ é\nline2'`,
  },
]);
