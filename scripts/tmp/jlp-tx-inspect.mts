import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../../src/config.js";
const conn = new Connection(config.rpcUrl, "confirmed");
for (const sig of ["2saS18tAgYit5JdTC8oFi19gSjHAPFk83yfPNJJvoBCji4TJJCY1p583FJ68PyS1fdMD2xyCfEFRLSXrGAcMAoFc","3juo8S8TUimDEbrfxNGZ2Uxr2E3pnD3nKJB5wobMypPd2udmUih9qaxbBupQMApiRmzJSUQxLw27mi14vav1XTfr"]) {
  const tx: any = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (!tx) { console.log(sig.slice(0,10), "introuvable"); continue; }
  const meta = tx.meta;
  const owner = config.walletAddress;
  for (let i = 0; i < meta.preTokenBalances.length; i++) {
    const pre = meta.preTokenBalances[i], post = meta.postTokenBalances.find((b: any) => b.accountIndex === pre.accountIndex);
    if (pre.owner === owner || post?.owner === owner) {
      const dRaw = (post?.uiTokenAmount.uiAmount ?? 0) - (pre.uiTokenAmount.uiAmount ?? 0);
      if (Math.abs(dRaw) > 1e-9) console.log(sig.slice(0,8), pre.mint.slice(0,12), `${pre.uiTokenAmount.uiAmount} → ${post?.uiTokenAmount.uiAmount}`, `Δ=${dRaw.toFixed(4)}`);
    }
  }
  // SOL delta
  console.log(sig.slice(0,8), "SOL Δ:", ((meta.postBalances[0] - meta.preBalances[0]) / 1e9).toFixed(4));
}
