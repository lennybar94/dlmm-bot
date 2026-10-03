import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const acc = await conn.getAccountInfo(new PublicKey("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf"));
if (!acc) { console.log("pool introuvable"); process.exit(0); }
const d = acc.data;
// LbPair layout anchor: discriminator 8, then params... active_id at offset depends on version.
// On lit u128 active_id et i32 active_price via heuristique : chercher le pattern connu du SDK (offset fixe pour v2).
// Plus simple : lire les champs standard — tokenMints offsets 8..? Utilisons @coral-xyz/anchor Idl? Trop lourd.
// Heuristique DLMM: activeId (i32) offset 417? On print bytes around common offsets.
const readI64 = (off: number) => Number(d.readBigInt64LE(off));
console.log("len:", d.length);
// current_active_bid_price est stocké en u128 price à l'offset 'active_id' pair.
// On utilise la structure connue: pair has `parameters` at 8+32*2+8*2..., trop risqué.
// À la place : compter bins autour de zero n'est pas trivial ici. On s'arrête au diagnostic SDK.
