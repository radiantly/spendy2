import forge from "node-forge";
import { useEffect } from "react";

// from https://developer.mozilla.org/en-US/docs/Glossary/Base64
function base64ToBytes(base64) {
  const binString = atob(base64);
  return Uint8Array.from(binString, (m) => m.codePointAt(0));
}

function bytesToBase64(bytes) {
  const binString = String.fromCodePoint(...bytes);
  return btoa(binString);
}

/*
Convert a string into an ArrayBuffer
from https://developers.google.com/web/updates/2012/06/How-to-convert-ArrayBuffer-to-and-from-String
*/
function str2ab(str) {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

export class Keypair {
  #privateKey;
  #publicKey;
  #publicKeySpki;
  #privateKeyPkcs8;
  constructor({ publicKey, privateKey, publicKeySpki, privateKeyPkcs8 }) {
    if (!publicKey || !privateKey || !publicKeySpki || !privateKeyPkcs8)
      throw new Error(
        "Please pass in all required parameters to the constructor."
      );

    this.#privateKey = privateKey;
    this.#publicKey = publicKey;

    this.#publicKeySpki = publicKeySpki;
    this.#privateKeyPkcs8 = privateKeyPkcs8;
  }

  get publicKey() {
    return this.#publicKeySpki;
  }

  static rsaHashedImportParams = {
    name: "RSA-OAEP",
    hash: "SHA-256",
  };

  async encrypt(message) {
    // Step 1: Generate an AES key
    const aesKey = await crypto.subtle.generateKey(
      {
        name: "AES-GCM",
        length: 256,
      },
      true,
      ["encrypt"]
    );

    // Step 2: Encrypt the message
    const iv = crypto.getRandomValues(new Uint8Array(12)); // IV for AES-GCM
    const messageBuf = new TextEncoder().encode(message);
    const encryptedMessage = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      aesKey,
      messageBuf
    );

    // Step 3: Export and encrypt the AES key
    const aesKeyBuf = await crypto.subtle.exportKey("raw", aesKey);
    const aesKeyEncrypted = await crypto.subtle.encrypt(
      {
        name: "RSA-OAEP",
      },
      this.#publicKey,
      aesKeyBuf
    );

    // Step 4: Combine the encrypted AES key, IV, and the encrypted message
    const encrypted = new Uint8Array(
      aesKeyEncrypted.byteLength + iv.byteLength + encryptedMessage.byteLength
    );
    encrypted.set(new Uint8Array(aesKeyEncrypted), 0);
    encrypted.set(iv, aesKeyEncrypted.byteLength);
    encrypted.set(
      new Uint8Array(encryptedMessage),
      aesKeyEncrypted.byteLength + iv.byteLength
    );

    // Step 5: Base64 encode the result
    return bytesToBase64(encrypted);
  }

  async decrypt(encrypted) {
    const decoded = base64ToBytes(encrypted);

    const aesKeyEncrypted = decoded.subarray(0, 256);
    const iv = decoded.subarray(256, 256 + 12);
    const encryptedMessage = decoded.subarray(256 + 12);

    const aesKeyBuf = await crypto.subtle.decrypt(
      {
        name: "RSA-OAEP",
      },
      this.#privateKey,
      aesKeyEncrypted
    );

    const aesKey = await crypto.subtle.importKey(
      "raw",
      aesKeyBuf,
      "AES-GCM",
      false,
      ["decrypt"]
    );

    const messageBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      aesKey,
      encryptedMessage
    );
    const message = new TextDecoder().decode(messageBuf);
    console.log(message);
    window.mess = message;
    return message;
  }

  static async create({ publicKey, privateKey }) {
    const publicKeySpki = bytesToBase64(
      new Uint8Array(await crypto.subtle.exportKey("spki", publicKey))
    );
    const privateKeyPkcs8 = bytesToBase64(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey))
    );

    return new Keypair({
      publicKey,
      privateKey,
      publicKeySpki,
      privateKeyPkcs8,
    });
  }

  toJSON() {
    return {
      publicKeySpki: this.#publicKeySpki,
      privateKeyPkcs8: this.#privateKeyPkcs8,
    };
  }

  static async fromJSON({ publicKeySpki, privateKeyPkcs8 }) {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      base64ToBytes(publicKeySpki),
      Keypair.rsaHashedImportParams,
      true,
      ["encrypt"]
    );

    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      base64ToBytes(privateKeyPkcs8),
      Keypair.rsaHashedImportParams,
      true,
      ["decrypt"]
    );

    return new Keypair({
      publicKey,
      privateKey,
      publicKeySpki,
      privateKeyPkcs8,
    });
  }

  static async fromForgeKeypair(keypair) {
    const rsaPublicKey = forge.pki.publicKeyToAsn1(keypair.publicKey);
    console.log(
      forge.asn1.toDer(rsaPublicKey).getBytes(),
      str2ab(forge.asn1.toDer(rsaPublicKey).getBytes())
    );
    const publicKeyData = str2ab(forge.asn1.toDer(rsaPublicKey).getBytes());

    const rsaPrivateKey = forge.pki.privateKeyToAsn1(keypair.privateKey);
    const privateKeyInfo = forge.pki.wrapRsaPrivateKey(rsaPrivateKey);
    const privateKeyData = str2ab(forge.asn1.toDer(privateKeyInfo).getBytes());

    console.log(publicKeyData, privateKeyData);

    const publicKey = await crypto.subtle.importKey(
      "spki",
      publicKeyData,
      Keypair.rsaHashedImportParams,
      true,
      ["encrypt"]
    );

    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyData,
      Keypair.rsaHashedImportParams,
      true,
      ["decrypt"]
    );

    console.log("imported both");
    return Keypair.create({ publicKey, privateKey });
  }

  static generate(passphrase) {
    const md = forge.md.sha256.create();
    md.update(passphrase);
    const seed = md.digest().toHex();

    const prng = forge.random.createInstance();
    prng.seedFileSync = () => seed;

    const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048, prng });
    return Keypair.fromForgeKeypair(keypair);
  }
}

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

