from fastapi import FastAPI, HTTPException
from sqlmodel import Session

from .database import Transaction, User, engine

api = FastAPI()


@api.get("/")
async def root():
    return {"message": "API is up. Visit /docs for documentation."}


@api.post("/user")
async def create_user(user: User):
    try:
        with Session(engine) as session:
            session.add(user)
            session.commit()
    except:
        raise HTTPException(status_code=400, detail="SQL Error")
    return {}


@api.post("/transactions")
async def get_transactions(user: User) -> list[Transaction]:
    return []
