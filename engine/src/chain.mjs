// Network bindings and the minimal ABIs the engine reads. Every venue signature below is
// copied from the markets-sdk read ABIs (0.32.1); the vault ABI comes from the Foundry build.
import { createPublicClient, http, parseAbi, defineChain } from "viem";
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { hidekiTestnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";

export const NETWORKS = {
  hideki: {
    key: "hideki",
    label: "Somnia Hideki",
    chain: hidekiTestnet,
    rpc: process.env.HIDEKI_RPC || hidekiTestnet.rpcUrls.default.http[0],
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    indexerUrl: "https://hideki-dev.smk.somnia.host/v1/graphql",
    explorer: null, // no public explorer is published for Hideki
  },
  shannon: {
    key: "shannon",
    label: "Somnia Shannon",
    chain: somniaShannon,
    rpc: process.env.SHANNON_RPC || "https://dream-rpc.somnia.network",
    addresses: SOMNIA_TESTNET_ADDRESSES,
    indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
    explorer: "https://shannon-explorer.somnia.network",
  },
};

export function publicClient(net) {
  const chain = defineChain({ ...net.chain, rpcUrls: { default: { http: [net.rpc] } } });
  return createPublicClient({ chain, transport: http(net.rpc, { batch: false, timeout: 30_000, retryCount: 2 }) });
}

export const bankAbi = parseAbi([
  "function getSideHoldersPaginated(address pool, bool isLong, uint256 start, uint256 count) view returns (address[] holders)",
  "function getPosition(address account, address perpPool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))",
  "function getAccountHealth(address account) view returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq)",
  "function getBankruptcyPrice(address account, address perpPool) view returns (uint256 price)",
  "function getWithdrawableCollateral(address account) view returns (uint256)",
  "function getAccountState(address account) view returns ((int256 unlockedCollateralBalance, uint256 lockedCollateral, address[] activePerpPools))",
  "event PositionUpdated(address indexed account, address indexed perpPool, int128 newSize, uint128 avgEntryPrice, int256 realizedPnl, int256 entryFundingIndex)",
]);

export const poolAbi = parseAbi([
  "function getHealthSnapshot() view returns ((uint256 oneBase, uint256 markPrice, int256 projectedCumulativeFunding, uint256 effectiveIMFBps, uint256 maintenanceMarginBps, uint256 closeOutMarginBps) snapshot)",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
]);

export const vaultAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function pools() view returns (address[])",
  "function liveSlots(address pool) view returns (uint64[])",
  "function exposure(address pool) view returns (uint256)",
  "function MARKET_CAP_BPS() view returns (uint256)",
  "function CLUSTER_CAP_BPS() view returns (uint256)",
  "function UNWIND_SPREAD_BPS() view returns (uint256)",
  "function ASSET() view returns (address)",
  "function BANK() view returns (address)",
  "function getSlot(uint64 slotId) view returns ((address pool, bool isBid, bool unwind, bool live, uint128 orderId, uint256 price, uint256 quantity, address[] backers))",
  "function place(address pool, bool isBid, uint256 price, uint256 quantity, address[] backers) returns (uint64)",
  "function refreshPool(address pool)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "event Placed(uint64 indexed slotId, address indexed pool, bool isBid, uint256 price, uint256 quantity, uint128 orderId, address[] backers)",
  "event Released(uint64 indexed slotId, address indexed pool, uint8 reason)",
  "event Caught(address indexed pool, int128 newSize, uint128 avgEntryPrice)",
  "event Unwinding(uint64 indexed slotId, address indexed pool, bool isBid, uint256 price, uint256 quantity, uint128 orderId)",
  "event Deposited(address indexed owner, uint256 assets, uint256 shares)",
  "event Redeemed(address indexed owner, uint256 shares, uint256 assets)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);
