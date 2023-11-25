from email.parser import BytesParser
from email.policy import default


class EmailHandler:
    async def handle_DATA(self, server, session, envelope):
        print("Mail received!\n")

        # Parse the email content
        parser = BytesParser(policy=default)
        msg = parser.parsebytes(envelope.content)

        print(f"From: {envelope.mail_from}")
        print(f"To: {envelope.rcpt_tos}")

        # Extract subject
        subject = msg["Subject"]
        print(f"Subject: {subject}")

        # Extract and print plaintext content
        if msg.is_multipart():
            for part in msg.walk():
                # Each part is either a text or an attachment or other type
                if part.get_content_type() == "text/plain":
                    print(
                        f'Plain text body: {part.get_payload(decode=True).decode("utf-8")}'
                    )
        else:
            # For non-multipart emails, just print the payload
            print(f'Plain text body: {msg.get_payload(decode=True).decode("utf-8")}')

        return "250 Message accepted for delivery"
