from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, status
from sqlmodel import Session, select

from .database import Transaction, User, engine, get_existing_user
from .oauth2 import Token, get_current_user, login_user

api = FastAPI()


@api.get("/")
async def root():
    return {"message": "API is up. Visit /docs for documentation."}


@api.post("/token", response_model=Token)
async def login_for_access_token(token: Annotated[Token, Depends(login_user)]):
    return token


@api.post("/user")
async def create_user(user: User):
    user.username = user.username.lower()

    if get_existing_user(user):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Username {user.username} is already in use. Please choose another.",
        )

    try:
        with Session(engine) as session:
            session.add(user)
            session.commit()
            session.refresh(user)
        return user
    except:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="SQL Error"
        )


# Protected routes
@api.post("/transactions")
async def get_transactions(
    current_user: Annotated[User, Depends(get_current_user)]
) -> list[Transaction]:
    with Session(engine) as session:
        stmt = select(Transaction).where(Transaction.owner == current_user.username)
        results = session.exec(stmt)
        return [transaction for transaction in results]


@api.post("/transaction")
async def update_transaction(
    current_user: Annotated[User, Depends(get_current_user)],
    updated_transaction: Transaction,
):
    with Session(engine) as session:
        stmt = select(Transaction).where(
            Transaction.id == updated_transaction.id
            and Transaction.owner == current_user.username
        )
        transaction = session.exec(stmt).first()

        if not transaction:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found"
            )

        transaction.date = updated_transaction.date
        transaction.encrypted = updated_transaction.encrypted

        session.add(transaction)
        session.commit()
        session.refresh(transaction)

        return transaction
