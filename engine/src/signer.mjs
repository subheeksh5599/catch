// Loads the operator key from a 0600 file outside the repo. The key is never printed, logged,
// or passed on a command line; scripts receive a viem account object only.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, defineChain } from "viem";

export function loadAccount() {
  const file = process.env.CATCH_KEY_FILE || join(homedir(), ".catch", "deployer.key");
  const mode = statSync(file).mode & 0o077;
  if (mode) throw new Error(`${file} is readable by others; chmod 600 it`);
  return privateKeyToAccount(readFileSync(file, "utf8").trim());
}

export function walletFor(net, account) {
  const chain = defineChain({ ...net.chain, rpcUrls: { default: { http: [net.rpc], webSocket: net.chain.rpcUrls.default.webSocket } } });
  return createWalletClient({ account, chain, transport: http(net.rpc, { timeout: 60_000 }) });
}
