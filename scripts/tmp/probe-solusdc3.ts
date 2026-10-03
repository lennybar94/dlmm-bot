import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PublicKey, Connection } = require("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const SOL = "So11111111111111111111111111111111111111112";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  // lb_pair discriminator = first 8 bytes of sha256("account:lb_pair") -> known to be 8 zero bytes? Actually Meteora uses [0u8;8]? Verify via candidate pool account data.
  const ref = await conn.getAccountInfo(new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"));
  const disc = ref!.data.subarray(0, 8).toString("hex");
  console.log("discriminator:", disc);
  const accs = await conn.getProgramAccounts(DLMM, {
    encoding: "base64",
    dataSlice: { offset: 8, length: 64 }, // token_x_mint (32) + padding? then token_y
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from(disc, "hex").toString("base64") } },
      { memcmp: { offset: 8, bytes: SOL } },
      { memcmp: { offset: 8 + 32 + 1, bytes: USDC } },
    ],
  });
  for (const a of accs) {
    const buf = Buffer.from(a.account.data, "base64");
    const binStep = buf.readUInt16LE(64);
    console.log(a.pubkey.toBase58(), "binStep:", binStep);
  }
})();
