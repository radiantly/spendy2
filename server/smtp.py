import asyncio
from email.parser import BytesParser
from email.policy import default

from .parse import process_mail


def parse_mail(envelope):
    mail = {}

    # Parse the email content
    parser = BytesParser(policy=default)
    msg = parser.parsebytes(envelope.content)

    mail["from"] = envelope.mail_from
    mail["to"] = envelope.rcpt_tos

    print("Received email:", mail["from"], " => ", mail["to"])

    # Extract subject
    mail["subject"] = msg["Subject"]
    # print("Subject:", mail["subject"])

    # Extract and print plaintext content
    if msg.is_multipart():
        for part in msg.walk():
            # Each part is either a text or an attachment or other type
            if part.get_content_type() == "text/plain":
                mail["body"] = part.get_payload(decode=True).decode(
                    "utf-8", errors="ignore"
                )
    else:
        # For non-multipart emails, just print the payload
        mail["body"] = msg.get_payload(decode=True).decode("utf-8", errors="ignore")

    # if "body" in mail:
    #     print(f"Plain text body:", mail["body"])

    return mail


class EmailHandler:
    async def handle_DATA(self, server, session, envelope):
        print("Mail received!\n")

        if mail := parse_mail(envelope):
            task = asyncio.create_task(process_mail(mail))
            task.add_done_callback(self.task_callback)

        return "250 Message accepted for delivery"

    def task_callback(self, task):
        try:
            task.result()  # This will re-raise any exception from process_mail
        except Exception as e:
            print(f"An error occurred in process_mail: {e}")
