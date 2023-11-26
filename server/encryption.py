from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import hashes
import base64


def encrypt_transaction(public_key_str, message):

    # Load the public key
    public_key = serialization.load_pem_public_key(
        public_key_str.encode(),
        backend=default_backend()
    )


    # Encrypt the message
    encrypted = public_key.encrypt(
        message.encode(),
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )

    # Encode the encrypted message in base64 to make it ASCII text
    encoded_encrypted_message = base64.b64encode(encrypted)
    return encoded_encrypted_message.decode()
