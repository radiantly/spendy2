import json
import re
from datetime import datetime

from openai import OpenAI
from sqlmodel import Session, select

from .config import MAX_RETRIES, OPENAI_API_KEY
from .database import Transaction, User, engine
from .encryption import encrypt_message

client = OpenAI(api_key=OPENAI_API_KEY)


def sanitize_email_text(email_text: str):
    return re.sub(r"[\n\r\t ]+", " ", email_text).strip()


def build_prompt(email_body: str):
    return (
        """### Instruction:

You are given email text from a bank. Your job is to identify whether the email is a transactional mail or not. If it is transactional, extract the amount credited/debited, and who it was sent or received from. Finally, label the transaction. For example, transactions that include zomato or swiggy can be labeled as "food", while zepto or blinkit can be labeled as "grocery". Amazon and Flipkart can be labeled as "shopping".

### Email:

Dear Card Member, Thank you for using your HDFC Bank Credit Card ending 4952 for Rs 338.00 at SWIGGY on 29-10-2023 13:06:57. Authorization code:- 034992 After the above transaction, the available balance on your card is Rs 48556.00 and the total outstanding is Rs 1444.00. For more details on this transaction please visit HDFC Bank MyCards. If you have not done this transaction, please immediately call on 18002586161 to report this transaction. Explore HDFC Bank MyCards: your one stop platform to manage Credit Card ON THE GO. One view access to Card summary, transactions, reward points, e statement and much more. Save it on your phone now: Visit mycards.hdfcbank.com Regards HDFC Bank (This is a system generated mail and should not be replied to)

### Response:

{
    "transaction": true,
    "type": "Credit Card",
    "amount": 338.00,
    "party": "SWIGGY",
    "currency": "INR",
    "labels": ["food"]
}

### Email:

Dear Customer, Rs.329.00 has been debited from account **2981 to VPA jason13201-1@okaxis on 27-10-23. Your UPI transaction reference number is 330013363459. Please call on 18002586161 to report if this transaction was not authorized by you. Warm Regards, HDFC Bank 

### Response:

{
    "transaction": true,
    "type": "UPI",
    "amount": 329.00,
    "party": "jason13201-1@okaxis",
    "currency": "INR",
    "labels": []
}

### Email:

Dear Customer, Looking for more time to pay your Credit Card Bill? Convert your bill into SmartEMI, payable over 6 to 24 months. There're easy repayment options and flexible tenure. Convert now! Regards, HDFC Bank. Terms and conditions apply.

### Response:

{
    "transaction": false
}

### Email:

"""
        + sanitize_email_text(email_body)
        + """
### Response:

"""
    )


def send_gpt_request(prompt: str):
    response = client.chat.completions.create(
        model="gpt-3.5-turbo",
        messages=[
            {"role": "system", "content": "You are a financial assistant."},
            {"role": "user", "content": prompt},
        ],
    )

    # Extract the extracted currency value from the model's response
    return response.choices[0].message.content


def is_valid_transaction(transaction: dict):
    if "transaction" not in transaction:
        return False

    if transaction["transaction"] == False:
        return True

    if (
        transaction["transaction"] == True
        and "type" in transaction
        and "amount" in transaction
        and "party" in transaction
        and "currency" in transaction
    ):
        return True

    return False


def extract_transaction(email_body: str) -> dict | None:
    prompt = build_prompt(email_body)

    retries = 0

    while retries <= MAX_RETRIES:
        retries += 1
        try:
            response = send_gpt_request(prompt)
            print("chatgpt response:", response)
            transaction = json.loads(response)
            if is_valid_transaction(transaction):
                return transaction
        except:
            pass


async def process_mail(mail: dict):
    target_username = mail["to"][0].split("@")[0].lower()

    with Session(engine) as session:
        statement = select(User.public_key).where(User.username == target_username)
        results = session.exec(statement)
        user_public_key = results.first()

        if not user_public_key:
            print(f"User {target_username} not found.")
            return

        # last_email[target_username] = encrypt_message(user_public_key, json.dumps(mail))

        details = extract_transaction(mail["body"])
        if "transaction" in details and details["transaction"]:
            encrypted_transaction = encrypt_message(
                user_public_key, json.dumps(details)
            )
            print("Encrypted transaction", encrypted_transaction)
            transaction = Transaction(
                owner=target_username,
                date=datetime.now(),
                encrypted=encrypted_transaction,
            )
            session.add(transaction)
            session.commit()


# Example
if __name__ == "__main__":
    example_email = """Dear Customer,

Your ICICI Bank Credit Card XX2009 has been used for a transaction of USD 5.00 on Nov 25, 2023 at 04:13:56. Info: OPENAI.

The Available Credit Limit on your card is INR 49,582.79 and Total Credit Limit is INR 50,000.00.
The above limits are a total of the limits of all the Credit Cards issued to the primary card holder, including any supplementary cards.

In case you have not done this transaction, to report it please call on 18002662 or SMS BLOCK space 2009 to 9215676766 from your registered mobile number and if you are outside India, call on 04071403333.

In case you require any further information, you may call our Customer Care or write to us at customer.care@icicibank.com

Contact your RM @ Express Relationship Banking 022-44400000.


Never share your OTP, URN, CVV or passwords with anyone even if the person claims to be a bank employee.

Sincerely,

Team ICICI Bank
This is an auto-generated e-mail. Please do not reply.

Discover a new way of paying your Credit Card bills from your bank account anytime anywhere by using ICICI Bank iMobile Pay. GPRS users, SMS iMobile Pay to 56767661. For details, please click here.


Now banking is more convenient with:

    More than 5000
Branches        24x7 ATM Services        Customer Care        Internet Banking        iMobile Banking

Disclaimer

"""

    result = extract_transaction(example_email)

    print("Transaction:", result)
