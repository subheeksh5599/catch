// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The dreamDEX perps surface Catch touches. Every signature is transcribed from the
/// venue's published ABIs (markets-sdk 0.32.1: perpPoolWriteAbi, perpPoolReadAbi,
/// marginBankWriteAbi, marginBankReadAbi, orderBook reads).

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface IMarginBank {
    struct Position {
        int128 size;
        uint128 avgEntryPrice;
        int256 entryFundingIndex;
        uint64 lastUpdatedTimestampNs;
    }

    struct AccountState {
        int256 unlockedCollateralBalance;
        uint256 lockedCollateral;
        address[] activePerpPools;
    }

    struct SystemConfig {
        address marginBank;
        address collateralToken;
        address perpPoolFactory;
        address liquidationEngine;
        address insuranceFund;
        address feeRecipient;
        uint16 maxLeverageLimit;
        bool fullyWired;
    }

    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;

    function getSystemConfig() external view returns (SystemConfig memory);
    function getPosition(address account, address perpPool) external view returns (Position memory);
    function getAccountState(address account) external view returns (AccountState memory);
    function tryGetAccountEquity(address account) external view returns (bool ok, int256 equity);
    function getWithdrawableCollateral(address account) external view returns (uint256);
    function getAccountHealth(address account)
        external
        view
        returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq);
    function getBankruptcyPrice(address account, address perpPool) external view returns (uint256 price);
    function isPerpPoolRegistered(address perpPool) external view returns (bool);
}

interface IPerpPool {
    struct HealthSnapshot {
        uint256 oneBase;
        uint256 markPrice;
        int256 projectedCumulativeFunding;
        uint256 effectiveIMFBps;
        uint256 maintenanceMarginBps;
        uint256 closeOutMarginBps;
    }

    struct BookParameters {
        uint256 tickSize;
        uint256 minQuantity;
        uint256 lotSize;
    }

    struct Order {
        uint128 orderId;
        bool isBid;
        address owner;
        uint64 userData;
        uint256 price;
        uint256 fullQuantity;
        uint256 quantityRemaining;
        uint64 expireTimestampNs;
    }

    function placeOrder(
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k
    ) external;

    function cancelOrder(uint128 orderId) external;

    function marginBank() external view returns (address);
    function isRestricted() external view returns (bool);
    function getHealthSnapshot() external view returns (HealthSnapshot memory);
    function getOrderBookParameters() external view returns (BookParameters memory);
    function getOrder(uint128 orderId) external view returns (Order memory);
    function getOwnOpenOrders() external view returns (uint128[] memory);
}

/// @notice Somnia reactivity: the precompile calls `onEvent` on a subscribed handler.
interface ISomniaEventHandler {
    function onEvent(address emitter, bytes32[] calldata eventTopics, bytes calldata data) external;
}
