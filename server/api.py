from fastapi import FastAPI, HTTPException
from sqlmodel import Session, select

from .database import Transaction, User, engine

api = FastAPI()


@api.get("/")
async def root():
    return {"message": "API is up. Visit /docs for documentation."}


@api.post("/user")
async def create_user(user: User):
    user.username = user.username.lower()
    try:
        with Session(engine) as session:
            session.add(user)
            session.commit()
    except:
        raise HTTPException(status_code=400, detail="SQL Error")
    return {}


@api.post("/transactions")
async def get_transactions(user: User) -> list[Transaction]:
    with Session(engine) as session:
        user_stmt = select(User).where(User.username == user.username)
        retrieved_user = session.exec(user_stmt).first()

        print(user, retrieved_user)
        if user != retrieved_user:
            raise HTTPException(status_code=403, detail="User does not exist")

        stmt = select(Transaction).where(Transaction.owner == user.username)
        results = session.exec(stmt)
        return [transaction for transaction in results]


@api.post("/transaction")
async def update_transaction(updated_transaction: Transaction):
    with Session(engine) as session:
        stmt = select(Transaction).where(Transaction.id == updated_transaction.id)
        transaction = session.exec(stmt).first()

        if not transaction:
            raise HTTPException(status_code=404, detail="Transaction not found")

        if transaction.owner != updated_transaction.owner:
            raise HTTPException(
                status_code=403, detail="Unauthorized to update this transaction"
            )

        for key, value in updated_transaction.dict().items():
            setattr(transaction, key, value)

        session.add(transaction)
        session.commit()
        session.refresh(transaction)

        return transaction
