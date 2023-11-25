from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel, create_engine


class User(SQLModel, table=True):
    username: str = Field(primary_key=True)
    public_key: str


class Transaction(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner: Optional[str] = Field(default=None, foreign_key="user.username")
    date: datetime
    encrypted: str


engine = create_engine("sqlite:///database.db")

SQLModel.metadata.create_all(engine)
