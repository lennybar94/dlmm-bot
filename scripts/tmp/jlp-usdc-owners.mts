import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../../src/config.js";
const conn = new Connection(config.rpcUrl, "confirmed");
const sigs = ["2saS18tAgYit5JdTC8oFi19gSjHAPFk83yfPNJJvoBCji4TJJCY1p583FJ68PyS1fdMD2xyCfEFRLSXrGAcMAoFc","3juo8S8TUimDEbrfxNGZ2Uxr2E3pnD3nKJB5wobMypPd2udmUih9qaxbBupQMApiRmzJSUQxLw27mi14vav1XTfr"];
for (const sig of sigs) {
  const tx: any = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  for (const b of tx.meta.postTokenBalances) {
    if (b.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" && b.owner !== config.walletAddress && b.uiTokenAmount.uiAmount > 1) {
      console.log(sig.slice(0,8), "owner:", b.owner, "=", b.uiTokenAmount.uiAmount);
    }
  }
}
console.log("wallet:", config.walletAddress);
