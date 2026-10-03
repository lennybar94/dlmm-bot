import { Connection } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
for (const [tag, sig] of [["achat 2saS (52.36 JLP)", "2saS18tAgYit5JdTC8oFi19gSjHAPFk83yfPNJJvoBCji4TJJCY1p583FJ68PyS1fdMD2xyCfEFRLSXrGAcMAoFc"], ["stake 3LHZ (PEPE)", "3LHZhq3r8ARTLw5AfKsSZHMZvyULjKmx7eepUt74etiHSpew4M1F8ZPqR3sB9xy6KJaYSWwDVL4GeGVR8qJyEwHd"]]) {
  const tx: any = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (!tx) { console.log(tag, "introuvable"); continue; }
  const ixs = tx.transaction.message.instructions.map((i: any) => i.programId?.toBase58?.() ?? "?");
  const inner = (tx.meta.innerInstructions ?? []).map((c: any) => c.instructions?.[0]?.programId?.toBase58?.() ?? "?");
  const hasMeteoraDynamic = ixs.some(x => x === "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo") || inner.some(x => x === "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  console.log(tag, "| top:", [...new Set(ixs)].join(",").slice(0,120), "| DLMM présent:", hasMeteoraDynamic);
}
