export const CHAIN_ID = 4663 as const;

export const ADDRESSES = {
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  accessRegistry: "0xe10b6f6b275de231345c20d14ab812db62151b00",
  identityRegistry: "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
  multicall3: "0xca11bde05977b3631167028862be2a173976ca11",
} as const;

export interface FeedDefinition { symbol: string; proxy: `0x${string}`; token: `0x${string}`; }

export const FEEDS: readonly FeedDefinition[] = [
  {
    "symbol": "AAPL",
    "proxy": "0x6b22a786baa607d76728168703a39ea9c99f2cd0",
    "token": "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9"
  },
  {
    "symbol": "AMD",
    "proxy": "0x943a29e7ae51a4798823ca9eed2ed533b2a22c72",
    "token": "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc"
  },
  {
    "symbol": "AMZN",
    "proxy": "0xd5a1508ced74c084ebf3cbe853e2c968fb2a651c",
    "token": "0x12f190a9f9d7d37a250758b26824b97ce941bf54"
  },
  {
    "symbol": "ASML",
    "proxy": "0xb4106147e8cce40b7d46124090d373a71b70f87d",
    "token": "0x47f93d52cbec7c6d2cfc080e154002370a60daea"
  },
  {
    "symbol": "BABA",
    "proxy": "0x62cc8f9b5f56a33c9c8a60c8b92779f523c4e984",
    "token": "0xad25ac6c84d497db898fa1e8387bf6af3532a1c4"
  },
  {
    "symbol": "CLSK",
    "proxy": "0x810c12d3a554bc47fd39597fe3b3aac4941f50ef",
    "token": "0xcbb95bbf36099d34da091dc6fa6f49efa257cee3"
  },
  {
    "symbol": "COIN",
    "proxy": "0xa3a468a452940b7d6b69991207b508c609a98ef2",
    "token": "0x6330d8c3178a418788df01a47479c0ce7ccf450b"
  },
  {
    "symbol": "CRCL",
    "proxy": "0x6652edf64ba3731c4f2d3ce821a0fb1f1f6b482a",
    "token": "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5"
  },
  {
    "symbol": "CRWV",
    "proxy": "0xe1b3aabcafad1c94708dc1367dcff8aa4407487c",
    "token": "0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3"
  },
  {
    "symbol": "DELL",
    "proxy": "0x1c6c8cadbe02e19129c39ddb92281ce4c0bf206b",
    "token": "0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd"
  },
  {
    "symbol": "EWY",
    "proxy": "0xefdf54610b62a7753ec30bdc380847c12d32e1d1",
    "token": "0x7f0abef0c07280f82c6a08ead09ded6bae2c13fc"
  },
  {
    "symbol": "GME",
    "proxy": "0x27c71df6a64fb476468edf256cf72c038bab5b67",
    "token": "0x1b0e319c6a659f002271b69db8a7df2f911c153e"
  },
  {
    "symbol": "GOOGL",
    "proxy": "0xf6f373a037c30f0e5010d854385ca89185ae638b",
    "token": "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3"
  },
  {
    "symbol": "INTC",
    "proxy": "0x3f390c5c24628ac7c489515402235fead71d1913",
    "token": "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681"
  },
  {
    "symbol": "IONQ",
    "proxy": "0x22efec4919baf55f360e0edee4abeb26de4971eb",
    "token": "0x558378e000d634a36593e338ebacdd6207640efe"
  },
  {
    "symbol": "META",
    "proxy": "0x7c38c00c30bee9378381e7b6135d7283356d71b1",
    "token": "0xc0d6457c16cc70d6790dd43521c899c87ce02f35"
  },
  {
    "symbol": "MSFT",
    "proxy": "0x45c3c877c15e6ba2ebb19ea114ea508d14c1af2e",
    "token": "0xe93237c50d904957cf27e7b1133b510c669c2e74"
  },
  {
    "symbol": "MSTR",
    "proxy": "0x396118bdfb181e6240e74d243f266b061c0edc3d",
    "token": "0xec262a75e413fafd0df80480274532c79d42da09"
  },
  {
    "symbol": "MU",
    "proxy": "0x425eefdcf05ed6526c3ce61af99429a228a6d596",
    "token": "0xff080c8ce2e5feadaca0da81314ae59d232d4afd"
  },
  {
    "symbol": "NBIS",
    "proxy": "0xe1d87b116ba0fe898998f1d140339d1fa1e09705",
    "token": "0x9d9c6684f596f66a64c030b93a886d51fd4d7931"
  },
  {
    "symbol": "NVDA",
    "proxy": "0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15",
    "token": "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"
  },
  {
    "symbol": "ORCL",
    "proxy": "0x0e6a64a2b58a6693a531e6c555f3a5d042eea844",
    "token": "0xb0992820e760d836549ba69bc7598b4af75dee03"
  },
  {
    "symbol": "PLTR",
    "proxy": "0x820abedff239034956b7a9d2f0a331f9f075eb4c",
    "token": "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a"
  },
  {
    "symbol": "QQQ",
    "proxy": "0x80901d846d5d7b030f26b480776ee3b29374c2ae",
    "token": "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68"
  },
  {
    "symbol": "RGTI",
    "proxy": "0x2a045cf1c49c61c166c036d2f06fa2d2d984f765",
    "token": "0x284358abc07f9359f19f4b5b4ac91901be2597ba"
  },
  {
    "symbol": "RKLB",
    "proxy": "0x045477bf65aef6f4f2386ad0164579e48381cc74",
    "token": "0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2"
  },
  {
    "symbol": "SGOV",
    "proxy": "0xa0df4ee0fff975306345875e3548fcc519577a11",
    "token": "0x92fd66527192e3e61d4ddd13322aa222de86f9b5"
  },
  {
    "symbol": "SLV",
    "proxy": "0x209b73908e92ae021826ed79609845451ecba2ce",
    "token": "0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f"
  },
  {
    "symbol": "SNDK",
    "proxy": "0xfb133fa4b7b385802b693a293606682df47109a3",
    "token": "0xb90a19ff0af67f7779aff50a882a9cff42446400"
  },
  {
    "symbol": "SPCX",
    "proxy": "0xb265810950ba6c5c0ff821c9963014a56fd8bffb",
    "token": "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea"
  },
  {
    "symbol": "SPY",
    "proxy": "0x319724394d3a0e3669269846abe664cd621f9f6a",
    "token": "0x117cc2133c37b721f49de2a7a74833232b3b4c0c"
  },
  {
    "symbol": "TSLA",
    "proxy": "0x4a1166a659a55625345e9515b32adecea5547c38",
    "token": "0x322f0929c4625ed5bad873c95208d54e1c003b2d"
  },
  {
    "symbol": "TSM",
    "proxy": "0x874cf94aa8ec88fd9560094dd065f2fb3e41fc2f",
    "token": "0x58ffe4a942d3885baa22d7520691f611ef09e7aa"
  },
  {
    "symbol": "USAR",
    "proxy": "0xa994d3684e8400a6c8078226925779fdee682dd9",
    "token": "0xd917b029c761d264c6a312bbbcda868658ef86a6"
  },
  {
    "symbol": "USO",
    "proxy": "0x75a9c76ef439e2c7c2e5a34ab105ecfe3766431c",
    "token": "0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344"
  }
];

export const ANSWER_UPDATED_TOPIC = "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f" as const;
