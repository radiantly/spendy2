import base64
import os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def encrypt_message(public_key: str, message: str) -> str:
    # Load the RSA public key
    public_key = serialization.load_der_public_key(base64.b64decode(public_key))

    # Generate a random AES key
    aes_key = AESGCM.generate_key(bit_length=256)
    aes_gcm = AESGCM(aes_key)

    # Encrypt the message with AES GCM
    iv = os.urandom(12)  # 96 bits for GCM
    encrypted_message = aes_gcm.encrypt(iv, message.encode(), None)

    # Encrypt the AES key with RSA public key
    encrypted_aes_key = public_key.encrypt(
        aes_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )

    # Return the encrypted message and the encrypted AES key
    return base64.b64encode(encrypted_aes_key + iv + encrypted_message)
