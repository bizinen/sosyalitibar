import crypto from "node:crypto";

const password = process.argv[2];
if (!password || password.length < 12) {
  console.error("Kullanım: npm run auth:hash -- 'en-az-12-karakter-sifre'");
  process.exit(1);
}
const salt = crypto.randomBytes(16);
const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
console.log(`scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`);
