// A small key-value store in a JSON file, with the same get/put/delete calls as Cloudflare KV,
// so the Worker's handlers run unchanged on the server.
import fs from "node:fs";

export function fileStore(path) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    // first run: start empty
  }
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fs.writeFileSync(path, JSON.stringify(data)), 200);
  };
  return {
    async get(key) {
      const e = data[key];
      if (!e) return null;
      if (e.exp && e.exp < Date.now()) {
        delete data[key];
        save();
        return null;
      }
      return e.v;
    },
    async put(key, value, opts = {}) {
      data[key] = { v: String(value), ...(opts.expirationTtl ? { exp: Date.now() + opts.expirationTtl * 1000 } : {}) };
      save();
    },
    async delete(key) {
      delete data[key];
      save();
    },
  };
}
