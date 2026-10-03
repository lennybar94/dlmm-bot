import { Connection } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const res = await conn.getSignaturesForAddress(new (await import("@solana/web3.js")).PublicKey("DKix9ZpZqDBJMPBrMSUwWBBY6AuEFcTYw5J7vCNe1pL7"), { limit: 5 });
for (const s of res) console.log(s.signature.slice(0,20), s.blockTime, s.err ? "ERR" : "ok");
