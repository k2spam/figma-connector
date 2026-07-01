// Minimal HTTP client on Node's built-in https/http modules — no global fetch
// required, so the plugin runs on any Node version and any host runtime.

const https = require("https");
const http = require("http");
const { URL } = require("url");

// GET a URL, following redirects. Resolves { status, ok, headers, buffer }.
function get(url, { headers = {}, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error(`Bad URL: ${url}`));
    }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(u, { method: "GET", headers }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume(); // drain
        const next = new URL(res.headers.location, u).toString();
        get(next, { headers, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: res.headers,
          buffer: Buffer.concat(chunks),
        })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

// Convenience: GET and parse JSON.
async function getJson(url, opts) {
  const res = await get(url, opts);
  let json = null;
  const text = res.buffer.toString("utf8");
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    /* leave json null; caller inspects text */
  }
  return { ...res, text, json };
}

module.exports = { get, getJson };
