// Minimal EIP-1193 wallet: connect, switch chain, and the four vault calls the app makes.
// Calldata is encoded by hand (static types only); selectors were taken from `cast sig`.
const SEL = {
  approve: "0x095ea7b3",
  allowance: "0xdd62ed3e",
  balanceOf: "0x70a08231",
  deposit: "0x6e553f65",
  redeem: "0x7bde82f2",
  convertToAssets: "0x07a2d13a",
};

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const addr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

export const calldata = {
  approve: (spender, amount) => SEL.approve + addr(spender) + word(amount),
  allowance: (owner, spender) => SEL.allowance + addr(owner) + addr(spender),
  balanceOf: (owner) => SEL.balanceOf + addr(owner),
  deposit: (assets, receiver) => SEL.deposit + word(assets) + addr(receiver),
  redeem: (shares, receiver) => SEL.redeem + word(shares) + addr(receiver),
  convertToAssets: (shares) => SEL.convertToAssets + word(shares),
};

/** Parse a decimal string into 18-decimal base units without floating point. */
export function toUnits(text, decimals = 18) {
  const t = String(text).trim();
  if (!/^\d*(\.\d*)?$/.test(t) || t === "" || t === ".") return null;
  const [i, f = ""] = t.split(".");
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function fromUnits(v, decimals = 18) {
  return Number(v) / 10 ** decimals;
}

export class Wallet {
  constructor(chain) {
    this.chain = chain; // { id, name, rpc }
    this.account = null;
    this.listeners = new Set();
    this.eth = window.ethereum ?? null;
    this.eth?.on?.("accountsChanged", (a) => { this.account = a[0] ?? null; this.emit(); });
    this.eth?.on?.("chainChanged", () => this.emit());
  }
  on(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
  get available() { return !!this.eth; }

  async connect() {
    if (!this.eth) throw new Error("No browser wallet found. Install one that supports custom EVM networks.");
    const [a] = await this.eth.request({ method: "eth_requestAccounts" });
    this.account = a;
    await this.ensureChain();
    this.emit();
    return a;
  }

  async ensureChain() {
    const hex = "0x" + this.chain.id.toString(16);
    const current = await this.eth.request({ method: "eth_chainId" });
    if (current === hex) return;
    try {
      await this.eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await this.eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex, chainName: this.chain.name, nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: [this.chain.rpc] }],
      });
    }
  }

  async call(to, data) {
    return this.eth.request({ method: "eth_call", params: [{ to, data }, "latest"] });
  }

  async send(to, data) {
    await this.ensureChain();
    const hash = await this.eth.request({ method: "eth_sendTransaction", params: [{ from: this.account, to, data }] });
    for (let i = 0; i < 120; i++) {
      const r = await this.eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
      if (r) {
        if (r.status !== "0x1") throw Object.assign(new Error("Transaction reverted"), { hash });
        return hash;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    return hash;
  }
}
