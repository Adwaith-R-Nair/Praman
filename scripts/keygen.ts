import { generateKeypair } from "@praman/mandate";

const { privateKeyPem, publicKeyPem } = generateKeypair();

console.log("Ed25519 keypair generated. Add these two lines to .env:\n");
console.log(`MANDATE_PRIVATE_KEY=${Buffer.from(privateKeyPem, "utf8").toString("base64")}`);
console.log(`MANDATE_PUBLIC_KEY=${Buffer.from(publicKeyPem, "utf8").toString("base64")}`);
console.log("\n(PEM, base64-encoded so it fits on one .env line. Never commit .env.)");
