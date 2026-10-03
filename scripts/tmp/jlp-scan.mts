import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
for (const m of ["27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJ4Dai","27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"]) {
  const r: any = await conn.getAccountInfo(new PublicKey(m));
  console.log(m, r ? `owner=${r.owner.toBase58()} len=${r.data.length}` : "NOT FOUND");
}
// supply JLP real
const { getMint } = await import("@solana/spl-token");
try { const mi = await getMint(conn, new PublicKey("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJ4Dai")); console.log("real JLP mint decimals:", mi.decimals, "supply:", mi.supply.toString()); } catch(e){ console.log("real JLP mint ERR"); }
