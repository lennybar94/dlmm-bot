import { Connection } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
for (const sig of ["2saS18tAgYit5JdTC8oFi19gSjHAPFk83yfPNJJvoBCji4TJJCY1p583FJ68PyS1fdMD2xyCfEFRLSXrGAcMAoFc"]) {
  const tx: any = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  console.log("err:", JSON.stringify(tx.meta.err));
  for (const b of tx.meta.preTokenBalances) {
    if (b.mint === "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4") console.log("X pre:", b.owner.slice(0,14), b.uiTokenAmount.uiAmountString);
  }
  for (const b of tx.meta.postTokenBalances) {
    if (b.mint === "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4") console.log("X post:", b.owner.slice(0,14), b.uiTokenAmount.uiAmountString);
  }
}
