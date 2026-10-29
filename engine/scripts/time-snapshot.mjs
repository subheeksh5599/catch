// Time each stage of one pool snapshot against the live RPC.  node scripts/time-snapshot.mjs [pool]
import { NETWORKS, publicClient, bankAbi } from "../src/chain.mjs";

const net = NETWORKS.hideki;
const c = publicClient(net);
const pool = process.argv[2] || "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0";
const bank = net.addresses.marginBank;
const t0 = Date.now();
const lap = (label) => console.log(((Date.now() - t0) / 1000).toFixed(1) + "s", label);
const blockNumber = await c.getBlockNumber();
lap("head " + blockNumber);
const longs = await c.readContract({ address: bank, abi: bankAbi, functionName: "getSideHoldersPaginated", args: [pool, true, 0n, 800n], blockNumber });
lap(`holders page 1: ${longs.length}`);
const calls = longs.slice(0, 200).map((a) => ({ address: bank, abi: bankAbi, functionName: "getPosition", args: [a, pool] }));
await c.multicall({ contracts: calls, allowFailure: true, blockNumber, batchSize: 0 });
lap("multicall 200 positions (pinned block)");
await c.multicall({ contracts: calls, allowFailure: true, batchSize: 0 });
lap("multicall 200 positions (latest)");
const health = longs.slice(0, 400).flatMap((a) => [{ address: bank, abi: bankAbi, functionName: "getPosition", args: [a, pool] }, { address: bank, abi: bankAbi, functionName: "getAccountHealth", args: [a] }]);
await c.multicall({ contracts: health, allowFailure: true, blockNumber, batchSize: 0 });
lap("multicall 400 position+health (one chunk of 800)");
const { snapshotPool } = await import("../src/reader.mjs");
const full = await snapshotPool(c, { bank, pool });
lap(`full snapshot: ${full.positions.length} positions (READ_CONCURRENCY=${process.env.READ_CONCURRENCY || 10})`);
process.exit(0);
