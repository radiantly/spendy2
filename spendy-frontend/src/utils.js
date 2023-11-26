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

export const postJSON = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).then((r) => r.json());
