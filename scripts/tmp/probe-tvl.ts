import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const SOLb58 = "So11111111111111111111111111111111111111112";
  const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const accs = await conn.getProgramAccounts(DLMM, {
    encoding: "base64", dataSlice: { offset: 0, length: 480 },
    filters: [
      { memcmp: { offset: 88, bytes: SOLb58 } },
      { memcmp: { offset: 120, bytes: USDCb58 } },
    ],
  });
  const rows = [];
  for (const a of accs) {
    const buf = Buffer.from(a.account.data, "base64");
    // token_vault_x at 472? reference layout: ... token_mint_y(120-152), vault_x(152), vault_y(184)... check offsets from reference struct order after mints
    rows.push({ addr: a.pubkey.toBase58(), binStep: buf.readUInt16LE(408), vaultXOff: null });
  }
  // find vault offsets by reading one known pool fully
  const ref = await conn.getAccountInfo(new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"));
  const rb = ref!.data;
  // fetch token accounts referenced right after mint_y (offsets 152,184)
  for (const off of [152, 184]) {
    try {
      const pk = new PublicKey(rb.subarray(off, off + 32));
      const acc = await conn.getParsedAccountInfo(pk);
      console.log("off", off, pk.toString(), "->", JSON.stringify((acc.value as any)?.data?.parsed?.info?.tokenAmount ?? (acc.value as any)?.data?.parsed?.info ?? {}).slice?.(0, 120) ?? "n/a");
    } catch (e) { console.log("off", off, "ERR", String(e).slice(0, 60)); }
  }
})();
