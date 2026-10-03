const ids = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4,So1111111111111111111111111111111111111111";
const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`);
const d: any = await r.json();
console.log(JSON.stringify(d).slice(0, 500));
