#!/usr/bin/env python3
"""Local JSON-RPC shim so Foundry can fork Somnia Hideki.

The Hideki RPC rejects EIP-1898 block objects ({"blockNumber": "0x.."} / {"blockHash": ..})
and answers empty storage with "0x" instead of a 32-byte word. This rewrites both and forwards
everything else unchanged. Read-only: it never signs or sends anything of its own.

    python3 contracts/script/hideki-fork-rpc.py 8547 &
    HIDEKI_RPC=http://127.0.0.1:8547 forge test --match-contract TakeoverFork -vv
"""
import json, sys, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://api.hideki2.infra.testnet.somnia.network"
BLOCK_ARG = {"eth_getBalance": 1, "eth_getTransactionCount": 1, "eth_getCode": 1, "eth_getStorageAt": 2,
             "eth_call": 1, "eth_estimateGas": 1, "eth_getProof": 2}


_hash_to_number = {}


def _number_of(block_hash):
    # historical state is served by number only; resolve a hash once and cache it
    if block_hash not in _hash_to_number:
        b = forward({"jsonrpc": "2.0", "id": 0, "method": "eth_getBlockByHash", "params": [block_hash, False]})
        _hash_to_number[block_hash] = (b.get("result") or {}).get("number", "latest")
    return _hash_to_number[block_hash]


def fix_params(m):
    i = BLOCK_ARG.get(m.get("method"))
    p = m.get("params") or []
    if i is not None and len(p) > i:
        if isinstance(p[i], dict):
            p[i] = p[i].get("blockNumber") or _number_of(p[i].get("blockHash"))
        elif isinstance(p[i], str) and len(p[i]) == 66:
            p[i] = _number_of(p[i])
    return m


def fix_result(req, res):
    if req.get("method") == "eth_getStorageAt" and res.get("result") in ("0x", "", None) and "error" not in res:
        res["result"] = "0x" + "0" * 64
    return res


def forward(body):
    r = urllib.request.Request(UPSTREAM, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(r, timeout=120) as f:
        return json.load(f)


class H(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if isinstance(body, list):
            reqs = [fix_params(m) for m in body]
            out = forward(reqs)
            byid = {r["id"]: r for r in reqs}
            out = [fix_result(byid.get(r.get("id"), {}), r) for r in out]
        else:
            req = fix_params(body)
            out = fix_result(req, forward(req))
            if "error" in out and len(sys.argv) > 2:
                print(json.dumps(req)[:300], "->", json.dumps(out["error"])[:200], flush=True)
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8547), H).serve_forever()
