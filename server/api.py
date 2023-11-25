from fastapi import FastAPI

from .database import Transaction, User

api = FastAPI()


@api.get("/")
async def root():
    return {"message": "API is up. Visit /docs for documentation."}


@api.post("/transactions")
async def get_transactions(user: User) -> list[Transaction]:
    return []
