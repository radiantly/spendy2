import forge from "node-forge";

export const generateKeyPair = (passphrase) => {
  console.time("keygen");
  const md = forge.md.sha256.create();
  md.update(passphrase);
  const seed = md.digest().toHex();

  const prng = forge.random.createInstance();
  prng.seedFileSync = () => seed;

  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048, prng });
  console.timeEnd("keygen");
  return keypair;
};

export const toPem = ({ publicKey, privateKey }) => {
  return {
    publicKey: forge.pki.publicKeyToPem(publicKey),
    privateKey: forge.pki.privateKeyToPem(privateKey),
  };
};

export const fromPem = ({ publicKey, privateKey }) => {
  return {
    publicKey: forge.pki.publicKeyFromPem(publicKey),
    privateKey: forge.pki.privateKeyFromPem(privateKey),
  };
};

export const decryptText = (privateKey, text) => {
  const decoded = forge.util.decode64(text);
  const decrypted = privateKey.decrypt(decoded, "RSA-OAEP", {
    md: forge.md.sha256.create(),
  });
  return decrypted;
};

export const postJSON = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
