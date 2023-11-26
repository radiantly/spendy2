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
