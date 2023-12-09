import os
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlmodel import Session, select

from .database import User, engine

ALGORITHM = "HS256"
SECRET_KEY = os.urandom(32)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


class Token(BaseModel):
    access_token: str
    token_type: str


async def get_current_user(token: Annotated[str, Depends(oauth2_scheme)]):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return User(**payload)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def login_user(form_data: Annotated[OAuth2PasswordRequestForm, Depends()]):
    user = User(username=form_data.username, public_key=form_data.password)

    with Session(engine) as session:
        user_stmt = select(User).where(User.username == user.username)
        retrieved_user = session.exec(user_stmt).first()
        user.validate
        if user != retrieved_user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect credentials.",
                headers={"WWW-Authenticate": "Bearer"},
            )

    access_token = jwt.encode(user.dict(), SECRET_KEY, algorithm=ALGORITHM)
    return Token(access_token=access_token, token_type="bearer")
