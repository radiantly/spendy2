from typing import Annotated

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
    WebSocketException,
    status,
)
from sqlmodel import Session, select

from .database import Transaction, User, engine, get_existing_user
from .oauth2 import Token, get_current_user, login_user
from .websocket_manager import websocket_manager

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


@api.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    authenticated_user = None
    try:
        jwt_token = await websocket.receive_text()
        authenticated_user = await get_current_user(jwt_token)
        websocket_manager.add(authenticated_user.username, websocket)

        # Keep connection open
        await websocket.receive_text()

    # raised when token cannot be authenticated
    except HTTPException:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    except WebSocketDisconnect:
        if authenticated_user:
            websocket_manager.remove(authenticated_user.username, websocket)


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


@api.delete("/transaction/{transaction_id}")
async def update_transaction(
    current_user: Annotated[User, Depends(get_current_user)],
    transaction_id: int,
):
    with Session(engine) as session:
        stmt = select(Transaction).where(
            Transaction.id == transaction_id
            and Transaction.owner == current_user.username
        )
        transaction = session.exec(stmt).first()

        if not transaction:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found"
            )

        session.delete(transaction)
        session.commit()
