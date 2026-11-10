#!/bin/zsh
# Reproduces: getBankruptcyPrice returns avgEntryPrice for short positions. Read-only, no key.
H=https://api.hideki2.infra.testnet.somnia.network
B=0x478769E1177C0773c43A593DCCc4Ad15F15F1394
P=${1:-0x63B47eD4A7DE0FdE659b0d82441dD74828b7297A}
BLK=$(cast block-number --rpc-url $H)
echo "block $BLK pool $P"
echo "mark $(cast call $P 'getHealthSnapshot()((uint256,uint256,int256,uint256,uint256,uint256))' --rpc-url $H -b $BLK | cut -d, -f2)"
for side in false true; do
  for a in $(cast call $B 'getSideHoldersPaginated(address,bool,uint256,uint256)(address[])' $P $side 0 8 --rpc-url $H -b $BLK | tr -d '[] ' | tr ',' ' '); do
    pos=$(cast call $B 'getPosition(address,address)((int128,uint128,int256,uint64))' $a $P --rpc-url $H -b $BLK)
    size=$(echo $pos | tr -d '()' | cut -d, -f1 | awk '{print $1}')
    entry=$(echo $pos | tr -d '()' | cut -d, -f2 | awk '{print $1}')
    bk=$(cast call $B 'getBankruptcyPrice(address,address)(uint256)' $a $P --rpc-url $H -b $BLK | awk '{print $1}')
    eq=$(cast call $B 'getAccountHealth(address)(int256,uint256,uint256,uint256)' $a --rpc-url $H -b $BLK | head -1 | awk '{print $1}')
    same=$([ "$bk" = "$entry" ] && echo "bankruptcy == entry" || echo "")
    echo "$([ $side = true ] && echo long || echo short) $a size $size entry $entry bankruptcy $bk equity $eq $same"
  done
done
