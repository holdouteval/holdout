// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PoolKey} from "../../src/interfaces/Types.sol";

library ForkCatalog {
    struct Entry {
        string symbol;
        address token;
        address feed;
        PoolKey key;
        bytes32 poolId;
    }

    address internal constant USDG = address(bytes20(hex"5fc5360d0400a0fd4f2af552add042d716f1d168"));

    function at(uint256 index) internal pure returns (Entry memory e) {
        if (index == 0) {
            e.symbol = "NBIS";
            e.token = address(bytes20(hex"9d9c6684f596f66a64c030b93a886d51fd4d7931"));
            e.feed = address(bytes20(hex"e1d87b116ba0fe898998f1d140339d1fa1e09705"));
            e.key = _key(e.token, 9900, 99, address(0));
            e.poolId = 0x7c2f9ce1214ba9baf56d1b6a1fc640c1b63e9a711172c0c7d10e5a9c4a3d4f0c;
            return e;
        }
        if (index == 1) {
            e.symbol = "SNDK";
            e.token = address(bytes20(hex"b90a19ff0af67f7779aff50a882a9cff42446400"));
            e.feed = address(bytes20(hex"fb133fa4b7b385802b693a293606682df47109a3"));
            e.key = _key(e.token, 10000, 200, address(0));
            e.poolId = 0x2707cb88a6a40fa0f948f58958051ba097d6f6a3cf7f87929bd68ccc5becea24;
            return e;
        }
        if (index == 2) {
            e.symbol = "MSTR";
            e.token = address(bytes20(hex"ec262a75e413fafd0df80480274532c79d42da09"));
            e.feed = address(bytes20(hex"396118bdfb181e6240e74d243f266b061c0edc3d"));
            e.key = _key(e.token, 2500, 25, address(0));
            e.poolId = 0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe;
            return e;
        }
        if (index == 3) {
            e.symbol = "AMD";
            e.token = address(bytes20(hex"86923f96303d656e4aa86d9d42d1e57ad2023fdc"));
            e.feed = address(bytes20(hex"943a29e7ae51a4798823ca9eed2ed533b2a22c72"));
            e.key = _key(e.token, 10000, 200, address(0));
            e.poolId = 0xde9f85fdd9e05a943a52f2c69ffafe3064a3287df03d02c9b431bc92d4781274;
            return e;
        }
        if (index == 4) {
            e.symbol = "MU";
            e.token = address(bytes20(hex"ff080c8ce2e5feadaca0da81314ae59d232d4afd"));
            e.feed = address(bytes20(hex"425eefdcf05ed6526c3ce61af99429a228a6d596"));
            e.key = _key(e.token, 800, 8, address(0));
            e.poolId = 0x9eb78b6b9512b42d20cc11a93385da7145c7c1c5269e7434cfc2fdb4d4ba3f38;
            return e;
        }
        if (index == 5) {
            e.symbol = "CRCL";
            e.token = address(bytes20(hex"df0992e440dd0be65bd8439b609d6d4366bf1cb5"));
            e.feed = address(bytes20(hex"6652edf64ba3731c4f2d3ce821a0fb1f1f6b482a"));
            e.key = _key(e.token, 8388608, 60, address(bytes20(hex"5eb87f69be00df39981622fd60a8de4b7837e080")));
            e.poolId = 0xdb9c34002d173981250969293af6f43f42a26f2110f19893bbe2ad373375e9e6;
            return e;
        }
        if (index == 6) {
            e.symbol = "COIN";
            e.token = address(bytes20(hex"6330d8c3178a418788df01a47479c0ce7ccf450b"));
            e.feed = address(bytes20(hex"a3a468a452940b7d6b69991207b508c609a98ef2"));
            e.key = _key(e.token, 8388608, 60, address(bytes20(hex"5eb87f69be00df39981622fd60a8de4b7837e080")));
            e.poolId = 0x8138ea2894ce8f825d830569df6faf33e55344290954ce22432ca4f11913bacc;
            return e;
        }
        if (index == 7) {
            e.symbol = "SPCX";
            e.token = address(bytes20(hex"4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea"));
            e.feed = address(bytes20(hex"b265810950ba6c5c0ff821c9963014a56fd8bffb"));
            e.key = _key(e.token, 8388608, 10, address(bytes20(hex"5eb87f69be00df39981622fd60a8de4b7837e080")));
            e.poolId = 0xb81d873dfb2bb1aaf08804053f8940fd06bb30a2b5a0fafcdbcc7325544452b9;
            return e;
        }
        if (index == 8) {
            e.symbol = "PLTR";
            e.token = address(bytes20(hex"894e1ec2d74ffe5aef8dc8a9e84686accb964f2a"));
            e.feed = address(bytes20(hex"820abedff239034956b7a9d2f0a331f9f075eb4c"));
            e.key = _key(e.token, 10000, 200, address(0));
            e.poolId = 0xee430ee1003e1985e1828a01b9a20dad67ad4302994fe2abb4a173de4ac54623;
            return e;
        }
        if (index == 9) {
            e.symbol = "NVDA";
            e.token = address(bytes20(hex"d0601ce157db5bdc3162bbac2a2c8af5320d9eec"));
            e.feed = address(bytes20(hex"379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15"));
            e.key = _key(e.token, 8388608, 10, address(bytes20(hex"66622f77b797d506e5376f7798b67ab288966080")));
            e.poolId = 0x7990aad9e8fb048f49a155a7df5603db0366f0657035b78eb4196395cccb3dcd;
            return e;
        }
        if (index == 10) {
            e.symbol = "TSLA";
            e.token = address(bytes20(hex"322f0929c4625ed5bad873c95208d54e1c003b2d"));
            e.feed = address(bytes20(hex"4a1166a659a55625345e9515b32adecea5547c38"));
            e.key = _key(e.token, 8388608, 10, address(bytes20(hex"67d86050d22d574df046f3d90f722045f714e080")));
            e.poolId = 0xd5effce87036cd858146c0c15fa825c231a9de1843200ca108e431e431331e8e;
            return e;
        }
        if (index == 11) {
            e.symbol = "TSM";
            e.token = address(bytes20(hex"58ffe4a942d3885baa22d7520691f611ef09e7aa"));
            e.feed = address(bytes20(hex"874cf94aa8ec88fd9560094dd065f2fb3e41fc2f"));
            e.key = _key(e.token, 7500, 75, address(0));
            e.poolId = 0x0ba5d53d2f6255f334b7c8ead4f56b6aef5af3402c5e4d11180afd38c6b85fb1;
            return e;
        }
        if (index == 12) {
            e.symbol = "USO";
            e.token = address(bytes20(hex"a30fa36db767ad9ed3f7a60fc79526fb4d56d344"));
            e.feed = address(bytes20(hex"75a9c76ef439e2c7c2e5a34ab105ecfe3766431c"));
            e.key = _key(e.token, 1200, 15, address(0));
            e.poolId = 0x1f2ad5a274a776d8e1408292bde1d92d8fa7b6444acf14ad60b9c3e4e5b66420;
            return e;
        }
        if (index == 13) {
            e.symbol = "META";
            e.token = address(bytes20(hex"c0d6457c16cc70d6790dd43521c899c87ce02f35"));
            e.feed = address(bytes20(hex"7c38c00c30bee9378381e7b6135d7283356d71b1"));
            e.key = _key(e.token, 3000, 60, address(0));
            e.poolId = 0x5875d407a42965b0e768c8925cea290e06fa50603ef34fc99eb92a1050e6ae36;
            return e;
        }
        if (index == 14) {
            e.symbol = "AMZN";
            e.token = address(bytes20(hex"12f190a9f9d7d37a250758b26824b97ce941bf54"));
            e.feed = address(bytes20(hex"d5a1508ced74c084ebf3cbe853e2c968fb2a651c"));
            e.key = _key(e.token, 2400, 24, address(0));
            e.poolId = 0xefc94885c96b02696b9b45de43eeeb8ac53c0199cab42b4daae4911b96fb8825;
            return e;
        }
        if (index == 15) {
            e.symbol = "GOOGL";
            e.token = address(bytes20(hex"2e0847e8910a9732eb3fb1bb4b70a580adad4fe3"));
            e.feed = address(bytes20(hex"f6f373a037c30f0e5010d854385ca89185ae638b"));
            e.key = _key(e.token, 3000, 60, address(0));
            e.poolId = 0xd4ecb79fdc521d7725d22b33ed43cb4e47aa96bfad76aa29577e3151f723ac5e;
            return e;
        }
        if (index == 16) {
            e.symbol = "MSFT";
            e.token = address(bytes20(hex"e93237c50d904957cf27e7b1133b510c669c2e74"));
            e.feed = address(bytes20(hex"45c3c877c15e6ba2ebb19ea114ea508d14c1af2e"));
            e.key = _key(e.token, 3000, 60, address(0));
            e.poolId = 0x9194a557b6a6bb2236b49ea7e2bbccec5d3eeb705aef00903be4b3de1d949579;
            return e;
        }
        if (index == 17) {
            e.symbol = "AAPL";
            e.token = address(bytes20(hex"af3d76f1834a1d425780943c99ea8a608f8a93f9"));
            e.feed = address(bytes20(hex"6b22a786baa607d76728168703a39ea9c99f2cd0"));
            e.key = _key(e.token, 8388608, 10, address(bytes20(hex"70a9a88402989226847ec122043ce5e7ff462080")));
            e.poolId = 0xa2347ba69167e5602f74640ffbf737ee7cdd825e4726d3462564fc6533070147;
            return e;
        }
        if (index == 18) {
            e.symbol = "SPY";
            e.token = address(bytes20(hex"117cc2133c37b721f49de2a7a74833232b3b4c0c"));
            e.feed = address(bytes20(hex"319724394d3a0e3669269846abe664cd621f9f6a"));
            e.key = _key(e.token, 100, 1, address(0));
            e.poolId = 0xe1ae6a4c6ccc9f037389a8d50a4f577bde1a9fe01d85d88ecbbd39955ce53288;
            return e;
        }
        revert("asset index");
    }

    function _key(address token, uint24 fee, int24 spacing, address hooks)
        private pure returns (PoolKey memory)
    {
        return token < USDG
            ? PoolKey(token, USDG, fee, spacing, hooks)
            : PoolKey(USDG, token, fee, spacing, hooks);
    }
}
