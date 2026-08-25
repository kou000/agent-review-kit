/* ---------- api ---------- */

export function api(method: string, url: string, body?: any) {
  return fetch(url, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) { throw new Error(res.status + ' ' + t); });
    }
    return res.json();
  });
}
