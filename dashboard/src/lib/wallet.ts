// Minimal EIP-1193 wallet: connect, switch chain, and the vault calls the dashboard makes.
// Calldata is encoded by hand (static types only); selectors were taken from `cast sig`.
const SEL = {
  approve: "0x095ea7b3",
  allowance: "0xdd62ed3e",
  balanceOf: "0x70a08231",
  deposit: "0x6e553f65",
  redeem: "0x7bde82f2",
  convertToAssets: "0x07a2d13a",
  unlockAt: "0x89b7e586",
}

const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, "0")
const addr = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0")

export const calldata = {
  approve: (spender: string, amount: bigint) => SEL.approve + addr(spender) + word(amount),
  allowance: (owner: string, spender: string) => SEL.allowance + addr(owner) + addr(spender),
  balanceOf: (owner: string) => SEL.balanceOf + addr(owner),
  deposit: (assets: bigint, receiver: string) => SEL.deposit + word(assets) + addr(receiver),
  redeem: (shares: bigint, receiver: string) => SEL.redeem + word(shares) + addr(receiver),
  convertToAssets: (shares: bigint) => SEL.convertToAssets + word(shares),
  unlockAt: (owner: string) => SEL.unlockAt + addr(owner),
}

/** Parse a decimal string into 18-decimal base units without floating point. */
export function toUnits(text: string, decimals = 18): bigint | null {
  const t = String(text).trim()
  if (!/^\d*(\.\d*)?$/.test(t) || t === "" || t === ".") return null
  const [i, f = ""] = t.split(".")
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0")
}

export const fromUnits = (v: bigint, decimals = 18) => Number(v) / 10 ** decimals

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>
  on?: (event: string, fn: (...a: any[]) => void) => void
}

declare global {
  interface Window {
    ethereum?: Eip1193
  }
}

export type Chain = { id: number; name: string; rpc: string }

export class Wallet {
  chain: Chain
  account: string | null = null
  private listeners = new Set<() => void>()
  private eth: Eip1193 | null

  constructor(chain: Chain) {
    this.chain = chain
    this.eth = window.ethereum ?? null
    this.eth?.on?.("accountsChanged", (a: string[]) => {
      this.account = a[0] ?? null
      this.emit()
    })
    this.eth?.on?.("chainChanged", () => this.emit())
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  private emit() {
    for (const fn of this.listeners) fn()
  }
  get available() {
    return !!this.eth
  }

  async connect() {
    if (!this.eth) throw new Error("No browser wallet found. Install one that supports custom EVM networks.")
    const [a] = await this.eth.request({ method: "eth_requestAccounts" })
    this.account = a
    await this.ensureChain()
    this.emit()
    return a as string
  }

  async ensureChain() {
    if (!this.eth) return
    const hex = "0x" + this.chain.id.toString(16)
    const current = await this.eth.request({ method: "eth_chainId" })
    if (current === hex) return
    try {
      await this.eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] })
    } catch (e: any) {
      if (e?.code !== 4902) throw e
      await this.eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex, chainName: this.chain.name, nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: [this.chain.rpc] }],
      })
    }
  }

  async call(to: string, data: string): Promise<string> {
    if (!this.eth) throw new Error("No wallet")
    return this.eth.request({ method: "eth_call", params: [{ to, data }, "latest"] })
  }

  async send(to: string, data: string): Promise<string> {
    if (!this.eth) throw new Error("No wallet")
    await this.ensureChain()
    const hash: string = await this.eth.request({ method: "eth_sendTransaction", params: [{ from: this.account, to, data }] })
    for (let i = 0; i < 120; i++) {
      const r = await this.eth.request({ method: "eth_getTransactionReceipt", params: [hash] })
      if (r) {
        if (r.status !== "0x1") throw Object.assign(new Error("Transaction reverted"), { hash })
        return hash
      }
      await new Promise((res) => setTimeout(res, 1000))
    }
    return hash
  }
}