export class Session {
  #token;
  #headers;
  constructor(token) {
    this.#token = token;
    this.#headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.#token}`,
    };
  }

  post(url, body) {
    return fetch(url, {
      method: "POST",
      headers: this.#headers,
      body: JSON.stringify(body),
    });
  }

  delete(url) {
    return fetch(url, {
      method: "DELETE",
      headers: this.#headers,
    });
  }

  useWebSocket(path, onMessage) {
    useEffect(() => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const url = new URL(path, `${protocol}//${location.host}/`);
      const ws = new WebSocket(url);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("open", () => ws.send(this.#token));

      return () => ws.close();
    }, []);
  }

  toJSON() {
    return { token: this.#token };
  }

  static fromJSON({ token }) {
    return new Session(token);
  }
}

export class User {
  constructor(username, keypair, session) {
    this.username = username;
    this.keypair = keypair;
    this.session = session;
  }

  toJSON() {
    return {
      username: this.username,
      keypair: this.keypair,
      session: this.session,
    };
  }

  static async fromJSONString(text) {
    if (!text) return null;
    try {
      const obj = JSON.parse(text);
      const keypair = await Keypair.fromJSON(obj.keypair);
      const session = Session.fromJSON(obj.session);
      return new User(obj.username, keypair, session);
    } catch {
      return null;
    }
  }
}

const nth = (num) => ["th", "st", "nd", "rd"][num % 10 <= 3 ? num % 10 : 0];

// Return the number of days passed since the unix epoch
// Note: This implementation is a gross approximation
const getTotalDays = (date) =>
  date.getDate() - 1 + date.getMonth() * 31 + date.getFullYear() * 372;

export const toNiceDateString = (then) => {
  const now = new Date();

  const timeStr = then.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  if (getTotalDays(now) === getTotalDays(then)) return timeStr;
  if (getTotalDays(now) === getTotalDays(then) + 1) return "Yesterday";

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

export const parseAPITransaction = async (apiTransaction, keypair) => {
  const { id, date, encrypted } = apiTransaction;

  const transaction = {
    id,
    date: new Date(date),
    remarks: "",
    hidden: false,
    ...JSON.parse(await keypair.decrypt(encrypted)),
  };

  if (!transaction.remarks && transaction.labels)
    transaction.remarks = transaction.labels.join(" ");

  return transaction;
};
