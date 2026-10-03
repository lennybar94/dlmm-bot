import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
for (const m of ["27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJ4Dai","27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"]) {
  try {
    const info: any = await conn.getParsedAccountInfo(new PublicKey(m));
    console.log(m, "->", info.value?.data?.parsed?.info?.decimals ?? JSON.stringify(info.value?.data?.parsed?.type));
  } catch (e) { console.log(m, "ERR", String(e).slice(0,80)); }
}
