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

export const encryptText = (publicKey, text) => {
  const encoded = forge.util.encodeUtf8(text);
  const encrypted = publicKey.encrypt(encoded, "RSA-OAEP", {
    md: forge.md.sha256.create(),
  });
  return forge.util.encode64(encrypted);
};

export function debounce(func, wait) {
  let timeout;

  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };

    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

export const postJSON = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const nth = (num) => ["th", "st", "nd", "rd"][num % 10 <= 3 ? num % 10 : 0];

const DAY = 24 * 60 * 60 * 1000;

export const toNiceDateString = (then) => {
  const now = Date.now();

  if (now - then < DAY) return "Today";
  if (now - then < DAY * 2) return "Yesterday";

  const date = then.getDate();
  const month = then.toLocaleString("default", { month: "short" });
  const year = then.getFullYear() % 100;
  return (
    <>
      {date}
      <span className="nth">{nth(date)}</span>&nbsp;{month}, {year}
    </>
  );
};
