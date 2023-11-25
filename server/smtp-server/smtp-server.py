import smtpd
import asyncore
from email.parser import Parser


class SimpleSMTPServer(smtpd.SMTPServer):
    def process_message(self, peer, mailfrom, rcpttos, data, **kwargs):
        print("Receiving message from:", peer)
        print("From:", mailfrom)
        print("To:", rcpttos)

        # Decode data from bytes to string
        data_str = data.decode("utf-8")

        # Parse the email content
        message = Parser().parsestr(data_str)

        # Extract the subject
        subject = message.get("Subject")
        print("Subject:", subject)

        # Extract and print only the plaintext content
        if message.is_multipart():
            for part in message.walk():
                content_type = part.get_content_type()
                content_disposition = part.get("Content-Disposition")
                if content_type == "text/plain" and not content_disposition:
                    print(part.get_payload(decode=True).decode())
        else:
            print(message.get_payload(decode=True).decode())

        return "250 Ok"


server = SimpleSMTPServer(("0.0.0.0", 25), None)

asyncore.loop()
