const crypto = require("crypto");
const { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);
async function hashPassword(password) {
 const salt = crypto.randomBytes(16).toString("hex");
 const key = await scrypt(password, salt, 64);
 return { salt, hash: Buffer.from(key).toString("hex") };
}
async function verifyPassword(password, salt, hash) {
 const key = Buffer.from(await scrypt(password, salt, 64));
 const expected = Buffer.from(hash, "hex");
 return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
module.exports = { hashPassword, verifyPassword };
